import { t } from './i18n.js';
import type { Library, ModelPreset } from '../core/product.js';

export function modelLabel(model: ModelPreset, library: Library | null) {
  const connection = library?.connections.find((item) => item.id === model.connectionId);
  return `${model.title} (${connection?.title ?? t('reader.checkProvider')})`;
}
