import type { NativeTransferPrepare } from './native-transfer.js';

export const NATIVE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const NATIVE_ARCHIVE_METADATA_MAX_BYTES = 32 * 1024 * 1024;
export type NativeArchivePrepare = NativeTransferPrepare & {
  preparedId: string;
  backup?: { title: string; chats: number; sources: number };
};
