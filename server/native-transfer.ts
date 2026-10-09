import type { FastifyInstance } from 'fastify';
import {
  NATIVE_TRANSFER_MAX_BYTES,
  type NativeTransferFile,
  type NativeTransferPrepare,
} from '../core/native-transfer.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';
import {
  exportResourceBundle,
  importResourceBundle,
  importNormalizedResourceBundle,
  inspectBundle,
} from './resource-bundle.js';
import { nativeTransferArchiveRoutes } from './native-transfer-archive.js';
import type { PreparedNativeTransferFile } from '../core/native-transfer-validation.js';

export const applyNativeTransfer = importResourceBundle;
export function prepareNativeTransfer(value: unknown): NativeTransferPrepare {
  const body = record(value);
  fields(body, ['file']);
  return inspectBundle(body.file);
}
export function exportNativeTransfer(store: Store, value: unknown): NativeTransferFile;
export function exportNativeTransfer(
  store: Store,
  value: unknown,
  metadataOnly: true
): PreparedNativeTransferFile;
export function exportNativeTransfer(
  store: Store,
  value: unknown,
  metadataOnly = false
): NativeTransferFile | PreparedNativeTransferFile {
  const body = record(value);
  fields(body, ['items']);
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 1000)
    throw new HttpError(400, '내보낼 자료를 선택해 주세요.');
  const items = body.items.map((value) => {
    const item = record(value);
    if (!['content', 'prompt-preset'].includes(item.kind))
      throw new HttpError(400, 'Invalid resource kind');
    return {
      kind: item.kind as 'content' | 'prompt-preset',
      id: text(item.id, 'resource ID', 100),
    };
  });
  return metadataOnly
    ? exportResourceBundle(store, items, true)
    : exportResourceBundle(store, items);
}

export function nativeTransferRoutes(app: FastifyInstance, store: Store) {
  nativeTransferArchiveRoutes(app, store, (value) => exportNativeTransfer(store, value, true));
  app.post('/api/native-transfers/export', (request) => exportNativeTransfer(store, request.body));
  app.post('/api/native-transfers/prepare', { bodyLimit: NATIVE_TRANSFER_MAX_BYTES }, (request) =>
    prepareNativeTransfer(request.body)
  );
  app.post('/api/native-transfers/apply', { bodyLimit: NATIVE_TRANSFER_MAX_BYTES }, (request) =>
    importNormalizedResourceBundle(store, request.body)
  );
}
