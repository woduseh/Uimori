import type { NativeTransferReceipt } from './native-transfer.js';
import type { Chat } from './types.js';

export const RISU_IMPORT_MAX_BYTES = 24 * 1024 * 1024;
export type RisuImportSource = { name: string; base64: string; uploadId?: undefined };
/** A staged upload keeps a large container out of the request body and the import receipt. */
export type RisuImportStagedSource = { name: string; uploadId: string; base64?: undefined };
/** Above this size the app reads a staged file and records the original's identity only. */
export const RISU_IMPORT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export type RisuImportKind = 'bot' | 'module';
export type RisuImportFinding = {
  code: string;
  level: 'info' | 'warning' | 'unsupported';
  message: string;
};
export type RisuImportPreview = {
  kind: RisuImportKind;
  digest: string;
  title: string;
  description: string;
  format: 'charx' | 'character-card-json' | 'risu-module-json' | 'risu-module-project-zip';
  summary: { lore: number; starts: number; images: number };
  lore: {
    id: string;
    title: string;
    text: string;
    enabled: boolean;
    loading: 'pinned' | 'discoverable';
    memoryCandidate: boolean;
  }[];
  findings: RisuImportFinding[];
};
export type RisuImportApply = {
  source: RisuImportSource | RisuImportStagedSource;
  kind?: RisuImportKind;
  digest: string;
  memoryIds: string[];
  allowPartial: boolean;
  idempotencyKey: string;
};
export type RisuImportResult = {
  receipt: NativeTransferReceipt;
  chat: Chat | null;
};
