import { useEffect, useRef, useState } from 'react';
import { ListRestart } from 'lucide-react';
import type { Content } from '../core/product.js';
import type { PackageStartRef } from '../core/package-start.js';
import type { Run, Source } from '../core/types.js';
import { api, definiteRejection } from './api.js';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { RisuStartPreview } from './RisuStartPreview.js';
import { SaveButton } from './SaveButton.js';
import './package-start-picker.css';

export type PackageStartSelection = PackageStartRef & {
  expectedSettingsRevision: number;
  expectedProfileRevision: number;
  userName?: string;
};
type Command = Omit<PackageStartSelection, 'userName'> & {
  expectedRevision: string;
  expectedSourceHash: string;
  idempotencyKey: string;
};

export function PackageStartPicker({
  open,
  onClose,
  source,
  selection,
  disabled,
  refresh,
  onError,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  source: Source;
  selection: PackageStartSelection;
  disabled?: boolean;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
  onChanged?: () => void;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [selected, setSelected] = useState(selection.startId);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const submitted = useRef<Command | null>(null);
  const submitting = useRef(false);
  const reviewed = useRef({ source, selection });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening captures the reviewed revisions; live updates must not silently adopt a newer write target.
  useEffect(() => {
    if (open && !submitted.current) reviewed.current = { source, selection };
  }, [open]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit failed-read retry repeats the same pinned selection.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReadError('');
    void api<Content>(
      '/revisions/content/' +
        encodeURIComponent(selection.packageId) +
        '/' +
        selection.packageRevision,
      undefined,
      'GET',
      controller.signal
    ).then(
      (value) => {
        if (!controller.signal.aborted) setContent(value);
      },
      (cause: Error) => {
        if (!controller.signal.aborted) setReadError(cause.message);
      }
    );
    return () => controller.abort();
  }, [open, selection.packageId, selection.packageRevision, readAttempt]);
  const starts = content?.package?.starts ?? [];
  async function apply() {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const captured = reviewed.current;
    const command = (submitted.current ??= {
      packageId: captured.selection.packageId,
      packageRevision: captured.selection.packageRevision,
      startId: selected,
      expectedSettingsRevision: captured.selection.expectedSettingsRevision,
      expectedProfileRevision: captured.selection.expectedProfileRevision,
      expectedRevision: captured.source.id,
      expectedSourceHash: captured.source.hash,
      idempotencyKey: crypto.randomUUID(),
    });
    try {
      const result = await api<{ run: Run }>('/chats/' + source.chatId + '/package-start', command);
      submitted.current = null;
      if (!mounted.current) return;
      setUncertain(false);
      onChanged?.();
      onClose();
      try {
        await refresh();
        // Replacing the opening removes its old menu trigger. Restore focus to its successor.
        requestAnimationFrame(() => {
          document
            .getElementById('source-' + result.run.sourceRevision)
            ?.querySelector<HTMLElement>('.action-menu > summary')
            ?.focus({ preventScroll: true });
        });
      } catch (cause) {
        onError('시작문은 바꿨지만 화면을 갱신하지 못했어요. ' + (cause as Error).message);
      }
    } catch (cause) {
      if (!mounted.current) return;
      if (definiteRejection(cause)) {
        submitted.current = null;
        setUncertain(false);
        setError((cause as Error).message);
      } else {
        setUncertain(true);
        setError('변경 결과를 확인하지 못했어요. 같은 선택의 결과를 다시 확인해 주세요.');
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      title="시작문 바꾸기"
    >
      {!content || readError ? (
        <LoadingState
          label="시작문을 불러오는 중이에요…"
          error={readError}
          errorLabel="시작문을 불러오지 못했어요."
          onRetry={() => setReadAttempt((value) => value + 1)}
        />
      ) : (
        <>
          <label>
            첫 메시지 선택
            <select
              value={selected}
              disabled={busy || uncertain || disabled}
              onChange={(event) => {
                setSelected(event.target.value);
                setExpanded(false);
                setError('');
              }}
            >
              {starts.map((start) => (
                <option key={start.id} value={start.id}>
                  {start.title}
                </option>
              ))}
            </select>
          </label>
          <details
            key={selected}
            className="package-start-preview"
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary>미리보기</summary>
            {expanded && (
              <div className="package-start-preview-body" aria-label="첫 메시지 전체 미리보기">
                <RisuStartPreview
                  content={content}
                  startId={selected}
                  userName={selection.userName}
                />
              </div>
            )}
          </details>
          <p className="muted">이 채팅의 첫 메시지를 바꿔요. 작성 중인 입력은 그대로 유지해요.</p>
        </>
      )}
      {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          취소
        </button>
        <SaveButton
          type="button"
          label={uncertain ? '시작문 변경 결과 확인' : '시작문 바꾸기'}
          text={uncertain ? '결과 확인' : '바꾸기'}
          icon={ListRestart}
          aria-busy={busy}
          disabled={
            disabled ||
            (!uncertain &&
              (!content ||
                !!readError ||
                selected === selection.startId ||
                !starts.some((start) => start.id === selected)))
          }
          onClick={() => void apply()}
        />
      </div>
    </Dialog>
  );
}
