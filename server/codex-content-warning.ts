import { textTokenExcerpt } from '../core/text-tokens.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CODEX_CONTENT_WARNING_THRESHOLD,
  CODEX_SEXUAL_CONTENT_BOUNDARY,
} from '../core/codex-content-warning.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { REQUEST_IMAGE_MAX_COUNT } from '../core/request-images.js';
import type {
  CodexContentPreflightResult,
  CodexContentWarningRole,
} from '../core/codex-content-warning.js';
import { workspaceModelRef, type ModelSnapshot } from '../core/product.js';
import type { Store } from './store.js';
import type { JevCredentialStore } from './jev-credentials.js';
import { executeJevJudgment, type JevHooks, type JevRequest } from './jev-judgment.js';
import { jevSettings } from './jev-settings.js';
import { HttpError, fields, record, text } from './request-validation.js';
import { promptWorkspace } from './prompt-workspace.js';

const RECENT_CONTEXT_TOKENS = 8000;
const PREFLIGHT_TIMEOUT_MS = 8_000;
type PreflightOwner = { store: Store; chatId: string; runId?: string; jobId?: string };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function isCodex(model: ModelSnapshot | undefined): boolean {
  return model?.connection.protocol === 'codex-app-server-v1';
}

export function codexContentWarningRequest(
  role: CodexContentWarningRole,
  content: string,
  recentContext = ''
): JevRequest {
  const boundary = CODEX_SEXUAL_CONTENT_BOUNDARY;
  if (role === 'selection-revision')
    return {
      state: { revisionInstruction: content, selectedPassage: recentContext },
      questions: {
        explicitSexualContent: {
          type: 'noul',
          instructions: `Would the requested edit require sexually explicit content in the resulting passage? ${boundary}`,
        },
      },
    };
  if (role === 'translation')
    return {
      state: { source: content },
      questions: {
        explicitSexualContent: {
          type: 'noul',
          instructions: `Would a faithful translation of the source passage need to reproduce sexually explicit content? ${boundary}`,
        },
      },
    };
  return {
    state: {
      request: content,
      ...(recentContext ? { recentContext } : {}),
    },
    questions: {
      explicitSexualContent: {
        type: 'noul',
        instructions: `Would fulfilling the request require sexually explicit output? Use the recent scene, when provided, to interpret a request to continue. ${boundary}`,
      },
    },
  };
}

async function judge(
  role: CodexContentWarningRole,
  content: string,
  recentContext: string,
  credential: JevCredentialStore['resolve'],
  signal: AbortSignal,
  conservative: boolean,
  settings: JevHooks['settings'] | undefined,
  owner: PreflightOwner
): Promise<CodexContentPreflightResult> {
  try {
    if (!credential()) return { warning: conservative };
    const request = codexContentWarningRequest(role, content, recentContext);
    const timeout = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
    const result = await executeJevJudgment(request, digest({ role, request }), null, {
      signal: AbortSignal.any([signal, timeout]),
      credential,
      settings,
      kind: 'codex-content-preflight',
      onAttemptStart: (wire) =>
        owner.store.product.startAttempt(
          owner.chatId,
          owner.runId ?? null,
          owner.jobId ?? null,
          { ...wire, role: role === 'selection-revision' ? 'helper' : role },
          { kind: 'judgment', retainContent: false }
        ),
      onAttemptFinish: (id, result) => owner.store.product.finishAttempt(id, result),
    });
    return { warning: result.scores.explicitSexualContent! >= CODEX_CONTENT_WARNING_THRESHOLD };
  } catch {
    // Interactive requests stay advisory; automatic Codex translation must await confirmation.
    return { warning: conservative };
  }
}

/** The automatic path has no user present to accept a Codex content warning. */
export async function autoTranslationNeedsConfirmation(
  model: ModelSnapshot | undefined,
  source: string,
  credential: JevCredentialStore['resolve'],
  signal: AbortSignal,
  settings: JevHooks['settings'] | undefined,
  owner: PreflightOwner
): Promise<boolean> {
  if (!isCodex(model)) return false;
  return (await judge('translation', source, '', credential, signal, true, settings, owner))
    .warning;
}

function currentContext(store: Store, chatId: string): string {
  const chat = store.chat(chatId);
  if (!chat.headRevision) return '';
  return textTokenExcerpt(store.source(chat.headRevision).text, RECENT_CONTEXT_TOKENS, {
    side: 'end',
  }).text;
}

function mainTarget(
  store: Store,
  chatId: string,
  retryRunId: unknown
): { model: ModelSnapshot | undefined; context: string } {
  if (retryRunId === undefined)
    return {
      model: store.product.snapshot(chatId, 'main').models.main,
      context: currentContext(store, chatId),
    };
  const id = text(retryRunId, 'run ID', 200);
  const run = store.run(id);
  if (run.chatId !== chatId) throw new HttpError(404, 'Run not found');
  return {
    // Retries intentionally use today's model selection, while their story context starts
    // from the original run's parent revision. Keep preflight aligned with that behavior.
    model: store.product.snapshot(chatId, 'main').models.main,
    context: run.parentRevision
      ? textTokenExcerpt(store.source(run.parentRevision).text, RECENT_CONTEXT_TOKENS, {
          side: 'end',
        }).text
      : '',
  };
}

export function codexContentWarningRoutes(
  app: FastifyInstance,
  store: Store,
  credentials: JevCredentialStore,
  signal: AbortSignal
) {
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/codex-content-preflight',
    { bodyLimit: 32 * 1024 * 1024 },
    async (request, reply): Promise<CodexContentPreflightResult> => {
      reply.header('Cache-Control', 'no-store');
      const body = record(request.body);
      fields(body, ['role', 'text', 'retryRunId', 'selection', 'imageCount']);
      const role = body.role;
      if (role !== 'main' && role !== 'translation' && role !== 'selection-revision')
        throw new HttpError(400, 'CODEX_CONTENT_PREFLIGHT_ROLE_INVALID');
      if (
        body.imageCount !== undefined &&
        (!Number.isSafeInteger(body.imageCount) ||
          body.imageCount < 1 ||
          body.imageCount > REQUEST_IMAGE_MAX_COUNT ||
          role !== 'main')
      )
        throw new HttpError(400, 'Invalid preflight image count');
      const content = text(
        body.text,
        'preflight text',
        REQUEST_TEXT_MAX_CHARS,
        role === 'main' && body.imageCount !== undefined
      );
      store.chat(request.params.id);
      if (role === 'selection-revision') {
        const selection = text(body.selection, 'selected passage', REQUEST_TEXT_MAX_CHARS);
        const selected = workspaceModelRef(promptWorkspace(store), 'helper');
        if (!selected || !isCodex(store.product.modelSnapshot(selected.id, 'helper')))
          return { warning: false };
        return judge(
          role,
          content,
          selection,
          credentials.resolve,
          signal,
          false,
          jevSettings(store.db),
          { store, chatId: request.params.id }
        );
      }
      const target =
        role === 'main'
          ? mainTarget(store, request.params.id, body.retryRunId)
          : {
              model: store.product.snapshot(request.params.id, 'translation').models.translation,
              context: '',
            };
      if (!isCodex(target.model)) return { warning: false };
      return judge(
        role,
        content,
        target.context,
        credentials.resolve,
        signal,
        false,
        jevSettings(store.db),
        { store, chatId: request.params.id }
      );
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/sources/:id/codex-content-preflight',
    async (request, reply): Promise<CodexContentPreflightResult> => {
      reply.header('Cache-Control', 'no-store');
      const body = record(request.body ?? {});
      fields(body, []);
      const source = store.source(request.params.id);
      const model = store.product.snapshot(source.chatId, 'translation').models.translation;
      if (!isCodex(model)) return { warning: false };
      return judge(
        'translation',
        source.text,
        '',
        credentials.resolve,
        signal,
        false,
        jevSettings(store.db),
        { store, chatId: source.chatId }
      );
    }
  );
}
