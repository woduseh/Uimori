import { t, useI18n } from './i18n.js';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Dialog } from './Dialog.js';
import { SearchIcon } from './ui-icons.js';
import { isApplePlatform } from './ChatComposer.js';
import { useShortcutBindings, useShortcutsEnabled } from './shortcuts.js';
import { shortcutKeyLabel, type ShortcutAction } from './shortcut-bindings.js';
import './command-palette.css';

export type PaletteGroup = 'commands' | 'chats' | 'resources' | 'settings';
export type PaletteEntry = {
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  terms?: string;
  icon?: LucideIcon;
  shortcut?: ShortcutAction;
  run: () => void;
};
type PaletteOption = Pick<PaletteEntry, 'id' | 'label' | 'detail' | 'icon' | 'shortcut' | 'run'>;
type PaletteSection = {
  group: PaletteGroup | 'manuscript';
  label: string;
  options: PaletteOption[];
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
  const bindings = useShortcutBindings();
  const shortcutsEnabled = useShortcutsEnabled();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [composing, setComposing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setActive(0);
    }
  }
  const pending = useRef<(() => void) | null>(null);
  const revealActive = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const needle = searchable(query.trim());
  const groupLabels: Record<PaletteGroup, string> = {
    commands: t('palette.commands'),
    chats: t('palette.chats'),
    resources: t('palette.resources'),
    settings: t('palette.settings'),
  };
  const manuscript: PaletteSection = {
    group: 'manuscript',
    label: t('palette.manuscript'),
    options: [
      {
        id: 'manuscript-search',
        label: query.trim()
          ? t('palette.searchManuscriptFor', { query: query.trim() })
          : t('palette.searchManuscript'),
        icon: SearchIcon,
        shortcut: 'search.open',
        run: () => onSearch(query.trim()),
      },
    ],
  };
  const sections = [
    ...groups.map<PaletteSection>((group) => ({
      group,
      label: groupLabels[group],
      options: entries
        .filter(
          (entry) =>
            entry.group === group &&
            (!needle ||
              searchable(`${entry.label} ${entry.detail ?? ''} ${entry.terms ?? ''}`).includes(
                needle
              ))
        )
        .slice(0, needle ? searchLimit : browseLimits[group]),
    })),
    manuscript,
  ].filter((section) => section.options.length);
  const options = sections.flatMap((section) => section.options);
  const sectionStarts = sections.map((_, index) =>
    sections.slice(0, index).reduce((count, section) => count + section.options.length, 0)
  );
  const activeIndex = Math.min(active, options.length - 1);
  useLayoutEffect(() => {
    if (!open || !revealActive.current) return;
    revealActive.current = false;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  });
  const choose = (option: PaletteOption | undefined) => {
    if (!option) return;
    pending.current = option.run;
    onClose();
  };
  const moveActive = (index: number) => {
    revealActive.current = true;
    setActive(index);
  };
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
            node?.setAttribute('autofocus', '');
          }}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={optionId(activeIndex)}
          aria-label={t('palette.search')}
          placeholder={t('palette.search')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            moveActive(0);
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
            const last = options.length - 1;
            const next =
              event.key === 'ArrowDown'
                ? activeIndex >= last
                  ? 0
                  : activeIndex + 1
                : event.key === 'ArrowUp'
                  ? activeIndex <= 0
                    ? last
                    : activeIndex - 1
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? last
                      : null;
            if (next !== null) {
              event.preventDefault();
              moveActive(next);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(options[activeIndex]);
            }
          }}
        />
      </span>
      <div
        className="command-palette-results"
        id={listId}
        role="listbox"
        aria-label={t('palette.title')}
      >
        {sections.map((section, sectionIndex) => {
          const headingId = `${baseId}-${section.group}`;
          const start = sectionStarts[sectionIndex];
          return (
            <div key={section.group} role="group" aria-labelledby={headingId}>
              <div className="command-palette-heading" id={headingId} role="presentation">
                {section.label}
              </div>
              {section.options.map((option, position) => {
                const index = start + position;
                const Icon = option.icon;
                const keys =
                  option.shortcut && shortcutsEnabled
                    ? shortcutKeyLabel(bindings[option.shortcut], isApplePlatform())
                    : '';
                return (
                  <div
                    key={option.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="command-palette-choice"
                    onPointerMove={(event) => {
                      const last = pointer.current;
                      pointer.current = { x: event.clientX, y: event.clientY };
                      if (last?.x === event.clientX && last.y === event.clientY) return;
                      if (index !== activeIndex) setActive(index);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    <span className="command-palette-icon">
                      {Icon && <Icon size={18} aria-hidden="true" />}
                    </span>
                    <span className="command-palette-label">{option.label}</span>
                    {option.detail && <small>{option.detail}</small>}
                    {keys && <kbd aria-hidden="true">{keys}</kbd>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
