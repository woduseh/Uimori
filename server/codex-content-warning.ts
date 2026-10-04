import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  CODEX_CONTENT_WARNING_THRESHOLD,
  CODEX_SEXUAL_CONTENT_BOUNDARY,
} from '../core/codex-content-warning.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type {
  CodexContentPreflightResult,
  CodexContentWarningRole,
} from '../core/codex-content-warning.js';
import { workspaceModelRef, type ModelSnapshot } from '../core/product.js';
import type { Store } from './store.js';
import type { JevCredentialStore } from './jev-credentials.js';
import { executeJevJudgment, type JevRequest } from './jev-judgment.js';
import { HttpError, fields, record, text } from './request-validation.js';
import { promptWorkspace } from './prompt-workspace.js';

const RECENT_CONTEXT_CHARS = 16_000;
const PREFLIGHT_TIMEOUT_MS = 8_000;

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
          instructions: `Would revising only \`selectedPassage\` according to \`revisionInstruction\` require graphically sexual or pornographic output? The task is passage revision, not continuing the scene. ${boundary}`,
        },
      },
    };
  if (role === 'translation')
    return {
      state: { source: content },
      questions: {
        explicitSexualContent: {
          type: 'noul',
          instructions: `Would a faithful translation of \`source\` require reproducing graphically sexual or pornographic content, such as explicit sex acts, genital-focused sexual contact, penetration, masturbation, oral sex, or comparably detailed erotic description? ${boundary}`,
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
        instructions: `Would fulfilling \`request\` in the supplied \`recentContext\`, including an instruction to continue the current scene, require generating graphically sexual or pornographic content, such as explicit sex acts, genital-focused sexual contact, penetration, masturbation, oral sex, or comparably detailed erotic description? ${boundary}`,
      },
    },
  };
}

async function judge(
  role: CodexContentWarningRole,
  content: string,
  recentContext: string,
  credential: JevCredentialStore['resolve'],
  signal: AbortSignal
): Promise<CodexContentPreflightResult> {
  try {
    if (!credential()) return { warning: false };
    const request = codexContentWarningRequest(role, content, recentContext);
    const timeout = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
    const result = await executeJevJudgment(request, digest({ role, request }), null, {
      signal: AbortSignal.any([signal, timeout]),
      credential,
      onAttemptStart: () => randomUUID(),
      onAttemptFinish: () => {},
    });
    return { warning: result.scores.explicitSexualContent! >= CODEX_CONTENT_WARNING_THRESHOLD };
  } catch {
    // Advisory only: an unavailable or uncertain preflight must not block the user's request.
    return { warning: false };
  }
}

function currentContext(store: Store, chatId: string): string {
  const chat = store.chat(chatId);
  if (!chat.headRevision) return '';
  return store.source(chat.headRevision).text.slice(-RECENT_CONTEXT_CHARS);
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
      ? store.source(run.parentRevision).text.slice(-RECENT_CONTEXT_CHARS)
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
      fields(body, ['role', 'text', 'retryRunId', 'selection']);
      const role = body.role;
      if (role !== 'main' && role !== 'translation' && role !== 'selection-revision')
        throw new HttpError(400, 'CODEX_CONTENT_PREFLIGHT_ROLE_INVALID');
      const content = text(body.text, 'preflight text', REQUEST_TEXT_MAX_CHARS);
      store.chat(request.params.id);
      if (role === 'selection-revision') {
        const selection = text(body.selection, 'selected passage', REQUEST_TEXT_MAX_CHARS);
        const selected = workspaceModelRef(promptWorkspace(store), 'helper');
        if (!selected || !isCodex(store.product.modelSnapshot(selected.id, 'helper')))
          return { warning: false };
        return judge(role, content, selection, credentials.resolve, signal);
      }
      const target =
        role === 'main'
          ? mainTarget(store, request.params.id, body.retryRunId)
          : {
              model: store.product.snapshot(request.params.id, 'translation').models.translation,
              context: '',
            };
      if (!isCodex(target.model)) return { warning: false };
      return judge(role, content, target.context, credentials.resolve, signal);
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
      return judge('translation', source.text, '', credentials.resolve, signal);
    }
  );
}
