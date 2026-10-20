import { t, useI18n } from './i18n.js';
import type { ReaderDetail } from '../core/types.js';

export function ReaderPages({
  detail,
  head,
  onSelect,
  end = false,
}: {
  detail: ReaderDetail | null;
  head: string | null;
  onSelect: (id: string) => void;
  end?: boolean;
}) {
  useI18n();
  const page = detail?.reader;
  if (!page || (!page.previous && !page.next)) return null;
  return (
    <nav
      className="reader-pages"
      aria-label={end ? t('reader.endOfManuscriptSection') : t('reader.manuscriptSection')}
    >
      <button
        className="secondary"
        disabled={!page.previous}
        onClick={() => onSelect(page.previous!)}
      >
        {t('reader.previousManuscript')}
      </button>
      <span>
        {page.start + 1}–{page.start + page.order.length} / {page.total}
      </span>
      <button className="secondary" disabled={!page.next} onClick={() => onSelect(page.next!)}>
        {t('reader.nextManuscript')}
      </button>
      <button
        className="secondary"
        disabled={!page.latest || (!!head && page.order.includes(head))}
        onClick={() => onSelect(page.latest!)}
      >
        {t('reader.latestManuscript')}
      </button>
    </nav>
  );
}
