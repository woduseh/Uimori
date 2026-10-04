import type { ContextBudget } from './context-budget.js';
import type { ProviderProtocol } from './product.js';
import type { TokenizerProfileId } from './tokenizer-profiles.js';

export type RequestPreviewCaveat =
  | 'LOCAL_TOKEN_ESTIMATE'
  | 'SNAPSHOT_MAY_CHANGE'
  | 'SNAPSHOT_CHANGED'
  | 'NATIVE_CALLBACKS_DEFERRED'
  | 'NATIVE_EDIT_REQUEST_DEFERRED'
  | 'LORE_SELECTION_PENDING'
  | 'COMPACTION_PENDING'
  | 'SUMMARY_NOT_REUSABLE'
  | 'SUMMARY_INCLUSION_UNVERIFIED'
  | 'MODEL_NOT_SELECTED'
  | 'PREVIEW_UNAVAILABLE'
  | 'TOKENIZER_FALLBACK';

type Selection = { id: string; revision: number; title: string };

/** Metadata about a current, read-only projection; never a saved Run or billed usage. */
export type RequestPreview = {
  scope: 'next-request-read-only';
  snapshot: {
    chatId: string;
    headRevision: string | null;
    settingsRevision: number;
    profileRevision: number;
    promptWorkspaceRevision: number;
    modelWorkspaceRevision: number;
    contextRevision: number | null;
    requestHash: string;
    loreContextReset: boolean;
    stale: boolean;
  };
  selected: {
    model: (Selection & { modelId: string; protocol: ProviderProtocol }) | null;
    prompt: Selection | null;
    persona: Selection | null;
  };
  tokens: {
    estimatedInputTokens: number | null;
    inputTokenLimit: number | null;
    estimator: ContextBudget['estimator'] | null;
    tokenizer: TokenizerProfileId | null;
    tokenizerInfo: {
      requested: TokenizerProfileId;
      effective: TokenizerProfileId;
      kind: 'local' | 'approximate';
      fallback: boolean;
    } | null;
    utilization: number | null;
    status: 'within-budget' | 'compaction-pending' | 'unknown';
  };
  lore: {
    enabled: boolean;
    resetRequested: boolean;
    retainedEntries: number | null;
    /** Projected pinned lore sources only, excluding bot/persona/instructions. */
    pinnedEntries: number | null;
    selectionPending: boolean;
  };
  summary: {
    available: boolean | null;
    inUse: boolean | null;
    compactedSources: number | null;
    /** The current estimate crosses the host's preparation threshold; no summary is created. */
    compactionPending: boolean | null;
  };
  caveats: RequestPreviewCaveat[];
  error: 'MAIN_MODEL_REQUIRED' | 'PREVIEW_UNAVAILABLE' | null;
};
