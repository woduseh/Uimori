import type { NativeTransferReceipt } from './native-transfer.js';
import type { Chat } from './types.js';

export const RISU_IMPORT_MAX_BYTES = 24 * 1024 * 1024;
/** How many assets one container may declare, across its metadata and its stored files. */
export const RISU_IMPORT_MAX_ASSETS = 2000;
/** How many lore entries one module or card lorebook may declare. */
export const RISU_IMPORT_MAX_LORE_ENTRIES = 2000;
/** A container never expands past this in total, whatever its own file size claims. */
export const RISU_IMPORT_MAX_CONTAINER_BYTES = 64 * 1024 * 1024;
/** One entry inside a container never expands past this, so no single member can be huge. */
export const RISU_IMPORT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** How many members a ZIP container may declare. */
export const RISU_IMPORT_MAX_ZIP_MEMBERS = 4096;
/** The card or module JSON document read out of a container stays a parseable size. */
export const RISU_IMPORT_MAX_JSON_BYTES = 8 * 1024 * 1024;
export type RisuImportSource = { name: string; base64: string; uploadId?: undefined };
/** A staged upload keeps a large container out of the request body and the import receipt. */
export type RisuImportStagedSource = { name: string; uploadId: string; base64?: undefined };
/** Above this size the app reads a staged file and records the original's identity only. */
export const RISU_IMPORT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export type RisuImportKind = 'bot' | 'persona' | 'module';
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
  format:
    | 'charx'
    | 'character-card-json'
    | 'risu-module-json'
    | 'risu-module-project-zip'
    | 'risu-module-binary';
  summary: { lore: number; starts: number; images: number };
  lore: {
    id: string;
    title: string;
    text: string;
    enabled: boolean;
    loading: 'pinned' | 'discoverable';
    /** The preserved Risu activation keys, when the entry has any, so the screen can name them. */
    keys?: string;
  }[];
  imageHandoff?: import('./risu-image-handoff.js').RisuImageHandoff;
  findings: RisuImportFinding[];
};
export type RisuImportApply = {
  source: RisuImportSource | RisuImportStagedSource;
  kind?: RisuImportKind;
  digest: string;
  imageHandoffIds?: string[];
  allowPartial: boolean;
  idempotencyKey: string;
};
export type RisuImportResult = {
  receipt: NativeTransferReceipt;
  chat: Chat | null;
};
