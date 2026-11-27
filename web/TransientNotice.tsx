import { useI18n } from './i18n.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckIcon } from './ui-icons.js';
import { formatUiMessage, type UiMessage } from './ui-message.js';
import './notices.css';

type Notice = { id: string; content: UiMessage; identity: string };
const NoticeContext = createContext<(id: string, content: UiMessage) => void>(() => {});
const identityOf = (content: UiMessage) => JSON.stringify(content);

export function TransientNoticeProvider({ children }: { children: ReactNode }) {
  useI18n();
  const [notices, setNotices] = useState<Notice[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const show = useCallback((id: string, content: UiMessage) => {
    const notice = { id, content, identity: identityOf(content) };
    clearTimeout(timers.current.get(notice.identity));
    setNotices((old) => {
      const kept = old.filter((item) => item.id !== notice.id || item.identity === notice.identity);
      return kept.some((item) => item.identity === notice.identity)
        ? kept.map((item) => (item.identity === notice.identity ? notice : item))
        : [...kept, notice];
    });
    timers.current.set(
      notice.identity,
      setTimeout(() => {
        timers.current.delete(notice.identity);
        setNotices((old) => old.filter((item) => item.identity !== notice.identity));
      }, 4000)
    );
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const node = host.current!;
    if (notices.length) {
      if (node.matches(':popover-open')) node.hidePopover();
      node.showPopover();
    } else if (node.matches(':popover-open')) node.hidePopover();
  }, [notices]);
  return (
    <NoticeContext value={show}>
      {children}
      <div ref={host} popover="manual" className="transient-notices" aria-live="polite">
        {notices.map((notice) => (
          <div className="transient-notice" role="status" key={notice.identity}>
            <CheckIcon size={18} aria-hidden="true" />
            <span>{formatUiMessage(notice.content)}</span>
          </div>
        ))}
      </div>
    </NoticeContext>
  );
}

export function useTransientNotice() {
  const id = useId();
  const show = useContext(NoticeContext);
  return useCallback((content: UiMessage) => show(id, content), [id, show]);
}

export function TransientNotice({ content }: { content: UiMessage | null | undefined }) {
  useI18n();
  const id = useId();
  const show = useContext(NoticeContext);
  const identity = content ? identityOf(content) : '';
  const latest = useRef(content);
  latest.current = content;
  useEffect(() => {
    if (identity && latest.current) show(id, latest.current);
  }, [id, identity, show]);
  return null;
}
