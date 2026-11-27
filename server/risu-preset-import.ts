import { createHash } from 'node:crypto';
import { promptControls } from '../core/risu-prompt.js';
import type { FastifyInstance } from 'fastify';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
  type NativeTransferReceipt,
} from '../core/native-transfer.js';
import type { PromptPreset } from '../core/product.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import type { RisuPresetImportPreview, RisuPresetImportResult } from '../core/risu-preset.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { fields, record, text } from './request-validation.js';
import { readRisuPresetFile } from './risu-preset-file.js';
import { importRisuPresetProgram } from './risu-preset-program.js';
import type { Store } from './store.js';
import { AppError } from './app-errors.js';
import { savedOrDraftChanged, type RetainedReceiptKey } from './import-operations.js';
import { readResourceBundleReceipt } from './resource-bundle.js';

function analyze(value: unknown) {
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
  const transfer = prepareNativeTransfer({ file });
  const preview: RisuPresetImportPreview = {
    digest: createHash('sha256')
      .update(JSON.stringify({ digest: transfer.digest, findings }))
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
  return { file, transfer, preview };
}

export function prepareRisuPresetImport(value: unknown): RisuPresetImportPreview {
  const body = record(value);
  fields(body, ['source']);
  return analyze(body.source).preview;
}

export function applyRisuPresetImport(store: Store, value: unknown): RisuPresetImportResult {
  const body = record(value);
  fields(body, ['source', 'digest', 'allowPartial', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  const digest = text(body.digest, 'import digest', 100);
  if (typeof body.allowPartial !== 'boolean') throw new AppError(400, 'RISU_PRESET_INVALID_FILE');
  const { file, transfer, preview } = analyze(body.source);
  const receiptKey: RetainedReceiptKey = `risu-preset:${requestKey}`;
  const command = { file, digest: transfer.digest, modelBindings: [], idempotencyKey: receiptKey };
  const result = (receipt: NativeTransferReceipt): RisuPresetImportResult => {
    const saved = receipt.items.find(
      (item) => item.kind === 'prompt-preset' && item.key === 'prompt'
    )!;
    return { receipt, preset: store.product.stored<PromptPreset>('prompt-preset', saved.id) };
  };
  if (digest !== preview.digest)
    return savedOrDraftChanged(receiptKey, (key) => {
      const receipt = readResourceBundleReceipt(store, { ...command, idempotencyKey: key });
      return receipt && result(receipt);
    });
  if (!body.allowPartial && preview.findings.some((finding) => finding.level === 'unsupported'))
    throw new AppError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  return store.transaction(() => result(applyNativeTransfer(store, command)));
}

export function risuPresetImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4 + 1024 * 1024;
  app.post('/api/risu-preset-imports/prepare', { bodyLimit }, async (request) =>
    prepareRisuPresetImport(request.body)
  );
  app.post('/api/risu-preset-imports/apply', { bodyLimit }, async (request) =>
    applyRisuPresetImport(store, request.body)
  );
}
