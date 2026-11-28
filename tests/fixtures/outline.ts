import type { OutlineCreatedNode, OutlineOperation } from '#contracts';
import { createStorePorts } from '../../server/store-ports.js';
import type { Store } from '../../server/store.js';

export function seedOutline(
  store: Store,
  chatId: string,
  operations: readonly OutlineOperation[]
): OutlineCreatedNode[] {
  const ports = createStorePorts(store);
  return ports.tx.transaction((tx) => ports.outline.applyBatch(tx, chatId, operations));
}
