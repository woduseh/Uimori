import type { PromptControl, RisuPrompt, PromptValue } from './risu-prompt.js';

export type OptionValues = Record<string, PromptValue>;
export type OptionBinding = { owner: string; definitionHash: string };
export const promptOptionOwner = (prompt: { presetId?: string }): string =>
  prompt.presetId ? `preset:${prompt.presetId}` : 'workspace:main';

export type PendingChatOptions = {
  id: string;
  chatId: string;
  binding: OptionBinding;
  values: OptionValues;
  createdAt: string;
};
export type ChatOptionState = {
  chatId: string;
  revision: number;
  binding: OptionBinding;
  workspaceRevision: number;
  program: RisuPrompt;
  controls?: PromptControl[];
  globalValues: OptionValues;
  fixedValues: OptionValues;
  pending: PendingChatOptions[];
  conflicts: string[];
};
export type ChatOptionResolution = {
  binding: OptionBinding;
  revision: number;
  globalValues: OptionValues;
  fixedValues: OptionValues;
  oneoffValues: OptionValues;
  pendingIds: string[];
  values: OptionValues;
};
