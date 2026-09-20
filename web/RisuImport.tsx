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

/** Closing the dialog retains the reviewed file and any uncertain apply request. */
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
  const [source, setSource] = useState<RisuImportSource | RisuImportStagedSource | null>(null);
  const [kind, setKind] = useState<RisuImportKind | ''>('');
  const [preview, setPreview] = useState<RisuImportPreview | null>(null);
  const [imageHandoffIds, setImageHandoffIds] = useState<string[]>([]);
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
      if (!/\.(charx|risum|json|zip)$/i.test(file.name))
        throw new Error('.charx, .risum, 카드·모듈 JSON, 모듈 프로젝트 ZIP을 선택해 주세요.');
      if (file.size === 0) throw new Error('빈 파일은 가져올 수 없어요.');
      if (file.size > RISU_IMPORT_MAX_UPLOAD_BYTES)
        throw new Error(
          `파일은 ${Math.round(RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024)} MiB 이하여야 해요.`
        );
      if (file.size > RISU_IMPORT_MAX_BYTES)
        setNotice(
          `${Math.round(RISU_IMPORT_MAX_BYTES / 1024 / 1024)} MiB가 넘는 파일이라 먼저 올린 뒤 확인해요. 원본 사본은 앱에 보관하지 않아요.`
        );
      const nextSource = await readSource(file);
      const nextPreview = await api<RisuImportPreview>('/risu-imports/prepare', {
        source: nextSource,
        ...(kind ? { kind } : {}),
      });
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
      setError(`${(cause as Error).message}${preview ? ' 앞서 확인한 파일은 유지했어요.' : ''}`);
    } finally {
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
            : '가져오기는 완료했어요. 목록을 새로고침한 뒤 채팅을 열어 주세요.'
      );
    }
  }

  async function apply() {
    if (active.current || !source || !preview || !ready || result) return;
    const payload = submission.current ?? {
      source,
      ...(kind ? { kind } : {}),
      digest: preview.digest,
      allowPartial,
      imageHandoffIds,
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
            <>
              <p className="muted">
                원본 파일은 그대로 보존해요. 봇 카드는 새 봇과 채팅을 만들고, 페르소나와 모듈은
                서재에 등록해요. 파일의 코드나 외부 URL을 자동으로 실행하지 않아요.
              </p>
              <label className="risu-import-file">
                가져올 자료 종류
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
                자동은 카드 파일을 봇으로, 모듈 JSON·프로젝트 ZIP을 모듈로 가져와요. 카드를
                페르소나로 쓰거나 CharX를 모듈로 쓰려면 종류를 직접 선택해 주세요. 페르소나와 모듈은
                새 채팅을 만들지 않아요.
              </p>
            </>
          )}
          <label className={`risu-import-file${preview ? ' risu-import-file-ready' : ''}`}>
            <span>
              {preview
                ? source?.name
                : '.charx · 카드·모듈 JSON · 모듈 프로젝트 ZIP · 최대 256 MiB'}
            </span>
            <input
              type="file"
              aria-label="Risu 파일 선택"
              accept=".charx,.risum,.json,.zip,application/json,application/zip"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
            {preview && <span className="risu-import-change">파일 변경</span>}
          </label>
          {!preview && (
            <p className="muted">
              .charx, .risum, 카드·모듈 JSON, 모듈 프로젝트 ZIP을 가져올 수 있어요.
            </p>
          )}
          {preview && (
            <>
              <div className="risu-import-summary risu-import-hero">
                <h3>{preview.title}</h3>
                <small className="muted">
                  {preview.kind === 'module'
                    ? '모듈'
                    : preview.kind === 'persona'
                      ? '페르소나'
                      : '봇'}
                </small>
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
              {preview.findings.length > 0 ? (
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
              ) : (
                <p className="muted">현재 파일에서 보고된 미지원 항목은 없어요.</p>
              )}
              <p className="muted">
                로어북의 사용 중인 항목은 별도로 선택하지 않아도{' '}
                {preview.kind === 'module'
                  ? '모듈'
                  : preview.kind === 'persona'
                    ? '페르소나'
                    : '봇'}
                의 설정으로 가져와요.
              </p>
              <details className="risu-import-processing">
                <summary>처리 방식</summary>
                <div>
                  <label>
                    자료 종류
                    <select
                      value={kind}
                      disabled={locked}
                      onChange={(event) =>
                        void changeKind(event.target.value as RisuImportKind | '')
                      }
                    >
                      <option value="">자동</option>
                      <option value="bot">봇</option>
                      <option value="persona">페르소나</option>
                      <option value="module">모듈</option>
                    </select>
                  </label>
                  <p className="muted">원본 보존 · 로어 선별 · 스크립트 자동 실행 안 함</p>
                </div>
              </details>
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
              {uncertain && (
                <p role="status">
                  서버의 완료 여부를 확인하지 못했어요. 파일과 선택을 유지한 같은 요청으로 다시
                  확인하면{' '}
                  {preview.kind === 'module'
                    ? '모듈이'
                    : preview.kind === 'persona'
                      ? '페르소나가'
                      : '봇과 채팅이'}{' '}
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
                      : '가져오고 새 채팅 열기'}
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
