import type { Store } from './store.js';
import { AppError } from './app-errors.js';

export function assertAppearanceTargetLive(
  store: Store,
  scope: 'global' | 'bot' | 'chat',
  targetId: string
) {
  const gone =
    scope === 'bot'
      ? store.product.isHidden('content', targetId) ||
        !store.db.prepare("SELECT 1 FROM versions WHERE kind='content' AND id=?").get(targetId)
      : scope === 'chat' && !store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(targetId);
  if (gone) throw new AppError(409, 'REVISION_CONFLICT');
}
