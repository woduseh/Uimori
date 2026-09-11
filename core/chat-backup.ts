/** A portable document, versioned independently from SQLite. Development versions may change. */
export const CHAT_BACKUP_FORMAT = 'uimori-chat-backup';
export const CHAT_BACKUP_VERSION = 1;
export const CHAT_BACKUP_MAX_BYTES = 256 * 1024 * 1024;
export type BackupValue =
  | null
  | boolean
  | number
  | string
  | BackupValue[]
  | { [key: string]: BackupValue };
export type BackupRecord = { [key: string]: BackupValue };
export type ChatBackup = {
  format: typeof CHAT_BACKUP_FORMAT;
  version: typeof CHAT_BACKUP_VERSION;
  createdAt: string;
  chatId: string;
  records: Record<string, BackupRecord[]>;
};
export type ChatBackupImport = {
  chat: import('./types.js').Chat;
  created: boolean;
  branches: number;
  sources: number;
};
