import { useEffect, useState } from 'react';
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
  branchId,
  onError,
}: {
  chatId: string;
  branchId?: string;
  onError: (error: string) => void;
}) {
  const [item, setItem] = useState<Interaction>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await api<{ interactions: Interaction[] }>(
          `/chats/${chatId}/risu-interactions${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`
        );
        if (active)
          setItem((current) =>
            current?.id === result.interactions[0]?.id ? current : result.interactions[0]
          );
      } catch {
        /* The normal chat connection UI owns connectivity errors. */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chatId, branchId]);
  useEffect(() => {
    if (item?.id) setValue('');
  }, [item?.id]);
  const answer = async (answer: string | boolean) => {
    if (!item || busy) return;
    setBusy(true);
    try {
      await api(`/chats/${chatId}/risu-interactions/${item.id}`, { answer });
      setItem(undefined);
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
