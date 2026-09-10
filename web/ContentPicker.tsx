import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon, DropdownIcon, SearchIcon } from './ui-icons.js';
import type { PackageRole } from '../core/content-package.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import type { Content, Library } from '../core/product.js';
import { ContentAvatar } from './ContentAvatar.js';
import { Dialog } from './Dialog.js';
import './content-picker.css';

const roleTitles: Record<PackageRole, string> = { bot: '봇', persona: '페르소나', module: '모듈' };
const reference = (content: Content) => `${content.id}@${content.revision}`;

export function ContentPicker({
  library,
  value,
  onChange,
  role,
  label,
  disabled = false,
  allowNone = false,
  noneLabel = '없음',
  selectedContent,
  excludeIds = [],
}: {
  library: Library;
  value: string;
  onChange: (reference: string) => void;
  role: PackageRole;
  label: string;
  disabled?: boolean;
  allowNone?: boolean;
  noneLabel?: string;
  selectedContent?: Content | null;
  excludeIds?: string[];
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [all, setAll] = useState(false),
    [folder, setFolder] = useState('all'),
    [page, setPage] = useState({ key: '', count: 50 });
  const id = useId();
  const allowAll = role !== 'persona';
  const list = useRef<HTMLDivElement>(null);
  const current =
    selectedContent && reference(selectedContent) === value
      ? selectedContent
      : library.contents.find((content) => reference(content) === value);
  const folders = (library.organization?.folders ?? [])
    .filter((item) => item.category !== 'prompts' && ((allowAll && all) || item.category === role))
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
    if ((!allowAll || !all) && libraryCategory(library, content) !== role) return false;
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
  const currentOutside =
    current &&
    (allowAll || libraryCategory(library, current) === role) &&
    !visible.some((content) => reference(content) === value);
  const choose = (next: string) => {
    if (disabled) return;
    onChange(next);
    setOpen(false);
  };
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
        <small className="content-picker-meta">
          {roleTitles[libraryCategory(library, content)]}
          {pinned ? ` · 현재 선택 v${content.revision}` : ''}
        </small>
      </span>
      {reference(content) === value ? (
        <CheckIcon size={18} aria-hidden="true" />
      ) : (
        <span className="content-picker-action">{roleTitles[role]}로 사용</span>
      )}
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
            (value ? '선택한 자료 확인 필요' : allowNone ? noneLabel : '자료 선택')}
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
          {allowAll && (
            <div className="content-picker-scope" aria-label="자료 분류 범위">
              <button
                type="button"
                className="secondary"
                aria-pressed={!all}
                onClick={() => {
                  setAll(false);
                  setFolder('all');
                }}
              >
                {roleTitles[role]}
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
                모든 자료
              </button>
            </div>
          )}
          <label className="content-picker-search">
            <SearchIcon size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label={`${label} 검색`}
              placeholder="이름 또는 설명으로 검색"
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
          </label>
          <label>
            폴더
            <select
              aria-label={`${label} 폴더`}
              value={activeFolder}
              onChange={(event) => setFolder(event.target.value)}
            >
              <option value="all">전체 폴더</option>
              <option value="none">미분류</option>
              {folders.map((item) => (
                <option key={item.id} value={item.id}>
                  {all ? `${roleTitles[item.category as PackageRole]} / ` : ''}
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted content-picker-count" role="status">
          {candidates.length}개 자료 · {roleTitles[role]}로 사용해요.
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
          {!candidates.length && <p className="muted">조건에 맞는 자료가 없어요.</p>}
        </div>
        {candidates.length > visibleCount && (
          <button
            type="button"
            className="secondary"
            onClick={() => setPage({ key: pageKey, count: visibleCount + 50 })}
          >
            자료 더 보기 ({Math.min(visibleCount, candidates.length)} / {candidates.length})
          </button>
        )}
        {allowAll && !all && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setAll(true);
              setFolder('all');
            }}
          >
            다른 분류의 자료도 찾기
          </button>
        )}
        {activeFolder !== 'all' && (
          <button type="button" className="ghost" onClick={() => setFolder('all')}>
            전체 폴더에서 찾기
          </button>
        )}
      </Dialog>
    </div>
  );
}
