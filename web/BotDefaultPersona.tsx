import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useRef, useState } from 'react';
import type { BotDefaults, BotPersonaDefault } from '../core/bot-defaults.js';
import type { Content, Library } from '../core/product.js';
import { api } from './api.js';
import { ContentPicker } from './ContentPicker.js';
import { Dialog } from './Dialog.js';
import { refValue } from './content-ref.js';

export function BotDefaultPersona({
  bot,
  library,
  onClose,
}: {
  bot: Content;
  library: Library;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<BotDefaults | null>(null);
  const [mode, setMode] = useState<BotPersonaDefault['mode']>('inherit');
  const [personaId, setPersonaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const lock = useRef(false);
  const path = `/bots/${encodeURIComponent(bot.id)}/defaults`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry repeats the initial read while the dialog stays open.
  useEffect(() => {
    let alive = true;
    setError('');
    void api<BotDefaults>(path)
      .then((value) => {
        if (!alive) return;
        setSaved(value);
        setMode(value.persona.mode);
        setPersonaId(value.persona.mode === 'persona' ? value.persona.persona.id : '');
      })
      .catch((cause) => {
        if (alive) setError((cause as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [path, loadAttempt]);
  const selected = library.contents.find((item) => item.id === personaId);
  async function save() {
    if (!saved || lock.current || (mode === 'persona' && !selected)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api<BotDefaults>(
        path,
        {
          expectedRevision: saved.revision,
          persona:
            mode === 'persona' && selected
              ? { mode, persona: { id: selected.id, revision: selected.revision } }
              : { mode },
        },
        'PATCH'
      );
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title="봇 기본 페르소나"
      className="bot-organize-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="bot-folder-create"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>{bot.title}의 새 채팅을 시작할 때 사용할 페르소나예요. 기존 채팅은 바뀌지 않아요.</p>
        {!saved && (
          <LoadingState
            presentation="placeholder"
            loading={!error}
            error={error}
            errorLabel="기본 페르소나를 불러오지 못했어요."
            label="기본 설정을 불러오는 중이에요…"
            onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
          />
        )}
        <label>
          기본 페르소나
          <select
            aria-label="봇 기본 페르소나 방식"
            disabled={!saved || busy}
            value={mode}
            onChange={(event) => setMode(event.target.value as BotPersonaDefault['mode'])}
          >
            <option value="inherit">기본 페르소나 미지정</option>
            <option value="none">페르소나 없음</option>
            <option value="persona">페르소나 지정</option>
          </select>
        </label>
        {mode === 'persona' && (
          <>
            <ContentPicker
              library={library}
              role="persona"
              label="봇의 기본 페르소나 선택"
              value={selected ? refValue(selected) : ''}
              selectedContent={selected}
              disabled={!saved || busy}
              onChange={(value) => setPersonaId(value.slice(0, value.lastIndexOf('@')))}
            />
            {personaId && !selected && (
              <p role="status">저장된 페르소나가 삭제됐어요. 다른 페르소나를 선택해 주세요.</p>
            )}
          </>
        )}
        <p className="muted">
          새 채팅에서 직접 고른 값(페르소나 없음 포함), 폴더 기본값, 봇 기본값 순서로 사용해요.
          폴더에서 지정하지 않으면 이 설정을 사용해요.
        </p>
        {saved && error && <NoticeBanner tone="error">{error}</NoticeBanner>}
        <button disabled={!saved || busy || (mode === 'persona' && !selected)}>
          {busy ? '저장하는 중…' : '기본 페르소나 저장'}
        </button>
      </form>
    </Dialog>
  );
}
