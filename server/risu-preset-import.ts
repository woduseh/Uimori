import type { FastifyInstance } from 'fastify';
import { risuPresetEndpoints, RISU_IMPORT_BODY_LIMIT } from '#contracts';
import { applyRisuPresetCommand } from './commands/risu-preset-import.js';
import { executeOperation } from './command.js';
import { registerCommand } from './endpoint.js';
import { analyzeRisuPreset } from './risu-preset-analysis.js';
import { fields, record } from './request-validation.js';
import type { Store } from './store.js';
import { createStorePorts } from './store-ports.js';

export function prepareRisuPresetImport(value: unknown) {
  const body = record(value);
  fields(body, ['source']);
  return analyzeRisuPreset(body.source).preview;
}

export function applyRisuPresetImport(store: Store, value: unknown) {
  return executeOperation(applyRisuPresetCommand, createStorePorts(store), value) as Promise<
    import('../core/risu-preset.js').RisuPresetImportResult
  >;
}

export function risuPresetImportRoutes(app: FastifyInstance, store: Store) {
  app.post(
    '/api/risu-preset-imports/prepare',
    { bodyLimit: RISU_IMPORT_BODY_LIMIT },
    async (request) => prepareRisuPresetImport(request.body)
  );
  registerCommand(app, risuPresetEndpoints.apply, applyRisuPresetCommand, createStorePorts(store));
}
