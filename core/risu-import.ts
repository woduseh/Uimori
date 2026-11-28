import type { NativeTransferReceipt } from './native-transfer.js';
import type { Chat } from './types.js';
import { RISU_ASSET_MAX, RISU_ZIP_MEMBERS_MAX } from './risu-limits.js';

export { RISU_IMPORT_MAX_BYTES } from '#contracts';
export const RISU_IMPORT_MAX_ASSETS = RISU_ASSET_MAX;
export const RISU_IMPORT_MAX_LORE_ENTRIES = 2000;
export const RISU_IMPORT_MAX_CONTAINER_BYTES = 64 * 1024 * 1024;
export const RISU_IMPORT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const RISU_IMPORT_MAX_ZIP_MEMBERS = RISU_ZIP_MEMBERS_MAX;
export const RISU_IMPORT_MAX_JSON_BYTES = 8 * 1024 * 1024;
export type RisuImportSource = { name: string; base64: string; uploadId?: undefined };
export type RisuImportStagedSource = { name: string; uploadId: string; base64?: undefined };
export const RISU_IMPORT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const RISU_IMPORT_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const RISU_IMPORT_MAX_PREPARED_BYTES = 448 * 1024 * 1024;
export const risuImportExpandedLimit = (containerBytes: number): number =>
  Math.min(
    RISU_IMPORT_MAX_EXPANDED_BYTES,
    Math.max(RISU_IMPORT_MAX_CONTAINER_BYTES, containerBytes * 4)
  );
export type RisuImportKind = 'bot' | 'persona' | 'module';
export type RisuImportFindingParams = {
  'asset-unavailable': undefined;
  'asset-invalid': undefined;
  'asset-format': undefined;
  'asset-role': undefined;
  'creator-notes-truncated': undefined;
  'disabled-lore': undefined;
  'lore-not-activated': undefined;
  'lore-inline-directive': undefined;
  'lore-decorator-placement': { decorator: string };
  'lore-decorator-activation': { decorator: string };
  'lore-decorator-unknown': { names: string; more: number };
  'native-model-calls': undefined;
  'native-variable-projection': undefined;
};
export type RisuImportFindingCode = keyof RisuImportFindingParams;
export const RISU_IMPORT_FINDING_LEVELS = {
  'asset-unavailable': 'unsupported',
  'asset-invalid': 'unsupported',
  'asset-format': 'unsupported',
  'asset-role': 'info',
  'creator-notes-truncated': 'info',
  'disabled-lore': 'info',
  'lore-not-activated': 'warning',
  'lore-inline-directive': 'unsupported',
  'lore-decorator-placement': 'unsupported',
  'lore-decorator-activation': 'info',
  'lore-decorator-unknown': 'unsupported',
  'native-model-calls': 'info',
  'native-variable-projection': 'warning',
} as const satisfies Record<RisuImportFindingCode, 'info' | 'warning' | 'unsupported'>;
export type FindingParamsArgument<P> = P extends undefined ? [] : [params: P];
export type RisuImportFinding = {
  [C in RisuImportFindingCode]: {
    code: C;
    level: (typeof RISU_IMPORT_FINDING_LEVELS)[C];
  } & (RisuImportFindingParams[C] extends undefined
    ? { params?: never }
    : { params: RisuImportFindingParams[C] });
}[RisuImportFindingCode];
export type RisuImportPreview = {
  preparedId?: string;
  kind: RisuImportKind;
  digest: string;
  title: string;
  description: string;
  format:
    | 'charx'
    | 'character-card-json'
    | 'character-card-png'
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
    keys?: string;
  }[];
  imageHandoff?: import('./risu-image-handoff.js').RisuImageHandoff;
  findings: RisuImportFinding[];
};
export type RisuImportApply = {
  preparedId?: string;
  source: RisuImportSource | RisuImportStagedSource;
  kind?: RisuImportKind;
  digest: string;
  imageHandoffIds?: string[];
  createChat?: boolean;
  allowPartial: boolean;
  idempotencyKey: string;
};
export type RisuImportResult = {
  receipt: NativeTransferReceipt;
  chat: Chat | null;
};
