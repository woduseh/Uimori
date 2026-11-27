import { HttpError } from './request-validation.js';
import { AppError } from './app-errors.js';
import type { Connection, ModelRef, ModelPreset } from '../core/product.js';
import type { ProductStore } from './product-store.js';

export function assertModelSelection(
  store: ProductStore,
  next: ModelRef | null,
  previous: ModelRef | null = null
): void {
  if (!next) return;
  let latest: ModelPreset;
  let connection: Connection;
  try {
    store.assertAvailable('model', next.id);
    latest = store.get<ModelPreset>('model', next.id);
    store.assertAvailable('connection', latest.connectionId);
    connection = store.get<Connection>('connection', latest.connectionId);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404)
      throw new AppError(409, 'MODEL_SELECTION_UNAVAILABLE');
    throw error;
  }
  if (previous?.id === next.id) return;
  if (latest.enabled === false || !connection.enabled)
    throw new AppError(400, 'MODEL_SELECTION_UNAVAILABLE');
}
