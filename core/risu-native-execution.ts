import type { ContentPackage, PackageAttachment } from './content-package.js';
import type { PromptHistoryMessage } from './prompt-program.js';
import type { ProviderPrompt } from './prompt-program.js';

export type NativeRisuMessage = { id?: string; role: 'user' | 'char'; data: string };

/** Execution results, never another editable copy of the authored card. */
export type NativeRisuExecution = {
  version: 1;
  inputHash: string;
  beforeVariableRevision: number;
  variables: Record<string, string>;
  fields: Record<string, Record<string, string>>;
  request: string;
  messages: NativeRisuMessage[];
  history: PromptHistoryMessage[];
  issues: string[];
  preRequest?: {
    variables: Record<string, string>;
    messages: NativeRisuMessage[];
    historyRevision?: string;
  };
  historyRevision?: string;
  inputHistoryRevision?: string;
  requestEdits?: { inputHash: string; prompt: ProviderPrompt }[];
  output?: { text: string; variables: Record<string, string>; messages: NativeRisuMessage[] };
};

/** A card action authored these messages without asking the story model to write a turn. */
export type NativeRisuAuthored = {
  version: 1;
  action: string;
  messages: NativeRisuMessage[];
  commandHash?: string;
  greeting?: boolean;
};

export const nativeRisuFieldKey = (attachment: PackageAttachment) =>
  `${attachment.id}@${attachment.revision}:${attachment.role}`;

export function projectNativeRisuFields(
  pkg: ContentPackage,
  attachment: PackageAttachment,
  execution?: NativeRisuExecution
): ContentPackage {
  const fields = execution?.fields[nativeRisuFieldKey(attachment)];
  if (!pkg.nativeRisu || !fields) return pkg;
  return {
    ...pkg,
    body: fields.body ?? pkg.body,
    lore: pkg.lore.map((entry) => ({ ...entry, text: fields[`lore:${entry.id}`] ?? entry.text })),
    instructions: pkg.instructions.map((entry) => ({
      ...entry,
      text: fields[`instruction:${entry.id}`] ?? entry.text,
    })),
    starts: pkg.starts?.map((entry) => ({
      ...entry,
      text: fields[`start:${entry.id}`] ?? entry.text,
    })),
  };
}
