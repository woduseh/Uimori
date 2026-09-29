import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { api } from './api.js';

type Interaction = {
  id: string;
  kind: 'input' | 'select' | 'confirm';
  prompt: string;
  choices?: string[];
};
export function RisuInteractionDialog({
  chatId,
  refreshKey = 0,
  onError,
}: {
  chatId: string;
  refreshKey?: number;
  onError: (error: string) => void;
}) {
  const [item, setItem] = useState<Interaction>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useRef(() => {});
  const invalidate = useRef(() => {});
  const priorRefresh = useRef(refreshKey);
  useEffect(() => {
    let active = true;
    let pending = false;
    let requested = false;
    let version = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      if (!active || document.hidden) return;
      clearTimeout(timer);
      if (pending) {
        requested = true;
        return;
      }
      requested = false;
      pending = true;
      const attempt = version;
      try {
        const result = await api<{ interactions: Interaction[] }>(
          `/chats/${encodeURIComponent(chatId)}/risu-interactions`,
          undefined,
          'GET',
          AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        );
        failures = 0;
        if (active && attempt === version)
          setItem((current) =>
            current?.id === result.interactions[0]?.id ? current : result.interactions[0]
          );
      } catch {
        // Only a failed read retries. An idle card needs no polling or new SSE connection.
        if (active && !document.hidden)
          timer = setTimeout(() => void load(), Math.min(10000, 1000 * 2 ** failures++));
      } finally {
        pending = false;
        if (requested && active && !document.hidden) {
          requested = false;
          clearTimeout(timer);
          timer = setTimeout(() => void load(), 0);
        }
      }
    };
    const wake = () => {
      clearTimeout(timer);
      void load();
    };
    reload.current = wake;
    // A late read of the answered prompt must not reopen it.
    invalidate.current = () => version++;
    setItem(undefined);
    void load();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [chatId]);
  useEffect(() => {
    if (priorRefresh.current === refreshKey) return;
    priorRefresh.current = refreshKey;
    reload.current();
  }, [refreshKey]);
  useEffect(() => {
    if (item?.id) setValue('');
  }, [item?.id]);
  const answer = async (answer: string | boolean) => {
    if (!item || busy) return;
    const answeredId = item.id;
    setBusy(true);
    try {
      await api(`/chats/${chatId}/risu-interactions/${answeredId}`, { answer });
      invalidate.current();
      setItem((current) => (current?.id === answeredId ? undefined : current));
      reload.current();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!item}
      title="카드 입력"
      onClose={() => void answer(item?.kind === 'confirm' ? false : '')}
    >
      <p style={{ whiteSpace: 'pre-wrap' }}>{item?.prompt}</p>
      {item?.kind === 'input' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void answer(value);
          }}
        >
          <input
            aria-label="입력 내용"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={10000}
            autoFocus
          />
          <button disabled={busy} type="submit">
            확인
          </button>
        </form>
      )}
      {item?.kind === 'select' &&
        item.choices?.map((choice, index) => (
          <button
            key={`${index}:${choice}`}
            disabled={busy}
            onClick={() => void answer(String(index))}
          >
            {choice}
          </button>
        ))}
      {item?.kind === 'confirm' && (
        <button disabled={busy} onClick={() => void answer(true)}>
          확인
        </button>
      )}
      <button disabled={busy} onClick={() => void answer(item?.kind === 'confirm' ? false : '')}>
        취소
      </button>
    </Dialog>
  );
}
