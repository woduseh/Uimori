import type { RisuPrompt, PromptValue } from './risu-prompt.js';
import type { NativeTransferReceipt } from './native-transfer.js';
import type { PromptPreset } from './product.js';
import type { RisuImportSource } from './risu-import.js';

export type RisuPresetFindingParams = {
  RISU_PRESET_UNSUPPORTED_BLOCK: { position: number; type: string };
  RISU_PRESET_HOST_SETTING: { setting: string };
  RISU_PRESET_HOST_MEMORY: undefined;
};
export type RisuPresetFindingCode = keyof RisuPresetFindingParams;
export type RisuPresetFinding =
  | {
      code: 'RISU_PRESET_UNSUPPORTED_BLOCK';
      level: 'unsupported';
      params: RisuPresetFindingParams['RISU_PRESET_UNSUPPORTED_BLOCK'];
    }
  | {
      code: 'RISU_PRESET_HOST_SETTING';
      level: 'unsupported';
      params: RisuPresetFindingParams['RISU_PRESET_HOST_SETTING'];
    }
  | { code: 'RISU_PRESET_HOST_MEMORY'; level: 'warning'; params?: never };

export type RisuPresetProgramImport = {
  title: string;
  role: 'main';
  program: RisuPrompt;
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
