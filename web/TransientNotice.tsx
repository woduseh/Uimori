import { translateMessage, useI18n } from './i18n.js';
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
import './notices.css';

type Notice = { id: string; message: string };
const NoticeContext = createContext<(notice: Notice) => void>(() => {});

export function TransientNoticeProvider({ children }: { children: ReactNode }) {
  useI18n();
  const [notices, setNotices] = useState<Notice[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const show = useCallback((notice: Notice) => {
    clearTimeout(timers.current.get(notice.message));
    setNotices((old) => {
      const kept = old.filter((item) => item.id !== notice.id || item.message === notice.message);
      return kept.some((item) => item.message === notice.message)
        ? kept.map((item) => (item.message === notice.message ? notice : item))
        : [...kept, notice];
    });
    timers.current.set(
      notice.message,
      setTimeout(() => {
        timers.current.delete(notice.message);
        setNotices((old) => old.filter((item) => item.message !== notice.message));
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
          <div className="transient-notice" role="status" key={notice.message}>
            <CheckIcon size={18} aria-hidden="true" />
            <span>{translateMessage(notice.message)}</span>
          </div>
        ))}
      </div>
    </NoticeContext>
  );
}

export function useTransientNotice() {
  const id = useId();
  const show = useContext(NoticeContext);
  return useCallback((message: string) => show({ id, message }), [id, show]);
}

export function TransientNotice({ message }: { message: string }) {
  useI18n();
  const id = useId();
  const show = useContext(NoticeContext);
  useEffect(() => {
    if (message) show({ id, message });
  }, [id, message, show]);
  return null;
}
