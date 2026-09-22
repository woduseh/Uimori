import type { ChatTranscript } from './chat-transcript.js';
import type { NativeTransferFile } from './native-transfer.js';
import type { ChatVariableState } from './chat-variables.js';
import type { Settings } from './types.js';
import type { ChatProfile } from './product.js';

export const CHAT_BACKUP_FORMAT = 'uimori-personal-chat';
export const CHAT_BACKUP_VERSION = 1;
export const CHAT_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
export type CopiedMessageState = {
  sourceId: string;
  sourceHash: string;
  changes?: import('./message-changes.js').MessageChanges;
  authored?: import('./risu-native-execution.js').NativeRisuAuthored;
  opening?: boolean;
};
export type ChatCopyAuthoring = {
  outline: Pick<
    import('./outline.js').OutlineNode,
    'id' | 'parentId' | 'level' | 'position' | 'title' | 'intent' | 'fixed'
  >[];
  options: Record<string, import('./risu-prompt.js').PromptValue>;
  lore: (Omit<
    import('./chat-overrides.js').ChatLoreOverride,
    'id' | 'chatId' | 'revision' | 'atSource' | 'atHash' | 'retired' | 'createdAt'
  > & { atIndex: number | null })[];
};
export type ChatCopyState = {
  authoring?: ChatCopyAuthoring;
  messages?: CopiedMessageState[];
  variables: ChatVariableState;
  checkpoints: (ChatVariableState | null)[];
  settings: Settings;
  profile: Pick<ChatProfile, 'image' | 'imageTranslation' | 'loreContext' | 'pinned'>;
};
export type PortableIllustration = {
  entry: number;
  mime: 'image/webp';
  base64: string;
  title: string;
};
export type ChatCopy = {
  transcript: ChatTranscript;
  state: ChatCopyState;
  illustrations: PortableIllustration[];
};
/** Each former branch is an independent chat document. No database tables or execution receipts. */
export type ChatBackup = {
  format: typeof CHAT_BACKUP_FORMAT;
  version: typeof CHAT_BACKUP_VERSION;
  createdAt: string;
  title: string;
  resources: NativeTransferFile;
  chats: ChatCopy[];
  notices: string[];
};
export type ChatBackupImport = {
  chat: import('./types.js').Chat;
  created: boolean;
  branches: number;
  sources: number;
  chats: import('./types.js').Chat[];
  notices: string[];
};
