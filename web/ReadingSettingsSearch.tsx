import { useRef, useState, type ReactNode } from 'react';
import { t, useI18n } from './i18n.js';
import { SettingsSearch, hasSettingsSearch } from './SettingsSearch.js';

/** Search labels only; the existing controls keep their state and save owners. */
export function ReadingSettingsSearch({
  searchable,
  children,
}: {
  searchable: boolean;
  children: ReactNode;
}) {
  useI18n();
  const [search, setSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const items = [
    { id: 'font', label: t('main.m029'), terms: `${t('main.m030')} ${t('main.m031')}` },
    { id: 'size', label: t('main.m032'), terms: t('reader.sizeSearchTerms') },
    { id: 'width', label: t('main.m033') },
    { id: 'navigator', label: t('main.m039'), terms: t('main.m037') },
    { id: 'response', label: t('main.m042'), terms: `${t('main.m044')} ${t('main.m045')}` },
    {
      id: 'language',
      label: t('main.m047'),
      terms: `${t('main.m046')} ${t('main.m049')} ${t('main.m050')}`,
    },
    { id: 'illustrations', label: t('main.m052'), terms: t('main.m051') },
    {
      id: 'style',
      label: t('reader.readingStyle'),
      terms: `${t('reader.relaxed')} ${t('reader.dialogueFocused')}`,
    },
    { id: 'emphasis', label: t('reader.quoteEmphasis') },
    { id: 'line-spacing', label: t('reader.lineSpacing') },
    { id: 'paragraph-spacing', label: t('reader.paragraphSpacing') },
    { id: 'dialogue', label: t('reader.dialogueLineBreaks') },
    { id: 'thought', label: t('reader.thoughtLineBreaks') },
    { id: 'punctuation', label: t('reader.styleByPunctuation') },
    { id: 'reset', label: t('reader.resetReadingStyle') },
  ];
  function select(id: string) {
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(`[data-reading-setting="${id}"]`);
      if (!target) return;
      const details = target.closest('details');
      if (details) details.open = true;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
    });
  }
  return (
    <div className="settings-stack reading-preferences" ref={root}>
      {searchable && (
        <SettingsSearch value={search} onChange={setSearch} items={items} onSelect={select} />
      )}
      <div
        className="settings-stack reading-settings-content"
        hidden={searchable && hasSettingsSearch(search)}
      >
        {children}
      </div>
    </div>
  );
}
