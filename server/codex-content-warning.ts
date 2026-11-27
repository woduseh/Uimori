import { textTokenExcerpt } from '../core/text-tokens.js';
import { createHash } from 'node:crypto';
import { readerEndpoints } from '#contracts';
import { readerOperations } from '#contracts/operations';
import type { FastifyInstance } from 'fastify';
import {
  CODEX_CONTENT_WARNING_THRESHOLD,
  CODEX_SEXUAL_CONTENT_BOUNDARY,
} from '../core/codex-content-warning.js';
import type {
  CodexContentPreflightResult,
  CodexContentWarningRole,
} from '../core/codex-content-warning.js';
import { workspaceModelRef, type ModelSnapshot } from '../core/product.js';
import type { Store } from './store.js';
import type { JevCredentialStore } from './jev-credentials.js';
import { executeJudgment, type JudgmentHooks, type JudgmentRequest } from './judgment.js';
import { jevSettings } from './jev-settings.js';
import { judgmentRuntime, assertJudgmentRuntimeWire } from './judgment-runtime.js';
import { registerEndpoint } from './endpoint.js';
import { AppError } from './app-errors.js';
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
): JudgmentRequest {
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
  settings: JudgmentHooks['settings'] | undefined,
  owner: PreflightOwner
): Promise<CodexContentPreflightResult> {
  try {
    const judgment = judgmentRuntime(owner.store, credential);
    if (!(await judgment.credential?.())) return { warning: conservative };
    const request = codexContentWarningRequest(role, content, recentContext);
    const timeout = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
    const result = await executeJudgment(request, digest({ role, request }), null, {
      signal: AbortSignal.any([signal, timeout]),
      ...judgment,
      settings: judgment.target ? judgment.settings : settings,
      kind: 'codex-content-preflight',
      onAttemptStart: (wire) => {
        assertJudgmentRuntimeWire(wire, judgment);
        return owner.store.product.startAttempt(
          owner.chatId,
          owner.runId ?? null,
          owner.jobId ?? null,
          { ...wire, role: role === 'selection-revision' ? 'helper' : role },
          { kind: 'judgment', retainContent: false }
        );
      },
      onAttemptFinish: (id, result) => owner.store.product.finishAttempt(id, result),
    });
    return { warning: result.scores.explicitSexualContent! >= CODEX_CONTENT_WARNING_THRESHOLD };
  } catch {
    return { warning: conservative };
  }
}

export async function autoTranslationNeedsConfirmation(
  model: ModelSnapshot | undefined,
  source: string,
  credential: JevCredentialStore['resolve'],
  signal: AbortSignal,
  settings: JudgmentHooks['settings'] | undefined,
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
  retryRunId: string | undefined
): { model: ModelSnapshot | undefined; context: string } {
  if (retryRunId === undefined)
    return {
      model: store.product.snapshot(chatId, 'main').models.main,
      context: currentContext(store, chatId),
    };
  if (!store.db.prepare('SELECT 1 FROM runs WHERE id=? AND chat_id=?').get(retryRunId, chatId))
    throw new AppError(404, 'LIBRARY_ITEM_DELETED');
  const run = store.run(retryRunId);
  return {
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
  registerEndpoint(
    app,
    readerEndpoints.preflightChatContent,
    readerOperations.preflightChatContent,
    async (input): Promise<CodexContentPreflightResult> => {
      const { chatId, role, text: content } = input;
      store.chat(chatId);
      if (role === 'selection-revision') {
        const selected = workspaceModelRef(promptWorkspace(store), 'helper');
        if (!selected || !isCodex(store.product.modelSnapshot(selected.id, 'helper')))
          return { warning: false };
        return judge(
          role,
          content,
          input.selection,
          credentials.resolve,
          signal,
          false,
          jevSettings(store.db),
          { store, chatId }
        );
      }
      const target =
        role === 'main'
          ? mainTarget(store, chatId, input.retryRunId)
          : {
              model: store.product.snapshot(chatId, 'translation').models.translation,
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
        { store, chatId }
      );
    }
  );

  registerEndpoint(
    app,
    readerEndpoints.preflightSourceContent,
    readerOperations.preflightSourceContent,
    async ({ sourceId }): Promise<CodexContentPreflightResult> => {
      const source = store.readableSource(sourceId);
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
