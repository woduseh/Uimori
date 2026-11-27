import type { Store } from './store.js';
import { AppError } from './app-errors.js';

export function assertAppearanceTargetLive(
  store: Store,
  scope: 'global' | 'bot' | 'chat',
  targetId: string
) {
  if (scope === 'chat') store.writableChat(targetId);
  else if (scope === 'bot' && !store.product.isLive('content', targetId))
    throw new AppError(409, 'REVISION_CONFLICT');
}
