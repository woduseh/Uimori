import type {
  Content,
  ContentKind,
  ContentRef,
  ModelRef,
  PromptPreset,
  PromptRole,
  SavedPromptCombination,
} from './product.js';
import type { PackageImage } from './package-images.js';

export const NATIVE_TRANSFER_FORMAT = 'uimori-native-transfer';
export const NATIVE_TRANSFER_VERSION = 1;
export const NATIVE_TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export type NativeTransferKind = 'content' | 'prompt-preset';
export type NativeTransferRef = { kind: NativeTransferKind; key: string };
export type NativeTransferOrigin = {
  format: typeof NATIVE_TRANSFER_FORMAT;
  digest: string;
  entryKey: string;
  sourceId: string;
  sourceRevision: number;
};
export type NativeTransferContent = {
  key: string;
  /** Authored source identity and body, before destination remapping. */
  source: Omit<Content, 'coverImage' | 'hasPackage'>;
  /** Captured effective modules in the source declaration order. */
  modules: string[];
  origin?: NativeTransferOrigin;
};
export type NativeTransferPrompt = {
  key: string;
  source: PromptPreset;
  combinations: SavedPromptCombination[];
  origin?: NativeTransferOrigin;
};
export type NativeTransferImage = {
  id: string;
  revision: 1;
  hash: string;
  mime: PackageImage['mime'];
  base64: string;
};
/** Opaque source bytes owned by one entry; never part of its model context. */
export type NativeTransferSourceFile = {
  entryKey: string;
  name: string;
  mediaType: string;
  hash: string;
  base64: string;
};
export type NativeTransferFile = {
  format: typeof NATIVE_TRANSFER_FORMAT;
  version: typeof NATIVE_TRANSFER_VERSION;
  roots: NativeTransferRef[];
  contents: NativeTransferContent[];
  prompts: NativeTransferPrompt[];
  images: NativeTransferImage[];
  sourceFiles?: NativeTransferSourceFile[];
};
export type NativeTransferExportRequest = { items: { kind: NativeTransferKind; id: string }[] };
export type NativeTransferSummary = {
  contents: number;
  prompts: number;
  combinations: number;
  images: number;
  imageBytes: number;
  sourceFiles?: number;
  sourceFileBytes?: number;
};
export type NativeTransferEntry = NativeTransferRef & {
  title: string;
  category: ContentKind | PromptRole;
  root: boolean;
};
export type NativeTransferModelRequirement = {
  key: string;
  promptKey: string;
  promptTitle: string;
  agentId: string;
  agentTitle: string;
  sourceModelId: string;
};
export type NativeTransferModelBinding =
  | { requirementKey: string; mode: 'local'; model: ModelRef }
  | { requirementKey: string; mode: 'inherit-main' };
export type NativeTransferPrepare = {
  digest: string;
  summary: NativeTransferSummary;
  entries: NativeTransferEntry[];
  modelRequirements: NativeTransferModelRequirement[];
  warnings: { code: string; key: string; message: string }[];
};
export type NativeTransferApplyRequest = {
  file: NativeTransferFile;
  digest: string;
  modelBindings: NativeTransferModelBinding[];
  idempotencyKey: string;
};
export type NativeTransferReceipt = {
  id: string;
  created: boolean;
  digest: string;
  importedAt: string;
  summary: NativeTransferSummary;
  items: (NativeTransferEntry & ContentRef)[];
};
