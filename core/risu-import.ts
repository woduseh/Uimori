import type { NativeTransferReceipt } from './native-transfer.js';
import type { Chat } from './types.js';

export const RISU_IMPORT_MAX_BYTES = 24 * 1024 * 1024;
export type RisuImportSource = { name: string; base64: string };
export type RisuImportFinding = {
  code: string;
  level: 'info' | 'warning' | 'unsupported';
  message: string;
};
export type RisuImportPreview = {
  kind: 'bot' | 'module';
  digest: string;
  title: string;
  description: string;
  format: 'charx' | 'character-card-json' | 'risu-module-json';
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
  source: RisuImportSource;
  digest: string;
  memoryIds: string[];
  allowPartial: boolean;
  idempotencyKey: string;
};
export type RisuImportResult = {
  receipt: NativeTransferReceipt;
  chat: Chat | null;
};
