import type { Connection, ModelPreset } from '../core/product.js';

export function isModelSelectable(
  model: ModelPreset,
  latestModels: readonly ModelPreset[],
  currentConnections: readonly Pick<Connection, 'id' | 'enabled'>[]
): boolean {
  const latest = latestModels.find((item) => item.id === model.id);
  return Boolean(
    latest &&
      latest.enabled !== false &&
      currentConnections.some(
        (connection) => connection.id === latest.connectionId && connection.enabled
      )
  );
}

export function useModelSelection(
  models: readonly ModelPreset[],
  connections: readonly Pick<Connection, 'id' | 'enabled'>[]
) {
  const canSelect = (model: ModelPreset) => isModelSelectable(model, models, connections);
  return { canSelect, choices: models.filter(canSelect) };
}
