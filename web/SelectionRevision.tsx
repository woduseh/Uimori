import { useLayoutEffect, useRef, useState } from 'react';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { validRevisionRange, type SelectionRevisionResult } from '../core/selection-revision.js';
import { api } from './api.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
import { CodexContentWarningDialog } from './CodexContentWarningDialog.js';

type Selection = { start: number; end: number; version: number };
type Props = {
  sourceId: string;
  chatId: string;
  text: string;
  draftVersion: number;
  selection: Selection;
  expectedSourceHash: string;
  expectedRevision: number;
  disabled: boolean;
  onApply: (text: string, start: number, end: number) => void;
};
type Captured = Pick<
  Props,
  'text' | 'draftVersion' | 'selection' | 'expectedSourceHash' | 'expectedRevision'
>;

export function SelectionRevision(props: Props) {
  const current = useRef(props);
  current.current = props;
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const codexWarning = useCodexContentWarning();
  useLayoutEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    []
  );

  function matches(value: Captured) {
    const latest = current.current;
    return (
      !latest.disabled &&
      latest.text === value.text &&
      latest.draftVersion === value.draftVersion &&
      latest.selection.version === value.selection.version &&
      latest.expectedRevision === value.expectedRevision &&
      latest.expectedSourceHash === value.expectedSourceHash
    );
  }
  const stale = captured !== null && !matches(captured);
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    codexWarning.cancelRequest();
    setBusy(false);
  }
  function close() {
    cancel();
    setCaptured(null);
    setProposal(null);
    setError('');
  }
  async function requestProposal() {
    if (!captured || !matches(captured) || pending.current || !instruction.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setProposal(null);
    try {
      const proceed = await codexWarning.check(
        `/chats/${encodeURIComponent(props.chatId)}/codex-content-preflight`,
        {
          role: 'selection-revision',
          text: instruction,
          selection: captured.text.slice(captured.selection.start, captured.selection.end),
        },
        'selection-revision',
        controller.signal
      );
      if (
        !proceed ||
        pending.current !== controller ||
        controller.signal.aborted ||
        !matches(captured)
      )
        return;
      const result = await api<SelectionRevisionResult>(
        `/sources/${encodeURIComponent(props.sourceId)}/selection-revision`,
        {
          draft: captured.text,
          start: captured.selection.start,
          end: captured.selection.end,
          instruction,
          expectedSourceHash: captured.expectedSourceHash,
          expectedRevision: captured.expectedRevision,
        },
        'POST',
        controller.signal
      );
      if (pending.current === controller && !controller.signal.aborted) setProposal(result.text);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '퇴고 제안을 받지 못했어요.');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="selection-revision" aria-label="선택 구절 퇴고">
      {!captured ? (
        <>
          <button
            type="button"
            className="secondary"
            disabled={
              props.disabled ||
              !validRevisionRange(props.text, props.selection.start, props.selection.end)
            }
            onClick={() => {
              setCaptured({
                text: props.text,
                draftVersion: props.draftVersion,
                selection: props.selection,
                expectedSourceHash: props.expectedSourceHash,
                expectedRevision: props.expectedRevision,
              });
              setProposal(null);
              setError('');
            }}
          >
            선택 구절 퇴고
          </button>
          <p className="muted">원문에서 구절을 선택하면 도우미 모델에 퇴고를 부탁할 수 있어요.</p>
        </>
      ) : (
        <>
          <div className="selection-revision-comparison">
            <div>
              <strong>선택한 원문</strong>
              <pre>{captured.text.slice(captured.selection.start, captured.selection.end)}</pre>
            </div>
            {proposal !== null && (
              <div>
                <strong>퇴고 제안</strong>
                <pre data-testid="selection-revision-proposal">{proposal}</pre>
              </div>
            )}
          </div>
          <label>
            퇴고 요청
            <textarea
              rows={3}
              maxLength={REQUEST_TEXT_MAX_CHARS}
              value={instruction}
              disabled={busy}
              placeholder="뜻은 유지하고, 감정을 직접 설명하는 문장만 줄여줘."
              onChange={(event) => {
                setInstruction(event.target.value);
                setProposal(null);
              }}
            />
          </label>
          <p className="muted">
            도우미 모델을 한 번 호출해요. 이용 중인 모델에 따라 비용이 발생할 수 있어요. 제안은
            초안에만 반영되며, 원문 저장으로 확정해요.
          </p>
          {stale && (
            <p role="status" className="muted">
              초안이나 선택 구간이 바뀌었어요. 현재 입력은 유지했어요. 닫고 구절을 다시 선택해
              주세요.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error} 작성한 내용은 유지돼요.
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={close}>
              퇴고 닫기
            </button>
            {busy ? (
              <button type="button" className="secondary" onClick={cancel}>
                퇴고 요청 취소
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={stale || !instruction.trim()}
                onClick={() => void requestProposal()}
              >
                {proposal === null ? '퇴고 제안 받기' : '다시 제안 받기'}
              </button>
            )}
            {proposal !== null && (
              <button
                type="button"
                disabled={busy || stale}
                onClick={() => {
                  if (!matches(captured)) return;
                  const { start, end } = captured.selection;
                  props.onApply(
                    captured.text.slice(0, start) + proposal + captured.text.slice(end),
                    start,
                    start + proposal.length
                  );
                  close();
                }}
              >
                선택 구간에 반영
              </button>
            )}
          </div>
          <CodexContentWarningDialog gate={codexWarning} />
        </>
      )}
    </section>
  );
}
