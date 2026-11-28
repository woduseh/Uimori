import type { NativeTransferReceipt } from '#contracts';
import type { Content, PromptPreset, SavedPromptCombination } from './product.js';
import type { PackageImage } from './package-images.js';

export const NATIVE_TRANSFER_FORMAT = 'uimori-native-transfer';
export const NATIVE_TRANSFER_VERSION = 1;
export { NATIVE_TRANSFER_MAX_BYTES } from '#contracts';
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
  source: Omit<Content, 'coverImage' | 'hasPackage'>;
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
export type NativeTransferFile = {
  format: typeof NATIVE_TRANSFER_FORMAT;
  version: typeof NATIVE_TRANSFER_VERSION;
  roots: NativeTransferRef[];
  contents: NativeTransferContent[];
  prompts: NativeTransferPrompt[];
  images: NativeTransferImage[];
};
export type NativeTransferSummary = NativeTransferReceipt['summary'];
export type NativeTransferEntry = Omit<NativeTransferReceipt['items'][number], 'id' | 'revision'>;
export type NativeTransferModelRequirement = {
  key: string;
  promptKey: string;
  promptTitle: string;
  agentId: string;
  agentTitle: string;
  sourceModelId: string;
};
export type NativeTransferPrepare = {
  digest: string;
  summary: NativeTransferSummary;
  entries: NativeTransferEntry[];
  modelRequirements: NativeTransferModelRequirement[];
  warnings: { code: string; key: string; message: string }[];
};
export type { NativeTransferReceipt } from '#contracts';
