import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
} from '../core/native-transfer.js';
import type { PromptPreset } from '../core/product.js';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import type { RisuPresetImportPreview, RisuPresetImportResult } from '../core/risu-preset.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { readRisuPresetFile } from './risu-preset-file.js';
import { importRisuPresetProgram } from './risu-preset-program.js';
import { importRisuPresetRegex } from './risu-preset-regex.js';
import type { Store } from './store.js';

function analyze(value: unknown) {
  const input = readRisuPresetFile(value);
  const converted = importRisuPresetProgram(input.preset);
  const regex = input.preset.regex ?? input.preset.presetRegex;
  const importedRegex = importRisuPresetRegex(regex, converted.program.controls);
  const findings = [...converted.findings, ...importedRegex.findings];
  const preset: PromptPreset = {
    id: `risu-preset-${input.hash.slice(0, 24)}`,
    revision: 1,
    title: converted.title,
    role: 'main',
    program: {
      ...converted.program,
      ...(importedRegex.transforms.length ? { transforms: importedRegex.transforms } : {}),
      provenance: {
        sourceHash: input.hash,
        variant: input.format,
        conversionVersion: '3',
        notes: [...new Set(findings.map((finding) => finding.code))],
      },
    },
    values: converted.values,
  };
  const file: NativeTransferFile = {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: [{ kind: 'prompt-preset', key: 'prompt' }],
    contents: [],
    prompts: [{ key: 'prompt', source: preset, combinations: [] }],
    images: [],
    sourceFiles: [
      {
        entryKey: 'prompt',
        name: input.source.name,
        mediaType:
          input.format === 'risu-preset-json'
            ? 'application/json'
            : input.format === 'risu-preset-project-zip'
              ? 'application/zip'
              : 'application/octet-stream',
        hash: input.hash,
        base64: input.source.base64,
      },
    ],
  };
  const transfer = prepareNativeTransfer({ file });
  const preview: RisuPresetImportPreview = {
    digest: createHash('sha256')
      .update(JSON.stringify({ digest: transfer.digest, findings }))
      .digest('hex'),
    title: converted.title,
    format: input.format,
    summary: {
      blocks: converted.program.blocks.length,
      controls: converted.program.controls.length,
      regex: Array.isArray(regex) ? regex.length : 0,
    },
    findings,
  };
  return { file, transfer, preview };
}

/** Decode and review without persisting a prompt, changing models, or running authored code. */
export function prepareRisuPresetImport(value: unknown): RisuPresetImportPreview {
  const body = record(value);
  fields(body, ['source']);
  return analyze(body.source).preview;
}

export function applyRisuPresetImport(store: Store, value: unknown): RisuPresetImportResult {
  const body = record(value);
  fields(body, ['source', 'digest', 'allowPartial', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  const { file, transfer, preview } = analyze(body.source);
  if (body.digest !== preview.digest) throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (typeof body.allowPartial !== 'boolean') throw new HttpError(400, 'RISU_PRESET_INVALID_FILE');
  if (!body.allowPartial && preview.findings.some((finding) => finding.level === 'unsupported'))
    throw new HttpError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  return store.transaction(() => {
    const receipt = applyNativeTransfer(store, {
      file,
      digest: transfer.digest,
      modelBindings: [],
      idempotencyKey: `risu-preset:${requestKey}`,
    });
    const saved = receipt.items.find(
      (item) => item.kind === 'prompt-preset' && item.key === 'prompt'
    )!;
    return { receipt, preset: store.product.get<PromptPreset>('prompt-preset', saved.id) };
  });
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
