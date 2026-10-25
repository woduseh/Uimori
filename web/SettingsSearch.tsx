import type { Ref } from 'react';
import { t, useI18n } from './i18n.js';

export function settingsSearchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
}

export function matchesSettingsSearch(value: string, query: string) {
  const text = settingsSearchText(value);
  return query
    .trim()
    .split(/[\s/·-]+/)
    .filter(Boolean)
    .every((term) => text.includes(settingsSearchText(term)));
}

export function hasSettingsSearch(value: string) {
  return settingsSearchText(value).replace(/[/·-]/g, '').length > 0;
}

export function SettingsSearch({
  value,
  onChange,
  inputRef,
  items,
  onSelect,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  items: readonly { id: string; label: string; terms?: string }[];
  onSelect: (id: string) => void;
  className?: string;
}) {
  useI18n();
  const results = items.filter((item) =>
    matchesSettingsSearch(`${item.label} ${item.terms ?? ''}`, value)
  );
  return (
    <div className={className}>
      <input
        ref={inputRef}
        type="search"
        className="settings-search"
        aria-label={t('chatsettings.m54')}
        placeholder={t('chatsettings.m54')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hasSettingsSearch(value) && (
        <div className="settings-search-results" aria-label={t('chatsettings.m56')}>
          {results.length ? (
            results.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  onSelect(item.id);
                  onChange('');
                }}
              >
                <span>{item.label}</span>
              </button>
            ))
          ) : (
            <p className="muted" role="status">
              {t('chatsettings.m57')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
