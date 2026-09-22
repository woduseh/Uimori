import type { PromptControl, RisuPrompt, PromptValue } from './risu-prompt.js';

export type OptionValues = Record<string, PromptValue>;
export type OptionBinding = { owner: string; definitionHash: string };
/** One owner rule for the frozen profile and the live binding: the applied preset, else the bare slot. */
export const promptOptionOwner = (prompt: { presetId?: string }): string =>
  prompt.presetId ? `preset:${prompt.presetId}` : 'workspace:main';

export type PendingChatOptions = {
  id: string;
  chatId: string;
  branchId: string;
  kind: 'oneoff';
  binding: OptionBinding;
  values: OptionValues;
  headRevision: string | null;
  headHash: string | null;
  status: 'pending' | 'consumed' | 'cancelled' | 'superseded';
  runId: string | null;
  createdAt: string;
  definitions: PromptControl[];
  origin?: { pendingId: string; chatId: string; branchId: string; runId: string };
};
export type ChatOptionState = {
  chatId: string;
  branchId: string;
  revision: number;
  binding: OptionBinding;
  workspaceRevision: number;
  program: RisuPrompt;
  /** Effective native preset/card/module declarations; never another authored program. */
  controls?: PromptControl[];
  globalValues: OptionValues;
  fixedValues: OptionValues;
  pending: PendingChatOptions[];
  conflicts: string[];
  headRevision: string | null;
};
/** Self-contained resolution evidence. Later defaults never reinterpret it. */
export type ChatOptionResolution = {
  binding: OptionBinding;
  revision: number;
  globalValues: OptionValues;
  fixedValues: OptionValues;
  oneoffValues: OptionValues;
  pendingIds: string[];
  values: OptionValues;
};
