import type { PromptProgram, PromptValue } from './prompt-program.js';
import type { NativeTransferReceipt } from './native-transfer.js';
import type { PromptPreset } from './product.js';
import type { RisuImportSource } from './risu-import.js';

export type RisuPresetFinding = {
  code: string;
  level: 'unsupported' | 'warning';
  message: string;
  blockIndex?: number;
};

/** A conversion preview. Importing does not execute CBS or change model connections. */
export type RisuPresetProgramImport = {
  title: string;
  role: 'main';
  program: PromptProgram;
  values: Record<string, PromptValue>;
  findings: RisuPresetFinding[];
};

export type RisuPresetImportPreview = {
  digest: string;
  title: string;
  format: 'risu-preset-json' | 'risu-preset-project-zip' | 'risu-preset-binary';
  summary: { blocks: number; controls: number; regex: number };
  findings: RisuPresetFinding[];
};
export type RisuPresetImportApply = {
  source: RisuImportSource;
  digest: string;
  allowPartial: boolean;
  idempotencyKey: string;
};
export type RisuPresetImportResult = {
  receipt: NativeTransferReceipt;
  preset: PromptPreset;
};
