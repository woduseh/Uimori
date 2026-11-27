import { createHash } from 'node:crypto';
import { readerEndpoints } from '#contracts';
import { readerOperations } from '#contracts/operations';
import type { FastifyInstance } from 'fastify';
import { contextBudgetForModel } from '../core/context-budget.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import type { RequestPreview } from '../core/request-preview.js';
import {
  type RequestImage,
  type RequestImagePreview,
  validateRequestImage,
} from '../core/request-images.js';
import type { LoreContextSnapshot } from '../core/lore-context.js';
import type { Connection, ModelPreset, PromptPreset } from '../core/product.js';
import type { PromptCompilation } from '../core/risu-prompt.js';
import { tokenizerInfo } from '../core/text-tokens.js';
import type { RunSnapshot } from '../core/types.js';
import {
  contextSourceRefs,
  contextSourcesMatch,
  withContextProjection,
} from './context-planning.js';
import { CONTEXT_COMPACTION_TRIGGER_RATIO } from '../core/context-compaction.js';
import { loreSelectionPending } from './lore-selection.js';
import { buildMainProviderRequest, measureProviderRequest } from './main-request.js';
import { promptWorkspace } from './prompt-workspace.js';
import { registerEndpoint } from './endpoint.js';
import { freezeReservationSnapshot } from './reservation-snapshot.js';
import { nativeRisuPending, prepareNativeRisuRun } from './risu-native-run.js';
import { requestReceipt } from './request-receipt.js';
import type { Store } from './store.js';
import { storyUiThemeChoices } from './themes.js';

export async function previewNextRequest(
  store: Store,
  chatId: string,
  request: string,
  loreContextReset = false,
  requestImages: readonly RequestImagePreview[] = []
): Promise<RequestPreview> {
  return (await inspectNextRequest(store, chatId, request, loreContextReset, requestImages))
    .preview;
}

export type NextRequestInspection = {
  preview: RequestPreview;
  compilation: PromptCompilation | null;
  loreContext: LoreContextSnapshot | null;
};

export async function inspectNextRequest(
  store: Store,
  chatId: string,
  request: string,
  loreContextReset = false,
  requestImages: readonly RequestImagePreview[] = []
): Promise<NextRequestInspection> {
  let compilation: PromptCompilation | null = null;
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
      requestHash: createHash('sha256')
        .update(requestImages.length ? JSON.stringify([request, requestImages]) : request)
        .digest('hex'),
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
    ...(requestImages.length ? { requestImages: previewImages(requestImages) } : {}),
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
      compilation = built.snapshot.promptCompilation ?? null;
      const evaluation = target.evaluationTools;
      const measured = measureProviderRequest(built.request, target, {
        codexNative:
          target.connection.protocol === 'codex-app-server-v1' &&
          !(
            evaluation?.contextMode === 'preloaded' &&
            evaluation.approvalReasoningMode === 'economized'
          ),
      });
      const estimated = measured.estimatedInputTokens;
      const summary = requestReceipt(built.snapshot, measured).summary;
      result.summary.inUse =
        summary?.status === 'unverified' ? null : summary?.status === 'included';
      if (previous?.summary && result.summary.inUse !== true)
        result.caveats.push('SUMMARY_INCLUSION_UNVERIFIED');
      result.tokens.estimatedInputTokens = estimated;
      result.tokens.imageCount = measured.imageCount;
      result.tokens.estimatedImageTokens = measured.estimatedImageTokens;
      result.tokens.imageEstimate = measured.imageEstimate;
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
    compilation = null;
    result.error = 'PREVIEW_UNAVAILABLE';
    result.caveats.push('PREVIEW_UNAVAILABLE');
  }
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
    if (!stale && chat.settings.storyUi)
      stale =
        JSON.stringify(snapshot.storyUiThemeChoices) !==
        JSON.stringify(storyUiThemeChoices(store, current.botId));
    stale ||= !contextSourcesMatch(store, current.headRevision, contextSourceRefs(snapshot));
    const latestContent = store.db.prepare(
      "SELECT revision FROM versions WHERE kind='content' AND id=?"
    );
    for (const attachment of profile.packageAttachments ?? []) {
      const latest = latestContent.get(attachment.id) as { revision: number } | undefined;
      stale ||= latest?.revision !== attachment.revision;
    }
    if (target)
      stale ||=
        store.product.available<ModelPreset>('model', target.id).revision !== target.revision;
    if (target)
      stale ||=
        store.product.available<Connection>('connection', target.connection.id).revision !==
        target.connection.revision;
    if (profile.pinned?.mainPromptPresetId && prompt)
      stale ||=
        store.product.available<PromptPreset>('prompt-preset', profile.pinned.mainPromptPresetId)
          .revision !== prompt.revision;
  } catch {
    stale = true;
  }
  if (stale) {
    result.snapshot.stale = true;
    result.caveats.push('SNAPSHOT_CHANGED');
  }
  return {
    preview: result,
    compilation,
    loreContext: result.error === 'PREVIEW_UNAVAILABLE' ? null : (snapshot.loreContext ?? null),
  };
}

export function requestPreviewRoutes(app: FastifyInstance, store: Store) {
  registerEndpoint(
    app,
    readerEndpoints.previewRequest,
    readerOperations.previewRequest,
    ({ chatId, request, loreContextReset, requestImages }) =>
      previewNextRequest(store, chatId, request, loreContextReset === true, requestImages ?? [])
  );
}

function previewImages(images: readonly RequestImagePreview[]): RequestImage[] {
  return images.map((image, index) => {
    const hash = createHash('sha256')
      .update(JSON.stringify([index, image]))
      .digest('hex');
    const ratio = Math.min(1, 2048 / Math.max(image.width, image.height));
    return validateRequestImage({
      ...image,
      hash,
      mime: 'image/webp',
      input: {
        hash,
        width: Math.max(1, Math.round(image.width * ratio)),
        height: Math.max(1, Math.round(image.height * ratio)),
      },
    });
  });
}
