import type { PromptControl, PromptProgram, PromptValue } from './prompt-program.js';
import type { HelperScope } from './helper.js';

export type OptionValues = Record<string, PromptValue>;
export type OptionBinding = { owner: string; definitionHash: string };
/** One owner rule for the frozen profile and the live binding: the applied preset, else the bare slot. */
export const promptOptionOwner = (prompt: { presetId?: string }): string =>
  prompt.presetId ? `preset:${prompt.presetId}` : 'workspace:main';
export type OptionDelegation = {
  id: string;
  revision: number;
  conversationId: string;
  scope: Extract<HelperScope, { kind: 'chat' }>;
  binding: OptionBinding;
  fields: string[];
  startedAt: string;
  revokedAt: string | null;
  definitions: PromptControl[];
};
export type PendingChatOptions = {
  id: string;
  chatId: string;
  branchId: string;
  kind: 'oneoff' | 'delegated';
  binding: OptionBinding;
  values: OptionValues;
  delegationId?: string;
  headRevision: string | null;
  headHash: string | null;
  status: 'pending' | 'consumed' | 'cancelled' | 'superseded';
  runId: string | null;
  createdAt: string;
  definitions: PromptControl[];
  delegation?: OptionDelegation;
  origin?: { pendingId: string; chatId: string; branchId: string; runId: string };
};
export type ChatOptionState = {
  chatId: string;
  branchId: string;
  revision: number;
  binding: OptionBinding;
  workspaceRevision: number;
  program: PromptProgram;
  globalValues: OptionValues;
  fixedValues: OptionValues;
  pending: PendingChatOptions[];
  delegations: OptionDelegation[];
  conflicts: string[];
  headRevision: string | null;
};
/** Self-contained resolution evidence. Later defaults or revoked delegations never reinterpret it. */
export type ChatOptionResolution = {
  binding: OptionBinding;
  revision: number;
  globalValues: OptionValues;
  fixedValues: OptionValues;
  delegatedValues: OptionValues;
  oneoffValues: OptionValues;
  pendingIds: string[];
  delegationIds: string[];
  values: OptionValues;
};
