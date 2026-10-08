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
import './manuscript-search.css';

const labels: Record<SearchKind, string> = {
  original: '원문',
  translation: '번역',
  request: '요청',
};
export function ManuscriptSearchPanel({
  initialScope = 'workspace',
  chatId,
  botId,
  chats = [],
  library,
  folders = [],
  label = '원고 검색',
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
  onNavigate: (target: ReaderTarget) => void;
  onChat?: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [titleLimit, setTitleLimit] = useState(30);
  const [scope, setScope] = useState(initialScope);
  const [kinds, setKinds] = useState<SearchKind[]>(['original', 'translation', 'request']);
  const [result, setResult] = useState<ManuscriptSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
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
    <section className="manuscript-search" aria-label="원고와 채팅 찾기">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!composing) void run();
        }}
      >
        <div className="manuscript-search-input">
          <span className="manuscript-search-field">
            <SearchIcon size={18} aria-hidden="true" />
            <input
              type="search"
              aria-label={label}
              placeholder="제목·본문·번역·요청으로 찾기"
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
          <button type="submit" disabled={composing || busy || !query.trim() || !kinds.length}>
            검색
          </button>
        </div>
        <div className="manuscript-search-filters">
          <label className="manuscript-search-scope">
            <span className="manuscript-search-filter-label">검색 범위</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as ManuscriptSearchQuery['scope'])}
            >
              <option value="workspace">전체 작업실</option>
              {botId && <option value="bot">이 봇</option>}
              {chatId && <option value="chat">현재 채팅</option>}
            </select>
          </label>
          <fieldset className="manuscript-search-kinds">
            <legend>검색 대상</legend>
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
            {needle ? '제목 일치' : '채팅 제목'} {titleMatches.length}개
          </summary>
          <nav
            className="manuscript-search-title-results"
            aria-label={needle ? '제목 일치 결과' : '채팅 제목 목록'}
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
                    ? (folders.find((item) => item.id === chat.folderId)?.title ?? '기본 위치')
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
              채팅 제목 더 보기 · {titleMatches.length - titleLimit}개 남음
            </button>
          )}
        </details>
      )}
      {!needle && (
        <p className="muted">저장된 현재 원고를 찾아요. 따옴표로 감싸면 연속 문구를 찾아요.</p>
      )}
      {needle && !result && !busy && !error && (
        <p className="muted">짧은 이름도 검색할 수 있어요. Enter 또는 검색을 눌러 주세요.</p>
      )}
      {busy && <p role="status">원고를 찾고 있어요…</p>}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button type="button" onClick={() => void run()}>
            다시 검색
          </button>
        </p>
      )}
      {result && <h3 className="manuscript-search-result-heading">본문 검색 결과</h3>}
      <div className="manuscript-search-results">
        {result?.items.map((item) => (
          <article key={`${item.target.chatId}:${item.target.sourceId}`}>
            <h4>
              {item.title} · {item.sceneNumber ? `장면 ${item.sceneNumber}` : '첫 메시지'}
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
                  {labels[match.kind]} 장면 열기
                </button>
              </div>
            ))}
          </article>
        ))}
      </div>
      {result && !result.items.length && !result.nextCursor && (
        <p role="status">일치하는 원고가 없어요.</p>
      )}
      {result?.nextCursor && (
        <button type="button" disabled={busy} onClick={() => void run(result.nextCursor)}>
          계속 찾기 · 남은 원고 검색
        </button>
      )}
      {result?.coverage === 'building' && (
        <p className="muted">색인을 준비 중이에요. 최신 저장 본문을 직접 확인한 결과예요.</p>
      )}
    </section>
  );
}
