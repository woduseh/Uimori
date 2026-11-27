import { copyTitle } from '../core/copy-title.js';
import { t } from './i18n.js';

export const copiedTitle = (title: string, limit: number): string =>
  copyTitle(title, t('shared.copySuffix'), limit);
