import { useRef, useState } from 'react';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import type {
  RisuImportApply,
  RisuImportPreview,
  RisuImportResult,
  RisuImportSource,
} from '../core/risu-import.js';
import { ApiError, api } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { UploadIcon } from './ui-icons.js';
import './risu-import.css';

function readSource(file: File): Promise<RisuImportSource> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했어요. 다시 선택해 주세요.'));
    reader.onabort = () => reject(new Error('파일 읽기가 취소됐어요.'));
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string' || !data.includes(',')) {
        reject(new Error('파일 내용을 읽지 못했어요.'));
        return;
      }
      resolve({ name: file.name, base64: data.slice(data.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function memorySelectionIssue(entry: RisuImportPreview['lore'][number]): string {
  if (!entry.enabled) return '사용하지 않는 로어는 진행 기억으로 옮길 수 없어요.';
  if (!entry.text.trim()) return '본문이 없는 항목은 진행 기억으로 옮길 수 없어요.';
  if (entry.text.length > 32000) return '32,000자를 넘는 항목은 진행 기억으로 옮길 수 없어요.';
  return '';
}

/** Closing the dialog retains the reviewed file and any uncertain apply request. */
export function RisuImport({
  showTrigger = true,
  reload,
  onContinueChat,
}: {
  showTrigger?: boolean;
  reload: () => Promise<void>;
  onContinueChat?: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [source, setSource] = useState<RisuImportSource | null>(null);
  const [preview, setPreview] = useState<RisuImportPreview | null>(null);
  const [memoryIds, setMemoryIds] = useState<string[]>([]);
  const [allowPartial, setAllowPartial] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<RisuImportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submission = useRef<RisuImportApply | null>(null);
  const requestKey = useRef<string | null>(null);
  const unsupported = preview?.findings.some((finding) => finding.level === 'unsupported');
  const locked = busy || uncertain || !!result;
  const ready = !!source && !!preview && (uncertain || !unsupported || allowPartial);

  function selectionChanged() {
    submission.current = null;
    requestKey.current = null;
    setError('');
  }

  async function prepare(file: File) {
    if (active.current || uncertain) return;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!/\.(charx|json)$/i.test(file.name))
        throw new Error('.charx 또는 캐릭터 카드 .json 파일을 선택해 주세요.');
      if (file.size === 0) throw new Error('빈 파일은 가져올 수 없어요.');
      if (file.size > RISU_IMPORT_MAX_BYTES) throw new Error('파일은 24 MiB 이하여야 해요.');
      const nextSource = await readSource(file);
      const nextPreview = await api<RisuImportPreview>('/risu-imports/prepare', {
        source: nextSource,
      });
      setSource(nextSource);
      setPreview(nextPreview);
      setMemoryIds([]);
      setAllowPartial(false);
      setResult(null);
      submission.current = null;
      requestKey.current = null;
    } catch (cause) {
      setError(`${(cause as Error).message}${preview ? ' 앞서 확인한 파일은 유지했어요.' : ''}`);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function refreshAndOpen(imported: RisuImportResult) {
    try {
      await reload();
      if (imported.chat && onContinueChat) {
        setOpen(false);
        onContinueChat(imported.chat.id);
      } else if (imported.chat) {
        setNotice('봇과 새 채팅을 만들었어요. 채팅 목록에서 이어갈 수 있어요.');
      }
    } catch {
      setNotice('가져오기는 완료했어요. 목록을 새로고침한 뒤 채팅을 열어 주세요.');
    }
  }

  async function apply() {
    if (active.current || !source || !preview || !ready || result) return;
    const payload = submission.current ?? {
      source,
      digest: preview.digest,
      memoryIds: preview.lore
        .filter((entry) => memoryIds.includes(entry.id))
        .map((entry) => entry.id),
      allowPartial,
      idempotencyKey: (requestKey.current ??= crypto.randomUUID()),
    };
    submission.current = payload;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const imported = await api<RisuImportResult>('/risu-imports/apply', payload);
      setResult(imported);
      setUncertain(false);
      await refreshAndOpen(imported);
    } catch (cause) {
      const confirmedFailure =
        !uncertain &&
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408;
      setUncertain(!confirmedFailure);
      if (confirmedFailure) submission.current = null;
      setError((cause as Error).message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function openSavedChat() {
    if (active.current || !result) return;
    active.current = true;
    setBusy(true);
    setNotice('');
    try {
      await refreshAndOpen(result);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {showTrigger && (
        <IconButton
          label="Risu 봇 가져오기"
          className="secondary"
          icon={UploadIcon}
          onClick={() => setOpen(true)}
        />
      )}
      <Dialog
        open={open}
        title="Risu 봇 가져오기"
        onClose={() => setOpen(false)}
        className="risu-import-dialog"
        wide
      >
        <section className="risu-import-body" aria-label="Risu 파일 검토" aria-busy={busy}>
          <p className="muted">
            원본 파일은 그대로 두고 봇과 새 채팅을 만들어요. 파일의 코드나 외부 URL을 자동으로
            실행하지 않아요.
          </p>
          <label className="risu-import-file">
            캐릭터 카드 파일 · 최대 24 MiB
            <input
              type="file"
              aria-label="Risu 파일 선택"
              accept=".charx,.json,application/json"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
          </label>
          {preview && (
            <>
              <div className="risu-import-summary">
                <h3>{preview.title}</h3>
                <small className="muted">{source?.name}</small>
                {preview.description && <p>{preview.description}</p>}
                <p>
                  로어 {preview.summary.lore}개 · 시작문 {preview.summary.starts}개 · 이미지{' '}
                  {preview.summary.images}개
                </p>
              </div>
              {preview.findings.length > 0 ? (
                <section className="risu-import-findings" aria-label="가져오기 지원 범위">
                  <h3>가져오기 안내</h3>
                  <ul>
                    {preview.findings.map((finding, index) => (
                      <li key={`${finding.code}:${index}`}>
                        <strong>
                          {finding.level === 'unsupported'
                            ? '미지원'
                            : finding.level === 'warning'
                              ? '확인 필요'
                              : '안내'}
                          {' · '}
                        </strong>
                        {finding.message}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                <p className="muted">현재 파일에서 보고된 미지원 항목은 없어요.</p>
              )}
              <p className="muted">
                로어북의 사용 중인 항목은 별도로 선택하지 않아도 봇의 설정으로 가져와요.
              </p>
              {preview.lore.length > 0 && (
                <details className="risu-import-memory" key={preview.digest}>
                  <summary>
                    로어북에서 과거 진행 기억 분리하기 (선택)
                    {memoryIds.length > 0 && <small> · 선택 {memoryIds.length}개</small>}
                  </summary>
                  <fieldset className="risu-import-lore" disabled={locked}>
                    <legend>분리할 항목 선택</legend>
                    <p className="muted">
                      배경 로어는 기본적으로 봇에 보존해요. 이전 대화의 진행 기억을 찾았다면 내용을
                      확인하고 선택해 주세요. 선택한 항목만 봇 로어에서 분리해 새 채팅의 참고 메모로
                      옮겨요.
                    </p>
                    <p className="risu-import-selection-count" role="status">
                      봇 로어로 유지 {preview.summary.lore - memoryIds.length}개 · 진행 기억으로
                      이동 {memoryIds.length}개
                    </p>
                    {preview.lore.map((entry) => (
                      <details key={entry.id} className="risu-import-lore-entry">
                        <summary>
                          <strong>{entry.title || '제목 없는 로어'}</strong>
                          <small>
                            {memoryIds.includes(entry.id)
                              ? '진행 기억으로 이동'
                              : entry.memoryCandidate
                                ? '진행 기억일 수 있어요 · 직접 확인'
                                : '봇 로어로 유지'}
                          </small>
                        </summary>
                        <div className="risu-import-lore-content">
                          <small className="muted">
                            {entry.enabled ? '사용 중' : '사용 안 함'} ·{' '}
                            {entry.loading === 'pinned' ? '항상 포함' : '필요할 때 조회'}
                          </small>
                          <p className="risu-import-lore-text">{entry.text || '(내용 없음)'}</p>
                          <label className="risu-import-choice">
                            <SelectionCheckbox
                              aria-label={`${entry.title || '제목 없는 로어'} 과거 진행 기억으로 옮기기`}
                              checked={memoryIds.includes(entry.id)}
                              disabled={!!memorySelectionIssue(entry)}
                              onChange={(event) => {
                                setMemoryIds((current) =>
                                  event.target.checked
                                    ? [...current, entry.id]
                                    : current.filter((id) => id !== entry.id)
                                );
                                selectionChanged();
                              }}
                            />
                            <span>과거 진행 기억으로 옮기기</span>
                          </label>
                          {memorySelectionIssue(entry) && (
                            <small className="muted">{memorySelectionIssue(entry)}</small>
                          )}
                        </div>
                      </details>
                    ))}
                  </fieldset>
                </details>
              )}
              {unsupported && (
                <label className="risu-import-choice risu-import-partial">
                  <SelectionCheckbox
                    checked={allowPartial}
                    disabled={locked}
                    onChange={(event) => {
                      setAllowPartial(event.target.checked);
                      selectionChanged();
                    }}
                  />
                  <span>위 미지원 항목이 반영되지 않는 부분 가져오기에 동의해요.</span>
                </label>
              )}
              {uncertain && (
                <p role="status">
                  서버의 완료 여부를 확인하지 못했어요. 파일과 선택을 유지한 같은 요청으로 다시
                  확인하면 봇과 채팅이 중복 생성되지 않아요. 이 창을 닫아도 요청은 유지돼요.
                </p>
              )}
              {result ? (
                <div className="risu-import-result">
                  <p role="status">
                    {result.chat
                      ? '봇과 새 채팅을 가져왔어요.'
                      : '자료 가져오기는 완료됐어요. 연결된 채팅이 삭제되어 열 수 없어요.'}
                  </p>
                  {result.chat && onContinueChat && (
                    <button type="button" disabled={busy} onClick={() => void openSavedChat()}>
                      새 채팅 열기
                    </button>
                  )}
                </div>
              ) : (
                <button type="button" disabled={busy || !ready} onClick={() => void apply()}>
                  {uncertain ? '같은 요청으로 다시 확인' : '가져오고 새 채팅 열기'}
                </button>
              )}
            </>
          )}
          {busy && <p role="status">파일을 처리하고 있어요…</p>}
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </Dialog>
    </>
  );
}
