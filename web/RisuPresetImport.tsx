import { readImportSource as readSource } from './import-source.js';
import { useRef, useState } from 'react';
import type { PromptPreset } from '../core/product.js';
import { RISU_IMPORT_MAX_BYTES, type RisuImportSource } from '../core/risu-import.js';
import type {
  RisuPresetImportApply,
  RisuPresetImportPreview,
  RisuPresetImportResult,
} from '../core/risu-preset.js';
import { ApiError, api } from './api.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { CheckIcon, UploadIcon } from './ui-icons.js';
import './risu-import.css';

/** Closing the dialog retains the reviewed file and exact uncertain submission. */
export function RisuPresetImport({
  showTrigger = true,
  reload,
  onImported,
}: {
  showTrigger?: boolean;
  reload: () => Promise<void>;
  onImported: (preset: PromptPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [source, setSource] = useState<RisuImportSource | null>(null);
  const [preview, setPreview] = useState<RisuPresetImportPreview | null>(null);
  const [allowPartial, setAllowPartial] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<RisuPresetImportResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const submission = useRef<RisuPresetImportApply | null>(null);
  const requestKey = useRef<string | null>(null);
  const unsupported = preview?.findings.some((finding) => finding.level === 'unsupported');
  const ready = !!source && !!preview && (uncertain || !unsupported || allowPartial);

  async function prepare(file: File) {
    if (active.current || uncertain) return;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!/\.(risup|risupreset|json|zip)$/i.test(file.name))
        throw new Error('.risup, .risupreset, 프리셋 JSON 또는 프로젝트 ZIP을 선택해 주세요.');
      if (!file.size) throw new Error('빈 파일은 가져올 수 없어요.');
      if (file.size > RISU_IMPORT_MAX_BYTES) throw new Error('파일은 24 MiB 이하여야 해요.');
      const nextSource = await readSource(file);
      const nextPreview = await api<RisuPresetImportPreview>('/risu-preset-imports/prepare', {
        source: nextSource,
      });
      setSource(nextSource);
      setPreview(nextPreview);
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

  async function apply() {
    if (active.current || !source || !preview || !ready || result) return;
    const payload = submission.current ?? {
      source,
      digest: preview.digest,
      allowPartial,
      idempotencyKey: (requestKey.current ??= crypto.randomUUID()),
    };
    submission.current = payload;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const imported = await api<RisuPresetImportResult>('/risu-preset-imports/apply', payload);
      setResult(imported);
      setUncertain(false);
      try {
        await reload();
      } catch {
        setNotice('가져오기는 완료했어요. 목록을 다시 열면 저장한 프롬프트를 확인할 수 있어요.');
      }
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

  return (
    <>
      {showTrigger && (
        <IconButton
          label="Risu 프리셋 가져오기"
          className="secondary"
          icon={UploadIcon}
          onClick={() => setOpen(true)}
        />
      )}
      <Dialog
        open={open}
        title="Risu 프리셋 가져오기"
        onClose={() => setOpen(false)}
        className="risu-import-dialog"
        wide
      >
        <section
          className={`risu-import-body${result ? ' complete' : ''}`}
          aria-label="Risu 프리셋 검토"
          aria-busy={busy}
        >
          {!preview && (
            <>
              <p className="muted">
                Risu 프롬프트·토글·정규식 원본을 새 작문 프롬프트로 저장해요. 원본 파일도 보존해요.
                가져온 뒤 현재 채팅의 작문 프롬프트로 선택해서 사용할 수 있어요.
              </p>
              <p className="muted">모델 연결과 전역 기본 프롬프트는 바뀌지 않아요.</p>
            </>
          )}
          <label className={`risu-import-file${preview ? ' risu-import-file-ready' : ''}`}>
            <span>
              {preview
                ? source?.name
                : '.risup · .risupreset · 프리셋 JSON · 프로젝트 ZIP · 최대 24 MiB'}
            </span>
            <input
              type="file"
              aria-label="Risu 프리셋 파일 선택"
              accept=".risup,.risupreset,.json,.zip,application/json,application/zip"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
            {preview && <span className="risu-import-change">파일 변경</span>}
          </label>
          {preview && (
            <>
              <div className="risu-import-summary risu-import-hero">
                <h3>{preview.title}</h3>
                <small className="muted">작문 프롬프트</small>
                <dl className="risu-import-counts">
                  <div>
                    <dt>블록</dt>
                    <dd>{preview.summary.blocks}</dd>
                  </div>
                  <div>
                    <dt>옵션</dt>
                    <dd>{preview.summary.controls}</dd>
                  </div>
                  <div>
                    <dt>정규식</dt>
                    <dd>{preview.summary.regex}</dd>
                  </div>
                </dl>
              </div>
              {preview.findings.length > 0 ? (
                <section
                  className={`risu-import-findings${unsupported ? ' warn' : ''}`}
                  aria-label="프리셋 가져오기 지원 범위"
                >
                  <h3>{unsupported ? '실행 전에 확인이 필요해요' : '가져오기 안내'}</h3>
                  <ul>
                    {preview.findings.map((finding, index) => (
                      <li key={`${finding.code}:${index}`}>
                        <strong>
                          {finding.level === 'unsupported' ? '미지원' : '확인 필요'} ·{' '}
                        </strong>
                        {finding.message}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                <p className="muted">현재 파일에서 보고된 미지원 항목은 없어요.</p>
              )}
              <details className="risu-import-processing">
                <summary>원본 처리와 확인 사항</summary>
                <p className="muted">
                  CBS · 토글 · 변수 · 정규식 원본을 보존해요. 현재 사용 프롬프트와 모델은 바뀌지
                  않아요.
                </p>
              </details>
              {unsupported && (
                <label className="risu-import-choice risu-import-partial">
                  <SelectionCheckbox
                    checked={allowPartial}
                    disabled={busy || uncertain || !!result}
                    onChange={(event) => {
                      setAllowPartial(event.target.checked);
                      submission.current = null;
                      requestKey.current = null;
                      setError('');
                    }}
                  />
                  <span>위 미지원 항목이 반영되지 않는 부분 가져오기에 동의해요.</span>
                </label>
              )}
              {uncertain && (
                <p role="status">
                  서버의 완료 여부를 확인하지 못했어요. 파일과 선택을 유지한 같은 요청으로 다시
                  확인하면 프롬프트가 중복 생성되지 않아요. 이 창을 닫아도 요청은 유지돼요.
                </p>
              )}
              {result ? (
                <div className="risu-import-result">
                  <CheckIcon size={28} aria-hidden="true" />
                  <h3>프롬프트를 가져왔어요</h3>
                  <p className="muted">{preview.title}</p>
                  <p role="status">새 작문 프롬프트로 저장했어요.</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      onImported(result.preset);
                    }}
                  >
                    가져온 프롬프트 편집
                  </button>
                </div>
              ) : (
                <button type="button" disabled={busy || !ready} onClick={() => void apply()}>
                  {uncertain ? '같은 요청으로 다시 확인' : '작문 프롬프트로 저장'}
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
