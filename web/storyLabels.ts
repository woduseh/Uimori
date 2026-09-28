import type { Library, ModelPreset } from '../core/product.js';

/** One naming everywhere: preset title, then the connection title; model IDs stay in the editor. */
export function modelLabel(model: ModelPreset, library: Library | null) {
  const connection = library?.connections.find((item) => item.id === model.connectionId);
  return `${model.title} · ${connection?.title ?? '프로바이더 확인 필요'}`;
}
