import { useEffect, useRef, useState } from 'react';
import type {
  ManuscriptExportMetadata,
  ManuscriptExportMode,
  ManuscriptExportResult,
} from '../core/manuscript-export.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';

export function ManuscriptExportDialog({
  open,
  chatId,
  onClose,
}: {
  open: boolean;
  chatId: string;
  onClose: () => void;
}) {
  const [metadata, setMetadata] = useState<ManuscriptExportMetadata | null>(null);
  const [mode, setMode] = useState<ManuscriptExportMode>('source');
  const [range, setRange] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(0);
  useEffect(() => {
    const generation = ++active.current;
    if (!open) return;
    const controller = new AbortController();
    setMetadata(null);
    setMode('source');
    setRange(false);
    setBusy(false);
    setError('');
    void api<ManuscriptExportMetadata>(
      `/chats/${chatId}/manuscript`,
      undefined,
      'GET',
      controller.signal
    )
      .then((next) => {
        if (active.current !== generation) return;
        setMetadata(next);
        setFrom(next.scenes[0]?.number ?? 0);
        setTo(next.scenes.at(-1)?.number ?? 0);
      })
      .catch((cause) => {
        if (!controller.signal.aborted && active.current === generation)
          setError((cause as Error).message);
      });
    return () => {
      controller.abort();
      active.current++;
    };
  }, [open, chatId]);
  async function download() {
    if (!metadata || busy) return;
    const generation = active.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<ManuscriptExportResult>(`/chats/${chatId}/manuscript`, {
        mode,
        expectedHeadRevision: metadata.headRevision,
        ...(range ? { fromScene: from, toScene: to } : {}),
      });
      if (active.current !== generation) return;
      const url = URL.createObjectURL(
        new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (cause) {
      if (active.current === generation) setError((cause as Error).message);
    } finally {
      if (active.current === generation) setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title="원고 내보내기"
      headerTitle="원고 내보내기"
      onClose={onClose}
      scopeKey={chatId}
    >
      <p>요청·작업 기록·메모를 제외한 본문만 Markdown 파일로 저장해요.</p>
      <fieldset className="editor-fields" disabled={busy || !metadata}>
        <label className="full">
          내보낼 본문
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as ManuscriptExportMode);
              setError('');
            }}
          >
            <option value="source">원문</option>
            <option value="translation">저장된 번역</option>
          </select>
        </label>
        <label className="full">
          장면 범위
          <select
            value={range ? 'range' : 'all'}
            onChange={(event) => {
              setRange(event.target.value === 'range');
              setError('');
            }}
          >
            <option value="all">전체 채팅</option>
            <option value="range">장면 범위 선택</option>
          </select>
        </label>
        {range && (
          <>
            <label>
              시작 장면
              <select
                value={from}
                onChange={(event) => {
                  setFrom(Number(event.target.value));
                  setError('');
                }}
              >
                {metadata?.scenes.map((scene) => (
                  <option key={scene.number} value={scene.number}>
                    {scene.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              끝 장면
              <select
                value={to}
                onChange={(event) => {
                  setTo(Number(event.target.value));
                  setError('');
                }}
              >
                {metadata?.scenes.map((scene) => (
                  <option key={scene.number} value={scene.number}>
                    {scene.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </fieldset>
      <p className="muted">HTML·Risu 상태창 표기는 그대로 담아요. 이미지·EPUB는 포함하지 않아요.</p>
      {mode === 'translation' && (
        <p className="muted">범위 안에 유효한 번역이 없는 장면이 있으면 다운로드하지 않아요.</p>
      )}
      {!metadata && !error && <p role="status">원고 목록을 불러오고 있어요.</p>}
      {metadata && !metadata.scenes.length && <p role="status">내보낼 원고가 아직 없어요.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !metadata?.scenes.length || (range && from > to)}
          onClick={() => void download()}
        >
          {busy ? '원고 준비 중…' : 'Markdown 다운로드'}
        </button>
      </div>
    </Dialog>
  );
}
