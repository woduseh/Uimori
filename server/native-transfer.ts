import type { FastifyInstance } from 'fastify';
import { NATIVE_TRANSFER_MAX_BYTES, type NativeTransferPrepare } from '../core/native-transfer.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';
import {
  captureResourceBundle,
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
function captureTransferResources(store: Store, value: unknown): PreparedNativeTransferFile {
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
  return captureResourceBundle(store, items);
}

export function nativeTransferRoutes(app: FastifyInstance, store: Store) {
  nativeTransferArchiveRoutes(app, store, (value) => captureTransferResources(store, value));
  app.post('/api/native-transfers/prepare', { bodyLimit: NATIVE_TRANSFER_MAX_BYTES }, (request) =>
    prepareNativeTransfer(request.body)
  );
  app.post('/api/native-transfers/apply', { bodyLimit: NATIVE_TRANSFER_MAX_BYTES }, (request) =>
    importNormalizedResourceBundle(store, request.body)
  );
}
