import { RisuImageHandoffFields } from './RisuImageHandoffFields.js';
import { readLargeImportSource as readSource } from './import-source.js';
import { useRef, useState } from 'react';
import { RISU_IMPORT_MAX_BYTES, RISU_IMPORT_MAX_UPLOAD_BYTES } from '../core/risu-import.js';
import type {
  RisuImportApply,
  RisuImportKind,
  RisuImportPreview,
  RisuImportResult,
  RisuImportSource,
  RisuImportStagedSource,
} from '../core/risu-import.js';
import { ApiError, api } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { CheckIcon, UploadIcon } from './ui-icons.js';
import './risu-import.css';

/** Always-on lore stays pinned; optional lore is selected by JEV. */
function loreLoadingLabel(entry: RisuImportPreview['lore'][number]): string {
  return entry.loading === 'pinned' ? '항상 포함' : 'JEV 관련성 판단 · 필요할 때 추가 조회';
}

/** Ordinary close retains the review; explicit discard clears only an unapplied, certain draft. */
export function RisuImport({
  showTrigger = true,
  defaultKind = '',
  reload,
  onContinueChat,
}: {
  showTrigger?: boolean;
  defaultKind?: RisuImportKind | '';
  reload: () => Promise<void>;
  onContinueChat?: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const preparation = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [source, setSource] = useState<RisuImportSource | RisuImportStagedSource | null>(null);
  const [kind, setKind] = useState<RisuImportKind | ''>('');
  const [preview, setPreview] = useState<RisuImportPreview | null>(null);
  const [imageHandoffIds, setImageHandoffIds] = useState<string[]>([]);
  const [allowPartial, setAllowPartial] = useState(false);
  const [createChat, setCreateChat] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<RisuImportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submission = useRef<RisuImportApply | null>(null);
  const requestKey = useRef<string | null>(null);
  const unsupported = preview?.findings.some((finding) => finding.level === 'unsupported');
  const locked = busy || uncertain || !!result;
  const ready = !!source && !!preview && (uncertain || !unsupported || allowPartial);
  const selectedKind = preview?.kind ?? kind;
  const kindLabel =
    selectedKind === 'module'
      ? '모듈'
      : selectedKind === 'persona'
        ? '페르소나'
        : selectedKind === 'bot'
          ? '봇'
          : '자동';

  function selectionChanged() {
    submission.current = null;
    requestKey.current = null;
    setError('');
  }

  async function prepare(file: File) {
    if (active.current || uncertain) return;
    active.current = true;
    setBusy(true);
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true);
    setError('');
    setNotice('');
    try {
      if (!/\.(charx|jpe?g|png|risum|json|zip)$/i.test(file.name))
        throw new Error('v3 CHARX·JPEG·PNG·JSON, .risum 또는 모듈 프로젝트 ZIP을 선택해 주세요.');
      if (file.size === 0) throw new Error('빈 파일은 가져올 수 없어요.');
      if (file.size > RISU_IMPORT_MAX_UPLOAD_BYTES)
        throw new Error(
          `파일은 ${Math.round(RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024)} MiB 이하여야 해요.`
        );
      if (file.size > RISU_IMPORT_MAX_BYTES)
        setNotice(
          `${Math.round(RISU_IMPORT_MAX_BYTES / 1024 / 1024)} MiB가 넘는 파일이라 먼저 올린 뒤 확인해요. 원본 사본은 앱에 보관하지 않아요.`
        );
      const nextSource = await readSource(file, controller.signal);
      const nextPreview = await api<RisuImportPreview>(
        '/risu-imports/prepare',
        {
          source: nextSource,
          ...(kind ? { kind } : {}),
        },
        'POST',
        controller.signal
      );
      setSource(nextSource);
      setPreview(nextPreview);
      setImageHandoffIds(
        nextPreview.imageHandoff?.ranges
          .filter((range) => range.enabled)
          .map((range) => range.id) ?? []
      );
      setAllowPartial(false);
      setResult(null);
      submission.current = null;
      requestKey.current = null;
    } catch (cause) {
      if (controller.signal.aborted) setNotice('자료 확인을 취소했어요.');
      else
        setError(`${(cause as Error).message}${preview ? ' 앞서 확인한 파일은 유지했어요.' : ''}`);
    } finally {
      preparation.current = null;
      setPreparing(false);
      active.current = false;
      setBusy(false);
    }
  }

  async function changeKind(nextKind: RisuImportKind | '') {
    if (active.current || uncertain || result) return;
    if (!source) {
      setKind(nextKind);
      selectionChanged();
      return;
    }
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const nextPreview = await api<RisuImportPreview>('/risu-imports/prepare', {
        source,
        ...(preview?.preparedId ? { preparedId: preview.preparedId } : {}),
        ...(nextKind ? { kind: nextKind } : {}),
      });
      setKind(nextKind);
      setPreview(nextPreview);
      setImageHandoffIds(
        nextPreview.imageHandoff?.ranges
          .filter((range) => range.enabled)
          .map((range) => range.id) ?? []
      );
      setAllowPartial(false);
      selectionChanged();
    } catch (cause) {
      setError(`${(cause as Error).message} 앞서 확인한 파일과 자료 종류는 유지했어요.`);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function refreshAndOpen(imported: RisuImportResult) {
    try {
      await reload();
      if (preview?.kind !== 'bot') return;
      if (imported.chat && onContinueChat) {
        setOpen(false);
        onContinueChat(imported.chat.id);
      } else if (imported.chat) {
        setNotice('봇과 새 채팅을 만들었어요. 채팅 목록에서 이어갈 수 있어요.');
      }
    } catch {
      setNotice(
        preview?.kind === 'module'
          ? '모듈 등록은 완료했어요. 서재를 새로고침한 뒤 기존 채팅에 장착해 주세요.'
          : preview?.kind === 'persona'
            ? '페르소나 등록은 완료했어요. 서재를 새로고침한 뒤 사용할 수 있어요.'
            : imported.chat
              ? '가져오기는 완료했어요. 목록을 새로고침한 뒤 채팅을 열어 주세요.'
              : '봇 등록은 완료했어요. 서재를 새로고침한 뒤 사용할 수 있어요.'
      );
    }
  }

  async function apply() {
    if (active.current || !source || !preview || !ready || result) return;
    const payload = submission.current ?? {
      source,
      ...(preview.preparedId ? { preparedId: preview.preparedId } : {}),
      ...(kind ? { kind } : {}),
      digest: preview.digest,
      allowPartial,
      imageHandoffIds,
      createChat: preview.kind === 'bot' && createChat,
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

  function discardAndClose() {
    if (active.current || uncertain || result) return;
    const preparedId = preview?.preparedId;
    const uploadId = source?.uploadId;
    setSource(null);
    setPreview(null);
    setKind(defaultKind);
    setImageHandoffIds([]);
    setAllowPartial(false);
    setCreateChat(false);
    setError('');
    setNotice('');
    submission.current = null;
    requestKey.current = null;
    setOpen(false);
    if (preparedId || uploadId)
      void api('/risu-imports/discard', {
        ...(preparedId ? { preparedId } : {}),
        ...(uploadId ? { uploadId } : {}),
      }).catch(() => {
        // Local discard is complete; expiry cleanup handles an unreachable server or locked files.
      });
  }

  return (
    <>
      {showTrigger && (
        <IconButton
          label="자료 가져오기"
          className="secondary"
          icon={UploadIcon}
          onClick={() => {
            if (!source && !active.current) setKind(defaultKind);
            setOpen(true);
          }}
        />
      )}
      <Dialog
        open={open}
        title="자료 가져오기"
        onClose={() => setOpen(false)}
        className="risu-import-dialog"
        wide
      >
        <section
          className={`risu-import-body${result ? ' complete' : ''}`}
          aria-label="Risu 파일 검토"
          aria-busy={busy}
        >
          {!preview && (
            <p className="muted">
              파일을 선택하면 내용을 미리 확인할 수 있어요. 원본은 변경하지 않아요.
            </p>
          )}
          <label className={`risu-import-file${preview ? ' risu-import-file-ready' : ''}`}>
            <span>
              {preview
                ? source?.name
                : `v3 CHARX·JPEG·PNG·JSON · .risum · 모듈 ZIP · 최대 ${Math.round(RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024)} MiB`}
            </span>
            <input
              type="file"
              aria-label="Risu 파일 선택"
              accept=".charx,.jpg,.jpeg,.png,.risum,.json,.zip,application/json,application/zip,image/png,image/jpeg"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
            {preview && <span className="risu-import-change">파일 변경</span>}
          </label>
          <details className="risu-import-processing">
            <summary>
              {preview
                ? `${kindLabel}${preview.kind === 'bot' ? '으로' : '로'} 가져오기 · 변경`
                : `자료 종류 · ${kindLabel}`}
            </summary>
            <div>
              <label>
                {preview ? '자료 종류' : '가져올 자료 종류'}
                <select
                  value={kind}
                  disabled={locked}
                  onChange={(event) => void changeKind(event.target.value as RisuImportKind | '')}
                >
                  <option value="">자동</option>
                  <option value="bot">봇</option>
                  <option value="persona">페르소나</option>
                  <option value="module">모듈</option>
                </select>
              </label>
              <p className="muted">
                자동은 카드를 봇으로, 모듈 파일을 모듈로 가져와요. 카드를 페르소나로 쓰거나 CharX를
                모듈로 쓰려면 종류를 바꿔 주세요.
              </p>
              {preview && preview.lore.length > 0 && (
                <p className="muted">사용 중인 로어도 함께 가져와요.</p>
              )}
              <p className="muted">
                원본 파일은 변경하지 않으며, 파일의 코드나 외부 URL을 자동으로 실행하지 않아요.
              </p>
            </div>
          </details>
          {preview && (
            <>
              <div className="risu-import-summary risu-import-hero">
                <h3>{preview.title}</h3>
                {preview.description && <p>{preview.description}</p>}
                <dl className="risu-import-counts">
                  <div>
                    <dt>로어</dt>
                    <dd>{preview.summary.lore}</dd>
                  </div>
                  <div>
                    <dt>첫 메시지</dt>
                    <dd>{preview.summary.starts}</dd>
                  </div>
                  <div>
                    <dt>이미지</dt>
                    <dd>{preview.summary.images}</dd>
                  </div>
                </dl>
              </div>
              {preview.findings.length > 0 && (
                <section
                  className={`risu-import-findings${unsupported ? ' warn' : ''}`}
                  aria-label="가져오기 지원 범위"
                >
                  <h3>{unsupported ? '실행 전에 확인이 필요해요' : '가져오기 안내'}</h3>
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
              )}
              {preview.imageHandoff && (
                <RisuImageHandoffFields
                  policy={preview.imageHandoff}
                  selected={imageHandoffIds}
                  disabled={locked}
                  onChange={(ids) => {
                    setImageHandoffIds(ids);
                    selectionChanged();
                  }}
                />
              )}
              {preview.lore.length > 0 && (
                <details className="risu-import-preview" key={preview.digest}>
                  <summary>로어 미리보기 ({preview.lore.length}개)</summary>
                  {preview.lore.map((entry) => (
                    <details key={entry.id} className="risu-import-lore-entry">
                      <summary>{entry.title || '제목 없는 로어'}</summary>
                      <small className="muted">
                        {entry.enabled ? '사용 중' : '사용 안 함'} · {loreLoadingLabel(entry)}
                      </small>
                      <p className="risu-import-lore-text">{entry.text || '(내용 없음)'}</p>
                    </details>
                  ))}
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
              {preview.kind === 'bot' && !result && (
                <label className="risu-import-choice">
                  <SelectionCheckbox
                    checked={createChat}
                    disabled={locked}
                    onChange={(event) => {
                      setCreateChat(event.target.checked);
                      selectionChanged();
                    }}
                  />
                  <span>가져온 뒤 새 채팅도 만들기</span>
                </label>
              )}
              {uncertain && (
                <p role="status">
                  서버의 완료 여부를 확인하지 못했어요. 파일과 선택을 유지한 같은 요청으로 다시
                  확인하면{' '}
                  {preview.kind === 'module'
                    ? '모듈이'
                    : preview.kind === 'persona'
                      ? '페르소나가'
                      : createChat
                        ? '봇과 채팅이'
                        : '봇이'}{' '}
                  중복 생성되지 않아요. 이 창을 닫아도 요청은 유지돼요.
                </p>
              )}
              {result ? (
                <div className="risu-import-result">
                  <CheckIcon size={28} aria-hidden="true" />
                  <h3>자료를 가져왔어요</h3>
                  <p className="muted">{preview.title}</p>
                  <p role="status">
                    {preview.kind === 'module'
                      ? '모듈을 서재에 등록했어요. 기존 채팅의 봇·페르소나·모듈 설정에서 장착해 주세요.'
                      : preview.kind === 'persona'
                        ? '페르소나를 서재에 등록했어요. 새 채팅이나 기존 채팅에서 선택할 수 있어요.'
                        : result.chat
                          ? '봇과 새 채팅을 가져왔어요.'
                          : submission.current?.createChat === false
                            ? '봇을 서재에 등록했어요. 서재나 왼쪽 봇 목록에서 원할 때 채팅을 시작할 수 있어요.'
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
                  {uncertain
                    ? '같은 요청으로 다시 확인'
                    : preview.kind !== 'bot'
                      ? `${preview.kind === 'module' ? '모듈' : '페르소나'} 가져오기`
                      : createChat
                        ? '가져오고 새 채팅 열기'
                        : '봇 가져오기'}
                </button>
              )}
              {!result && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || uncertain}
                  title={uncertain ? '가져오기 완료 여부를 먼저 확인해 주세요.' : undefined}
                  onClick={discardAndClose}
                >
                  가져오지 않고 닫기
                </button>
              )}
            </>
          )}
          {busy && <p role="status">파일을 처리하고 있어요…</p>}
          {preparing && (
            <button type="button" onClick={() => preparation.current?.abort()}>
              자료 확인 취소
            </button>
          )}
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
