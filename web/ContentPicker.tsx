import { t, useI18n } from './i18n.js';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon, DropdownIcon, SearchIcon } from './ui-icons.js';
import type { ContentRole } from '../core/risu-content.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import type { Content, Library } from '../core/product.js';
import { ContentAvatar } from './ContentAvatar.js';
import { Dialog } from './Dialog.js';
import './content-picker.css';

const roleTitleKeys: Record<ContentRole, string> = {
  bot: 'library.bot',
  persona: 'library.persona',
  module: 'library.module',
};
const reference = (content: Content) => `${content.id}@${content.revision}`;

export function ContentPicker({
  library,
  value,
  onChange,
  role,
  label,
  describedBy,
  disabled = false,
  allowNone = false,
  noneLabel = t('library.none'),
  selectedContent,
  excludeIds = [],
}: {
  library: Library;
  value: string;
  onChange: (reference: string) => void;
  role: ContentRole;
  label: string;
  describedBy?: string;
  disabled?: boolean;
  allowNone?: boolean;
  noneLabel?: string;
  selectedContent?: Content | null;
  excludeIds?: string[];
}) {
  useI18n();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [all, setAll] = useState(false),
    [folder, setFolder] = useState('all'),
    [page, setPage] = useState({ key: '', count: 50 });
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const current =
    selectedContent && reference(selectedContent) === value
      ? selectedContent
      : library.contents.find((content) => reference(content) === value);
  const folders = (library.organization?.folders ?? [])
    .filter((item) => item.category !== 'prompts' && (all || item.category === role))
    .toSorted((a, b) => a.sortPosition - b.sortPosition || a.title.localeCompare(b.title));
  const activeFolder =
    folder === 'all' || folder === 'none' || folders.some((item) => item.id === folder)
      ? folder
      : 'all';
  const needle = query.trim().toLocaleLowerCase();
  const candidates = library.contents.filter((content) => {
    if (
      !(content.hasPackage || content.package || content.kind === role) ||
      excludeIds.includes(content.id)
    )
      return false;
    if (!all && libraryCategory(library, content) !== role) return false;
    const folderId = libraryFolderOf(library, { kind: 'content', id: content.id });
    if (
      activeFolder === 'none'
        ? folderId !== null
        : activeFolder !== 'all' && folderId !== activeFolder
    )
      return false;
    return `${content.title} ${content.description}`.toLocaleLowerCase().includes(needle);
  });
  const pageKey = `${role}:${all}:${activeFolder}:${needle}`;
  const visibleCount = page.key === pageKey ? page.count : 50;
  const visible = candidates.slice(0, visibleCount);
  const currentOutside = current && !visible.some((content) => reference(content) === value);
  const choose = (next: string) => {
    if (disabled) return;
    onChange(next);
    setOpen(false);
  };
  const emptyTitle = needle
    ? t('library.noResourcesMatchYourSearch')
    : activeFolder !== 'all'
      ? t('library.noResourcesInThisFolderCanBe')
      : t('library.noResourcesAreAvailableToAttach', { v0: t(roleTitleKeys[role]) });
  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    // Search text editing keeps its Home/End behavior; arrows enter the result list.
    if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return;
    const choices = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        '[data-content-choice]:not(:disabled)'
      ) ?? []),
    ];
    if (!choices.length) return;
    event.preventDefault();
    event.stopPropagation();
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % choices.length
            : index < 0
              ? choices.length - 1
              : (index - 1 + choices.length) % choices.length;
    choices[next].focus();
  }
  const renderChoice = (content: Content, pinned = false) => (
    <button
      key={reference(content)}
      type="button"
      className="secondary content-picker-choice"
      data-content-choice
      aria-pressed={reference(content) === value}
      disabled={disabled}
      onClick={() => choose(reference(content))}
    >
      <ContentAvatar content={content} />
      <span className="content-picker-copy">
        <strong title={content.title}>{content.title}</strong>
        {content.description && <small>{content.description}</small>}
        {(all || pinned) && (
          <small className="content-picker-meta">
            {all && t(roleTitleKeys[libraryCategory(library, content)])}
            {pinned ? t('library.currentSelectionV', { v0: content.revision }) : ''}
          </small>
        )}
      </span>
      {reference(content) === value ? <CheckIcon size={18} aria-hidden="true" /> : null}
    </button>
  );
  return (
    <div className="content-picker">
      <span id={`${id}-label`} className="content-picker-label">
        {label}
      </span>
      <button
        type="button"
        className="secondary content-picker-trigger"
        aria-label={label}
        aria-describedby={describedBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery('');
          setAll(false);
          setFolder('all');
          setPage({ key: '', count: 50 });
          setOpen(true);
        }}
      >
        {current && <ContentAvatar content={current} />}
        <span className="content-picker-current" title={current?.title}>
          {current?.title ??
            (value
              ? t('library.selectedResourceNeedsReview')
              : allowNone
                ? noneLabel
                : t('library.chooseResource'))}
        </span>
        <DropdownIcon size={16} />
      </button>
      <Dialog
        open={open}
        title={label}
        onClose={() => setOpen(false)}
        className="content-picker-dialog"
      >
        <div className="content-picker-filters">
          <div className="content-picker-scope" aria-label={t('library.resourceCategoryScope')}>
            <button
              type="button"
              className="secondary"
              aria-pressed={!all}
              onClick={() => {
                setAll(false);
                setFolder('all');
              }}
            >
              {t(roleTitleKeys[role])}
            </button>
            <button
              type="button"
              className="secondary"
              aria-pressed={all}
              onClick={() => {
                setAll(true);
                setFolder('all');
              }}
            >
              {t('library.allResources')}
            </button>
          </div>
          <label className="content-picker-search">
            <span className="sr-only">{t('library.search')}</span>
            <span className="content-picker-search-field">
              <SearchIcon size={17} aria-hidden="true" />
              <input
                type="search"
                aria-label={t('library.search2', { v0: label })}
                placeholder={t('library.searchByNameOrDescription2')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!event.nativeEvent.isComposing)
                      list.current
                        ?.querySelector<HTMLButtonElement>('[data-content-choice]')
                        ?.focus();
                    return;
                  }
                  moveFocus(event);
                }}
              />
            </span>
          </label>
          <label>
            <span className="content-picker-filter-label">{t('library.folders')}</span>
            <select
              aria-label={t('library.folders2', { v0: label })}
              value={activeFolder}
              onChange={(event) => setFolder(event.target.value)}
            >
              <option value="all">{t('library.allFolders')}</option>
              <option value="none">{t('library.uncategorized')}</option>
              {folders.map((item) => (
                <option key={item.id} value={item.id}>
                  {all
                    ? t('library.folderInCategory', {
                        category: t(roleTitleKeys[item.category as ContentRole]),
                        folder: item.title,
                      })
                    : item.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted content-picker-count" role="status">
          {t('library.candidateCount', { count: candidates.length })}
        </p>
        <div className="content-picker-results" ref={list} onKeyDown={moveFocus}>
          {allowNone && (
            <button
              type="button"
              className="secondary content-picker-choice"
              data-content-choice
              aria-pressed={!value}
              disabled={disabled}
              onClick={() => choose('')}
            >
              <span className="content-picker-copy">{noneLabel}</span>
              {!value && <CheckIcon size={18} aria-hidden="true" />}
            </button>
          )}
          {currentOutside && renderChoice(current, true)}
          {visible.map((content) =>
            renderChoice(reference(content) === value && current ? current : content)
          )}
          {!candidates.length && (
            <div className="content-picker-empty">
              <strong>{emptyTitle}</strong>
            </div>
          )}
        </div>
        {candidates.length > visibleCount && (
          <button
            type="button"
            className="secondary"
            onClick={() => setPage({ key: pageKey, count: visibleCount + 50 })}
          >
            {t('library.moreResources', {
              visible: Math.min(visibleCount, candidates.length),
              total: candidates.length,
            })}
          </button>
        )}
        {!candidates.length && !!needle && (
          <div className="content-picker-footer">
            <button type="button" className="ghost" onClick={() => setQuery('')}>
              {t('library.clearSearch')}
            </button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
