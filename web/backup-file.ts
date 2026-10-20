import { legacyMessage } from './i18n.js';
import { CHAT_BACKUP_FORMAT, CHAT_BACKUP_MAX_BYTES, type ChatBackup } from '../core/chat-backup.js';
import {
  NATIVE_ARCHIVE_MAX_BYTES,
  NATIVE_ARCHIVE_METADATA_MAX_BYTES,
} from '../core/native-archive.js';
import { NATIVE_TRANSFER_FORMAT, type NativeTransferFile } from '../core/native-transfer.js';

export type BackupFileContents =
  | { kind: 'database' }
  | { kind: 'resources' | 'chat'; archive: true }
  | { kind: 'resources'; archive: false; file: NativeTransferFile }
  | { kind: 'chat'; archive: false; backup: ChatBackup };
const invalid = (): never => {
  throw new Error(legacyMessage('transfer.m147'));
};
const decoder = new TextDecoder();

/** Inspect only the format. Existing preparation endpoints validate the complete selected backup. */
export async function inspectBackupFile(file: File): Promise<BackupFileContents> {
  const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (decoder.decode(signature) === 'SQLite format 3\0') return { kind: 'database' };
  if (file.size > NATIVE_ARCHIVE_MAX_BYTES) throw new Error(legacyMessage('transfer.m148'));
  if (signature.length >= 4 && new DataView(signature.buffer).getUint32(0, true) === 0x04034b50) {
    if (file.size < 22) invalid();
    const end = new DataView(await file.slice(file.size - 22).arrayBuffer());
    if (end.getUint32(0, true) !== 0x06054b50) invalid();
    const count = end.getUint16(10, true),
      size = end.getUint32(12, true),
      start = end.getUint32(16, true);
    if (start + size !== file.size - 22 || size > NATIVE_ARCHIVE_METADATA_MAX_BYTES) invalid();
    const central = new DataView(await file.slice(start, start + size).arrayBuffer());
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > central.byteLength || central.getUint32(cursor, true) !== 0x02014b50)
        invalid();
      const length = central.getUint16(cursor + 28, true),
        extra = central.getUint16(cursor + 30, true),
        comment = central.getUint16(cursor + 32, true);
      if (cursor + 46 + length + extra + comment > central.byteLength) invalid();
      const name = decoder.decode(new Uint8Array(central.buffer, cursor + 46, length));
      if (name === 'manifest.json') {
        const bytes = central.getUint32(cursor + 24, true),
          offset = central.getUint32(cursor + 42, true);
        if (
          central.getUint16(cursor + 10, true) !== 0 ||
          bytes > NATIVE_ARCHIVE_METADATA_MAX_BYTES ||
          offset + 30 > start
        )
          invalid();
        const local = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
        const dataStart = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        if (local.getUint32(0, true) !== 0x04034b50 || dataStart + bytes > start) invalid();
        const manifest = JSON.parse(await file.slice(dataStart, dataStart + bytes).text());
        if (
          manifest?.format !== 'uimori-archive' ||
          manifest.version !== 1 ||
          !['resources', 'chat'].includes(manifest.kind)
        )
          invalid();
        return { kind: manifest.kind, archive: true };
      }
      cursor += 46 + length + extra + comment;
    }
    return invalid();
  }
  if (file.size > CHAT_BACKUP_MAX_BYTES) throw new Error(legacyMessage('transfer.m149'));
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error(legacyMessage('transfer.m126'));
  }
  if (!value || typeof value !== 'object') return invalid();
  const format = (value as { format?: unknown }).format;
  if (format === NATIVE_TRANSFER_FORMAT)
    return { kind: 'resources', archive: false, file: value as NativeTransferFile };
  if (format === CHAT_BACKUP_FORMAT)
    return { kind: 'chat', archive: false, backup: value as ChatBackup };
  return invalid();
}
