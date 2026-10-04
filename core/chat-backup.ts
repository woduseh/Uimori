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
    'id' | 'parentId' | 'level' | 'position' | 'title' | 'intent' | 'fixed' | 'relatedIds'
  >[];
  /** Source associations, not execution status or receipts. */
  outlineSources?: { nodeId: string; atIndex: number }[];
  options: Record<string, import('./risu-prompt.js').PromptValue>;
  lore: (Omit<
    import('./chat-overrides.js').ChatLoreOverride,
    'id' | 'chatId' | 'revision' | 'atSource' | 'atHash' | 'retired' | 'createdAt'
  > & { atIndex: number | null })[];
};
export type ChatCopyState = {
  sceneTitles?: { atIndex: number; title: string }[];
  bookmarks?: import('./reading-state.js').PortableBookmark[];
  authoring?: ChatCopyAuthoring;
  messages?: CopiedMessageState[];
  variables: ChatVariableState;
  checkpoints: (ChatVariableState | null)[];
  settings: Settings;
  profile: Pick<ChatProfile, 'image' | 'imageTranslation' | 'loreContext' | 'pinned'>;
};
export type PortableIllustrationAnchor = { index: number; textHash: string };
export type PortableIllustration = {
  group?: string;
  position?: number;
  width?: number;
  height?: number;
  stale?: boolean;
  sourceHash?: string;
  target?: {
    focus: string;
    start: PortableIllustrationAnchor;
    end: PortableIllustrationAnchor;
    hero: boolean;
  };
  translation?: { textHash: string; after: PortableIllustrationAnchor };
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
  sources: number;
  chats: import('./types.js').Chat[];
  notices: string[];
};
