import { formatDate, t } from './i18n.js';

export function navigationTimeLabel(date: string) {
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return '';
  const elapsed = Date.now() - time;
  if (elapsed >= 0 && elapsed < 60000) return t('helpers.m257');
  if (elapsed >= 0 && elapsed < 3600000)
    return t('helpers.m258', { v0: Math.floor(elapsed / 60000) });
  if (elapsed >= 0 && elapsed < 86400000)
    return t('helpers.m259', { v0: Math.floor(elapsed / 3600000) });
  return formatDate(new Date(time), { year: 'numeric', month: 'numeric', day: 'numeric' });
}
