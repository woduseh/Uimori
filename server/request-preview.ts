import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { EXECUTION_INPUT_MAX_CHARS, REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { contextBudgetForModel, estimateContextTokens } from '../core/context-budget.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import type { RequestPreview } from '../core/request-preview.js';
import type { Connection, ModelPreset, PromptPreset } from '../core/product.js';
import { tokenizerInfo } from '../core/text-tokens.js';
import type { RunSnapshot } from '../core/types.js';
import { contextSourceRefs, withContextProjection } from './context-planning.js';
import { CONTEXT_COMPACTION_TRIGGER_RATIO } from './context-compaction.js';
import { loreSelectionPending } from './lore-selection.js';
import { buildMainProviderRequest, encodeMainPreview } from './main-request.js';
import { promptWorkspace } from './prompt-workspace.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { freezeReservationSnapshot } from './reservation-snapshot.js';
import { nativeRisuPending, prepareNativeRisuRun } from './risu-native-run.js';
import { requestReceipt } from './request-receipt.js';
import type { Store } from './store.js';

/** Read current saved selections and estimate the existing encoder projection, without execution. */
export async function previewNextRequest(
  store: Store,
  chatId: string,
  request: string,
  loreContextReset = false
): Promise<RequestPreview> {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chat.id, 'main', chat.headRevision);
  const workspace = promptWorkspace(store);
  const target = profile.models.main;
  const notesRevision = store.story.notes.revision(chat.id);
  const prompt = profile.promptPresets?.main;
  const personaRef = profile.packageAttachments?.find((item) => item.role === 'persona');
  const persona = profile.packages?.find(
    (item) => item.id === personaRef?.id && item.revision === personaRef.revision
  );
  const display = (value: { id: string; revision: number; title: string }) => ({
    id: value.id,
    revision: value.revision,
    title: value.title,
  });
  const result: RequestPreview = {
    scope: 'next-request-read-only',
    snapshot: {
      chatId: chat.id,
      headRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      profileRevision: profile.revision,
      promptWorkspaceRevision: workspace.revision,
      modelWorkspaceRevision: workspace.revision,
      contextRevision: null,
      requestHash: createHash('sha256').update(request).digest('hex'),
      loreContextReset,
      stale: false,
    },
    selected: {
      model: target
        ? { ...display(target), modelId: target.modelId, protocol: target.connection.protocol }
        : null,
      prompt: prompt ? display(prompt) : null,
      persona: persona ? display(persona) : null,
    },
    tokens: {
      estimatedInputTokens: null,
      inputTokenLimit: null,
      estimator: null,
      tokenizer: null,
      tokenizerInfo: null,
      utilization: null,
      status: 'unknown',
    },
    lore: {
      enabled: (profile.loreContext ?? DEFAULT_LORE_CONTEXT).enabled,
      resetRequested: loreContextReset,
      retainedEntries: null,
      pinnedEntries: null,
      selectionPending: false,
    },
    summary: { available: null, inUse: null, compactedSources: null, compactionPending: null },
    caveats: ['LOCAL_TOKEN_ESTIMATE', 'SNAPSHOT_MAY_CHANGE'],
    error: null,
  };
  let snapshot: RunSnapshot = {
    chatId: chat.id,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    history: store.history(chat.headRevision),
    resources: store.product.resources(chat.id, profile),
    profile,
    ...(loreContextReset ? { loreContextReset: true } : {}),
  };
  try {
    snapshot = freezeReservationSnapshot(store, snapshot, {
      purpose: 'preview-main',
      executionClock: () => {
        const iso = new Date().toISOString();
        return { iso, unix: Math.floor(Date.parse(iso) / 1000) };
      },
    });
    if (nativeRisuPending(snapshot))
      result.caveats.push('NATIVE_CALLBACKS_DEFERRED', 'NATIVE_EDIT_REQUEST_DEFERRED');
    result.lore.selectionPending = loreSelectionPending(snapshot);
    if (result.lore.selectionPending) result.caveats.push('LORE_SELECTION_PENDING');
    // The native preview evaluates copied CBS fields/regex and skips input/editInput/start callbacks.
    snapshot = await prepareNativeRisuRun(snapshot, { preview: true });
    snapshot = store.context.prepareRun(snapshot);
    result.snapshot.contextRevision = snapshot.contextBase!.activeRevision;
    result.summary.available = snapshot.contextBase!.checkpoint !== null;
    const previous = store.context.previous(snapshot);
    result.summary.inUse = previous?.summary ? null : false;
    result.summary.compactedSources = previous?.compacted.length ?? 0;
    if (result.summary.available && !previous?.summary) result.caveats.push('SUMMARY_NOT_REUSABLE');
    if (snapshot.contextPlan) {
      if (previous?.checkpoint) snapshot.contextPlan.checkpoint = previous.checkpoint;
      snapshot = withContextProjection(
        snapshot,
        previous?.compacted ?? [],
        previous?.summary ?? null
      );
    }
    result.lore.retainedEntries = snapshot.loreContext?.entries.length ?? null;
    if (!target) {
      result.error = 'MAIN_MODEL_REQUIRED';
      result.caveats.push('MODEL_NOT_SELECTED');
    } else {
      const budget = contextBudgetForModel(target);
      result.tokens.inputTokenLimit = budget.inputTokenLimit;
      result.tokens.estimator = budget.estimator;
      result.tokens.tokenizer =
        budget.estimator === 'model-local-v1' ? budget.tokenizer : 'openai-o200k';
      result.tokens.tokenizerInfo = tokenizerInfo(result.tokens.tokenizer);
      if (result.tokens.tokenizerInfo.fallback) result.caveats.push('TOKENIZER_FALLBACK');
      const built = buildMainProviderRequest(snapshot);
      // This follows the current transport choice without changing evaluation policy.
      const evaluation = target.evaluationTools;
      const wire = encodeMainPreview(built.request, target, {
        codexNative:
          target.connection.protocol === 'codex-app-server-v1' &&
          !(
            evaluation?.contextMode === 'preloaded' &&
            evaluation.approvalReasoningMode === 'economized'
          ),
      });
      const estimated = estimateContextTokens(wire.body, budget);
      const summary = requestReceipt(built.snapshot, wire).summary;
      result.summary.inUse =
        summary?.status === 'unverified' ? null : summary?.status === 'included';
      if (previous?.summary && result.summary.inUse !== true)
        result.caveats.push('SUMMARY_INCLUSION_UNVERIFIED');
      result.tokens.estimatedInputTokens = estimated;
      result.tokens.utilization = estimated / budget.inputTokenLimit;
      const pending = estimated > budget.inputTokenLimit * CONTEXT_COMPACTION_TRIGGER_RATIO;
      result.tokens.status = pending ? 'compaction-pending' : 'within-budget';
      result.summary.compactionPending = pending;
      if (pending) result.caveats.push('COMPACTION_PENDING');
      result.lore.pinnedEntries = (built.input.pinnedSources ?? []).filter(
        (item) => item.kind === 'lore'
      ).length;
    }
  } catch {
    // Author-controlled compilation errors can contain source text. Return bounded metadata only.
    result.error = 'PREVIEW_UNAVAILABLE';
    result.caveats.push('PREVIEW_UNAVAILABLE');
  }
  // Native CBS/regex work awaits an isolated worker. A concurrent save must not make
  // its earlier projection look current. Do not retry or reserve anything here.
  const current = store.chat(chat.id);
  let stale =
    current.headRevision !== chat.headRevision ||
    current.settingsRevision !== chat.settingsRevision ||
    store.product.profile(chat.id).revision !== profile.revision ||
    promptWorkspace(store).revision !== workspace.revision ||
    store.story.notes.revision(chat.id) !== notesRevision;
  if (result.snapshot.contextRevision !== null)
    stale ||=
      store.context.prepareRun(snapshot).contextBase!.activeRevision !==
      result.snapshot.contextRevision;
  try {
    stale ||=
      JSON.stringify(
        contextSourceRefs({ ...snapshot, history: store.history(current.headRevision) })
      ) !== JSON.stringify(contextSourceRefs(snapshot));
    // Live attached links follow the latest library revision, including transitive modules,
    // without advancing the chat's stored profile revision. Read only their small metadata.
    const latestContent = store.db.prepare(
      "SELECT revision FROM versions WHERE kind='content' AND id=?"
    );
    for (const attachment of profile.packageAttachments ?? []) {
      const latest = latestContent.get(attachment.id) as { revision: number } | undefined;
      stale ||= latest?.revision !== attachment.revision;
    }
    if (target)
      stale ||= store.product.get<ModelPreset>('model', target.id).revision !== target.revision;
    if (target)
      stale ||=
        store.product.get<Connection>('connection', target.connection.id).revision !==
        target.connection.revision;
    if (profile.pinned?.mainPromptPresetId && prompt)
      stale ||=
        store.product.get<PromptPreset>('prompt-preset', profile.pinned.mainPromptPresetId)
          .revision !== prompt.revision;
  } catch {
    stale = true;
  }
  if (stale) {
    result.snapshot.stale = true;
    result.caveats.push('SNAPSHOT_CHANGED');
  }
  return result;
}

export function requestPreviewRoutes(app: FastifyInstance, store: Store) {
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/request-preview',
    { bodyLimit: EXECUTION_INPUT_MAX_CHARS },
    async (request) => {
      const body = record(request.body);
      fields(body, ['request', 'loreContextReset']);
      if (body.loreContextReset !== undefined && typeof body.loreContextReset !== 'boolean')
        throw new HttpError(400, 'Invalid lore context reset');
      return previewNextRequest(
        store,
        request.params.id,
        text(body.request, 'preview request', REQUEST_TEXT_MAX_CHARS),
        body.loreContextReset === true
      );
    }
  );
}
