import { t, useI18n } from './i18n.js';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from './Dialog.js';
import { SearchIcon } from './ui-icons.js';
import './command-palette.css';

export type PaletteGroup = 'commands' | 'chats' | 'resources' | 'settings';
export type PaletteEntry = {
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  terms?: string;
  run: () => void;
};

const groups: PaletteGroup[] = ['commands', 'chats', 'resources', 'settings'];
const browseLimits: Record<PaletteGroup, number> = {
  commands: 20,
  chats: 8,
  resources: 8,
  settings: 20,
};
const searchLimit = 20;
const searchable = (value: string) => value.normalize('NFC').toLocaleLowerCase();

export function CommandPalette({
  open,
  entries,
  onClose,
  onSearch,
}: {
  open: boolean;
  entries: PaletteEntry[];
  onClose: () => void;
  onSearch: (query: string) => void;
}) {
  useI18n();
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setQuery('');
  }
  const pending = useRef<(() => void) | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = searchable(query.trim());
  const sections = groups
    .map((group) => ({
      group,
      entries: entries
        .filter(
          (entry) =>
            entry.group === group &&
            (!needle ||
              searchable(`${entry.label} ${entry.detail ?? ''} ${entry.terms ?? ''}`).includes(
                needle
              ))
        )
        .slice(0, needle ? searchLimit : browseLimits[group]),
    }))
    .filter((section) => section.entries.length);
  const groupLabels: Record<PaletteGroup, string> = {
    commands: t('palette.commands'),
    chats: t('palette.chats'),
    resources: t('palette.resources'),
    settings: t('palette.settings'),
  };
  const choose = (run: () => void) => {
    pending.current = run;
    onClose();
  };
  const choices = () => [
    ...(list.current?.querySelectorAll<HTMLButtonElement>('[data-palette-choice]') ?? []),
  ];
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = choices();
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowUp' && index <= 0) {
      input.current?.focus();
      return;
    }
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(index + 1, items.length - 1)
            : index - 1;
    items[next].focus();
  };
  const renderChoice = (entry: Pick<PaletteEntry, 'id' | 'label' | 'detail' | 'run'>) => (
    <button
      key={entry.id}
      type="button"
      className="secondary command-palette-choice"
      data-palette-choice
      onClick={() => choose(entry.run)}
    >
      <span>{entry.label}</span>
      {entry.detail && <small>{entry.detail}</small>}
    </button>
  );
  return (
    <Dialog
      open={open}
      title={t('palette.title')}
      className="command-palette-dialog"
      onClose={() => {
        pending.current = null;
        onClose();
      }}
      onAfterClose={() => {
        const run = pending.current;
        pending.current = null;
        run?.();
      }}
    >
      <span className="command-palette-field">
        <SearchIcon size={18} aria-hidden="true" />
        <input
          ref={(node) => {
            input.current = node;
            node?.setAttribute('autofocus', '');
          }}
          type="text"
          aria-label={t('palette.search')}
          placeholder={t('palette.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              choices()[0]?.click();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              choices()[0]?.focus();
            }
          }}
        />
      </span>
      <div className="command-palette-results" ref={list} onKeyDown={moveFocus}>
        {sections.map((section) => (
          <section key={section.group} aria-label={groupLabels[section.group]}>
            <h3>{groupLabels[section.group]}</h3>
            {section.entries.map(renderChoice)}
          </section>
        ))}
        <section aria-label={t('palette.manuscript')}>
          <h3>{t('palette.manuscript')}</h3>
          {renderChoice({
            id: 'manuscript-search',
            label: query.trim()
              ? t('palette.searchManuscriptFor', { query: query.trim() })
              : t('palette.searchManuscript'),
            run: () => onSearch(query.trim()),
          })}
        </section>
      </div>
    </Dialog>
  );
}
