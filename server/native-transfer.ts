import type { NativeArchiveExport } from '#contracts/operations';
import type { NativeTransferPrepare } from '../core/native-transfer.js';
import type { PreparedNativeTransferFile } from '../core/native-transfer-validation.js';
import type { Store } from './store.js';
import { captureResourceBundle, importResourceBundle, inspectBundle } from './resource-bundle.js';

export const applyNativeTransfer = importResourceBundle;
export const prepareNativeTransfer = (input: { file: unknown }): NativeTransferPrepare =>
  inspectBundle(input.file);
export const captureTransferResources = (
  store: Store,
  input: NativeArchiveExport
): PreparedNativeTransferFile => captureResourceBundle(store, input.items, 'library');
