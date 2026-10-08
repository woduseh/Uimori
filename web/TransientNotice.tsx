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

/** Completion feedback never changes saved state or dismisses an unresolved problem. */
export function TransientNoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const show = useCallback((notice: Notice) => {
    clearTimeout(timers.current.get(notice.id));
    setNotices((old) => [...old.filter((item) => item.id !== notice.id), notice]);
    timers.current.set(
      notice.id,
      setTimeout(() => {
        timers.current.delete(notice.id);
        setNotices((old) => old.filter((item) => item.id !== notice.id));
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
    // A manual, non-modal popover remains visible above native settings dialogs without
    // taking focus or making the manuscript inert.
    if (notices.length) {
      // A later-opened dialog may sit above an already-visible completion notice.
      // Refresh only its top-layer placement; neither the timer nor focus changes.
      if (node.matches(':popover-open')) node.hidePopover();
      node.showPopover();
    } else if (node.matches(':popover-open')) node.hidePopover();
  }, [notices]);
  return (
    <NoticeContext value={show}>
      {children}
      <div ref={host} popover="manual" className="transient-notices" aria-live="polite">
        {notices.map((notice) => (
          <div className="transient-notice" role="status" key={notice.id}>
            <CheckIcon size={18} aria-hidden="true" />
            <span>{notice.message}</span>
          </div>
        ))}
      </div>
    </NoticeContext>
  );
}

export function TransientNotice({ message }: { message: string }) {
  const id = useId();
  const show = useContext(NoticeContext);
  useEffect(() => {
    if (message) show({ id, message });
  }, [id, message, show]);
  return null;
}
