import { t, useI18n, translateMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { ReaderTarget } from '../core/reader-target.js';
import type {
  ManuscriptSearchQuery,
  ManuscriptSearchResult,
  SearchKind,
} from '../core/manuscript-search.js';
import type { Chat } from '../core/types.js';
import type { Library, ChatFolder } from '../core/product.js';
import { api } from './api.js';
import { CheckIcon, SearchIcon } from './ui-icons.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import './manuscript-search.css';

const searchLabels = (): Record<SearchKind, string> => ({
  original: t('transfer.m195'),
  translation: t('transfer.m209'),
  request: t('transfer.m210'),
});
export function ManuscriptSearchPanel({
  initialScope = 'workspace',
  chatId,
  botId,
  chats = [],
  library,
  folders = [],
  label = t('transfer.m211'),
  query: suppliedQuery,
  queryComposing = false,
  hideQueryInput = false,
  formId,
  onNavigate,
  onChat,
}: {
  initialScope?: ManuscriptSearchQuery['scope'];
  chatId?: string;
  botId?: string;
  chats?: Chat[];
  library?: Library | null;
  folders?: ChatFolder[];
  label?: string;
  /** A containing search dialog can own one query across different result kinds. */
  query?: string;
  queryComposing?: boolean;
  hideQueryInput?: boolean;
  formId?: string;
  onNavigate: (target: ReaderTarget) => void;
  onChat?: (id: string) => void;
}) {
  useI18n();
  const labels = searchLabels();
  const [localQuery, setQuery] = useState('');
  const query = suppliedQuery ?? localQuery;
  const [titleLimit, setTitleLimit] = useState(30);
  const [scope, setScope] = useState(initialScope);
  const [kinds, setKinds] = useState<SearchKind[]>(['original', 'translation', 'request']);
  const [result, setResult] = useState<ManuscriptSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localComposing, setComposing] = useState(false);
  const composing = localComposing || queryComposing;
  const currentRequest = useRef<AbortController | null>(null);
  const latest = useRef({ query, scope, kinds });
  latest.current = { query, scope, kinds };
  const signature = JSON.stringify([query, scope, kinds]);
  const run = async (cursor: string | null = null) => {
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    const value = latest.current;
    if (!value.query.trim() || !value.kinds.length) {
      setResult(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await api<ManuscriptSearchResult>(
        '/search',
        { ...value, chatId, botId, cursor, limit: 20 },
        'POST',
        controller.signal
      );
      if (controller.signal.aborted) return;
      setResult((old) =>
        cursor && old ? { ...next, items: [...old.items, ...next.items] } : next
      );
    } catch (caught) {
      if (!controller.signal.aborted) setError((caught as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const execute = useRef(run);
  execute.current = run;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed search identity cancels old work; callbacks read that same identity through refs.
  useEffect(() => {
    currentRequest.current?.abort();
    setResult(null);
    setTitleLimit(query.trim() ? 5 : 30);
    setError('');
    setBusy(false);
    if (composing || [...query.trim()].length < 3) return;
    const timer = setTimeout(() => void execute.current(), 300);
    return () => {
      clearTimeout(timer);
      currentRequest.current?.abort();
    };
  }, [signature, composing]);
  useEffect(() => () => currentRequest.current?.abort(), []);
  const needle = query.trim().normalize('NFC').toLowerCase();
  const titleMatches = chats.filter(
    (chat) =>
      (!chatId || scope !== 'chat' || chat.id === chatId) &&
      (!botId || scope !== 'bot' || chat.botId === botId) &&
      (!needle ||
        `${chat.title} ${library?.contents.find((item) => item.id === chat.botId)?.title ?? ''}`
          .normalize('NFC')
          .toLowerCase()
          .includes(needle))
  );
  return (
    <section className="manuscript-search" aria-label={t('transfer.m212')}>
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!composing) void run();
        }}
      >
        <div className="manuscript-search-input">
          {!hideQueryInput && (
            <span className="manuscript-search-field">
              <SearchIcon size={18} aria-hidden="true" />
              <input
                type="search"
                aria-label={label}
                placeholder={t('transfer.m213')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Escape' ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  const dialog = event.currentTarget.closest('dialog');
                  if (!dialog) return;
                  // Chromium's search input otherwise consumes Escape just to clear text,
                  // leaving the modal open and the underlying navigation inert.
                  event.preventDefault();
                  event.stopPropagation();
                  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
              />
            </span>
          )}
          <button type="submit" disabled={composing || busy || !query.trim() || !kinds.length}>
            {t('transfer.m214')}
          </button>
        </div>
        <div className="manuscript-search-filters">
          {(botId || chatId) && (
            <label className="manuscript-search-scope">
              <span className="sr-only">{t('transfer.m215')}</span>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as ManuscriptSearchQuery['scope'])}
              >
                <option value="workspace">{t('transfer.m216')}</option>
                {botId && <option value="bot">{t('transfer.m217')}</option>}
                {chatId && <option value="chat">{t('transfer.m218')}</option>}
              </select>
            </label>
          )}
          <fieldset className="manuscript-search-kinds">
            <legend className="sr-only">{t('transfer.m219')}</legend>
            <div className="manuscript-search-kind-options">
              {(['original', 'translation', 'request'] as const).map((kind) => (
                <button
                  type="button"
                  className="secondary manuscript-search-kind"
                  aria-pressed={kinds.includes(kind)}
                  key={kind}
                  onClick={() =>
                    setKinds((old) =>
                      old.includes(kind) ? old.filter((value) => value !== kind) : [...old, kind]
                    )
                  }
                >
                  <CheckIcon size={16} aria-hidden="true" />
                  {labels[kind]}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </form>
      {onChat && !!titleMatches.length && (
        <details className="manuscript-search-titles" data-searching={!!needle} open>
          <summary>
            {t('transfer.titleCount', { matching: !!needle, count: titleMatches.length })}
          </summary>
          <nav
            className="manuscript-search-title-results"
            aria-label={needle ? t('transfer.m222') : t('transfer.m223')}
          >
            {titleMatches.slice(0, titleLimit).map((chat) => (
              <button
                type="button"
                className="secondary manuscript-search-title-choice"
                data-chat-id={chat.id}
                key={chat.id}
                onClick={() => onChat(chat.id)}
              >
                <strong>{chat.title}</strong>
                <small>
                  {scope === 'bot'
                    ? (folders.find((item) => item.id === chat.folderId)?.title ??
                      t('transfer.m224'))
                    : library?.contents.find((item) => item.id === chat.botId)?.title}
                </small>
              </button>
            ))}
          </nav>
          {titleMatches.length > titleLimit && (
            <button
              className="secondary"
              type="button"
              onClick={() => setTitleLimit((old) => old + (needle ? 5 : 30))}
            >
              {t('transfer.moreTitles', { count: titleMatches.length - titleLimit })}
            </button>
          )}
        </details>
      )}
      {!kinds.length && (
        <p className="muted" role="status">
          {t('transfer.m227')}
        </p>
      )}
      {!needle && kinds.length > 0 && <p className="muted">{t('transfer.m228')}</p>}
      {busy && <LoadingState presentation="inline" label={t('transfer.m230')} />}
      {error && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" className="secondary" onClick={() => void run()}>
              {t('transfer.m231')}
            </button>
          }
        >
          {translateMessage(error)}
        </NoticeBanner>
      )}
      {result && <h3 className="manuscript-search-result-heading">{t('transfer.m232')}</h3>}
      <div className="manuscript-search-results">
        {result?.items.map((item) => (
          <article key={`${item.target.chatId}:${item.target.sourceId}`}>
            <h4 className="ui-meta-row">
              <span>{item.title}</span>
              <span>
                {item.sceneNumber
                  ? t('transfer.d011', { v0: item.sceneNumber })
                  : t('transfer.m029')}
              </span>
            </h4>
            {item.matches.map((match) => (
              <div key={match.kind}>
                <span className="muted">{labels[match.kind]}</span>
                <p>
                  {match.snippet.map((part, index) =>
                    part.match ? (
                      <mark key={index}>{part.text}</mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    )
                  )}
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    onNavigate({
                      ...item.target,
                      representation: match.kind === 'translation' ? 'translation' : 'original',
                      contentHash: match.kind === 'request' ? undefined : match.contentHash,
                    })
                  }
                >
                  {t('transfer.openScene', { kind: match.kind })}
                </button>
              </div>
            ))}
          </article>
        ))}
      </div>
      {result && !result.items.length && !result.nextCursor && (
        <p role="status">{t('transfer.m234')}</p>
      )}
      {result?.nextCursor && (
        <button type="button" disabled={busy} onClick={() => void run(result.nextCursor)}>
          {t('transfer.m235')}
        </button>
      )}
      {result?.coverage === 'building' && <p className="muted">{t('transfer.m236')}</p>}
    </section>
  );
}
