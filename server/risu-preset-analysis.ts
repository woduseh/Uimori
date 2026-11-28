import { createHash } from 'node:crypto';
import { promptControls } from '../core/risu-prompt.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
} from '../core/native-transfer.js';
import type { PromptPreset } from '../core/product.js';
import type { RisuPresetImportPreview } from '../core/risu-preset.js';
import { prepareBundle } from './resource-bundle.js';
import { readRisuPresetFile } from './risu-preset-file.js';
import { importRisuPresetProgram } from './risu-preset-program.js';

export function analyzeRisuPreset(value: unknown) {
  const input = readRisuPresetFile(value);
  const converted = importRisuPresetProgram(input.preset);
  const regex = input.preset.regex ?? input.preset.presetRegex;
  const findings = converted.findings;
  const preset: PromptPreset = {
    id: `risu-preset-${input.hash.slice(0, 24)}`,
    revision: 1,
    title: converted.title,
    role: 'main',
    program: converted.program,
    values: converted.values,
  };
  const file: NativeTransferFile = {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: [{ kind: 'prompt-preset', key: 'prompt' }],
    contents: [],
    prompts: [{ key: 'prompt', source: preset, combinations: [] }],
    images: [],
  };
  const bundle = prepareBundle(file);
  const preview: RisuPresetImportPreview = {
    digest: createHash('sha256')
      .update(JSON.stringify({ digest: bundle.preview.digest, findings }))
      .digest('hex'),
    title: converted.title,
    format: input.format,
    summary: {
      blocks: (converted.program.nativeRisuPreset.preset.promptTemplate as unknown[]).length,
      controls: promptControls(converted.program).length,
      regex: Array.isArray(regex) ? regex.length : 0,
    },
    findings,
  };
  return { bundle, preview };
}
