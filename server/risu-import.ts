import { risuEndpoints, RISU_IMPORT_BODY_LIMIT } from '#contracts';
import { applyRisuCommand } from './commands/risu-import.js';
import { executeOperation } from './command.js';
import { registerCommand } from './endpoint.js';
import { createStorePorts } from './store-ports.js';
import { prepareStoredRisuImport, discardPreparedRisuImport } from './risu-import-prepared.js';
import type { FastifyInstance } from 'fastify';
import type { RisuImportKind, RisuImportPreview } from '../core/risu-import.js';
import { readCharacterCard } from './character-card-file.js';
import { deleteUpload } from './uploads.js';
import { fields, record } from './request-validation.js';
import { analyzeNativeRisuImport } from './risu-native-import.js';
import type { Store } from './store.js';
import { AppError } from './app-errors.js';

function analyze(
  value: unknown,
  requestedKind?: RisuImportKind,
  readStaged?: (uploadId: string) => Buffer
) {
  return analyzeNativeRisuImport(readCharacterCard(value, requestedKind, readStaged));
}

export function prepareRisuImport(
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): RisuImportPreview {
  const body = record(value);
  fields(body, ['source', 'kind']);
  return analyze(body.source, body.kind as RisuImportKind | undefined, readStaged).preview;
}

export function discardRisuImport(dbPath: string, value: unknown) {
  const body = record(value);
  fields(body, ['preparedId', 'uploadId']);
  for (const id of [body.preparedId, body.uploadId]) {
    if (id !== undefined && (typeof id !== 'string' || !/^[a-f0-9]{32}$/u.test(id)))
      throw new AppError(400, 'RISU_IMPORT_INVALID_FILE');
  }
  if (body.preparedId !== undefined) discardPreparedRisuImport(dbPath, body.preparedId);
  if (body.uploadId !== undefined) {
    try {
      deleteUpload(dbPath, body.uploadId);
    } catch {}
  }
  return { discarded: true };
}

export function applyRisuImport(store: Store, value: unknown, readStaged?: (id: string) => Buffer) {
  return executeOperation(
    applyRisuCommand,
    createStorePorts(store, { readStaged }),
    value
  ) as Promise<import('../core/risu-import.js').RisuImportResult>;
}

export function risuImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = RISU_IMPORT_BODY_LIMIT;

  app.post('/api/risu-imports/discard', async (request) =>
    discardRisuImport(store.path, request.body)
  );
  app.post('/api/risu-imports/prepare', { bodyLimit }, async (request, reply) => {
    const abort = new AbortController();
    const closed = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once('close', closed);
    try {
      return await prepareStoredRisuImport(store.path, request.body, abort.signal);
    } finally {
      reply.raw.removeListener('close', closed);
    }
  });
  registerCommand(app, risuEndpoints.apply, applyRisuCommand, createStorePorts(store), (result) =>
    result.receipt.created ? 201 : 200
  );
}
