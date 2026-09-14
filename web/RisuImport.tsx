import { readImportSource, readLargeImportSource as readSource } from './import-source.js';
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
import { RISU_PLUGIN_MAX_BYTES, type RisuPluginPreview } from '../core/risu-plugin.js';
import { ApiError, api } from './api.js';
import { RisuPluginReport } from './RisuPluginReport.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { UploadIcon } from './ui-icons.js';
import './risu-import.css';

function memorySelectionIssue(entry: RisuImportPreview['lore'][number]): string {
  if (!entry.enabled) return '사용하지 않는 로어는 진행 기억으로 옮길 수 없어요.';
  if (!entry.text.trim()) return '본문이 없는 항목은 진행 기억으로 옮길 수 없어요.';
  if (entry.text.length > 32000) return '32,000자를 넘는 항목은 진행 기억으로 옮길 수 없어요.';
  return '';
}

/** Names how the entry reaches the model: pinned entries always, keyword rules on their own keys. */
function loreLoadingLabel(entry: RisuImportPreview['lore'][number]): string {
  if (entry.loading === 'pinned') return '항상 포함';
  const keys = entry.keys?.trim() ?? '';
  if (!keys) return '필요할 때 조회';
  return `키워드 활성화 · 키: ${keys.length > 120 ? `${keys.slice(0, 120)}…` : keys}`;
}

const importedModule = (result: RisuImportResult) =>
  result.receipt.items.some((item) => item.root && item.category === 'module');

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
  const [plugin, setPlugin] = useState<RisuPluginPreview | null>(null);
  const [kind, setKind] = useState<RisuImportKind | ''>('');
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
      if (!/\.(charx|json|zip|js)$/i.test(file.name))
        throw new Error(
          '.charx, 카드·모듈 JSON, 모듈 프로젝트 ZIP 또는 플러그인 .js를 선택해 주세요.'
        );
      if (file.size === 0) throw new Error('빈 파일은 가져올 수 없어요.');
      const isPlugin = /\.js$/iu.test(file.name);
      if (isPlugin && file.size > RISU_PLUGIN_MAX_BYTES)
        throw new Error(
          `플러그인 .js 파일은 ${Math.round(RISU_PLUGIN_MAX_BYTES / 1024 / 1024)} MiB 이하여야 해요.`
        );
      if (file.size > RISU_IMPORT_MAX_UPLOAD_BYTES)
        throw new Error(
          `파일은 ${Math.round(RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024)} MiB 이하여야 해요.`
        );
      if (file.size > RISU_IMPORT_MAX_BYTES)
        setNotice(
          `${Math.round(RISU_IMPORT_MAX_BYTES / 1024 / 1024)} MiB가 넘는 파일이라 먼저 올린 뒤 확인해요. 원본 사본은 앱에 보관하지 않아요.`
        );
      // A plugin stays under the size the request body carries, so it never uses the staged path.
      const nextSource = isPlugin ? await readImportSource(file) : await readSource(file);
      if (isPlugin) {
        // A plugin is read for its declared support only; nothing is registered or executed.
        setPlugin(
          await api<RisuPluginPreview>('/risu-plugin-imports/prepare', { source: nextSource })
        );
        setSource(null);
        setPreview(null);
        setResult(null);
        return;
      }
      const nextPreview = await api<RisuImportPreview>('/risu-imports/prepare', {
        source: nextSource,
        ...(kind ? { kind } : {}),
      });
      setPlugin(null);
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
      setMemoryIds([]);
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
      if (importedModule(imported)) return;
      if (imported.chat && onContinueChat) {
        setOpen(false);
        onContinueChat(imported.chat.id);
      } else if (imported.chat) {
        setNotice('봇과 새 채팅을 만들었어요. 채팅 목록에서 이어갈 수 있어요.');
      }
    } catch {
      setNotice(
        importedModule(imported)
          ? '모듈 등록은 완료했어요. 서재를 새로고침한 뒤 기존 채팅에 장착해 주세요.'
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
      memoryIds:
        preview.kind === 'module'
          ? []
          : preview.lore.filter((entry) => memoryIds.includes(entry.id)).map((entry) => entry.id),
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
          label="Risu 자료 가져오기"
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
        title="Risu 자료 가져오기"
        onClose={() => setOpen(false)}
        className="risu-import-dialog"
        wide
      >
        <section className="risu-import-body" aria-label="Risu 파일 검토" aria-busy={busy}>
          <p className="muted">
            원본 파일은 그대로 보존해요. 봇 카드는 새 봇과 채팅을 만들고, 모듈은 서재에 등록해요.
            파일의 코드나 외부 URL을 자동으로 실행하지 않아요.
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
              <option value="module">모듈</option>
            </select>
          </label>
          <p className="muted">
            자동은 카드 파일을 봇으로, 모듈 JSON·프로젝트 ZIP을 모듈로 가져와요. CharX를 모듈로
            쓰려면 모듈을 선택해 주세요. 모듈은 새 채팅을 만들지 않아요.
          </p>
          <label className="risu-import-file">
            .charx · 카드·모듈 JSON · 모듈 프로젝트 ZIP · 최대 256 MiB · 플러그인 .js는{' '}
            {Math.round(RISU_PLUGIN_MAX_BYTES / 1024 / 1024)} MiB
            <input
              type="file"
              aria-label="Risu 파일 선택"
              accept=".charx,.json,.zip,.js,application/json,application/zip,text/javascript"
              disabled={busy || uncertain}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void prepare(file);
              }}
            />
          </label>
          <p className="muted">.risum 파일 직접 가져오기는 지원하지 않아요.</p>
          {plugin && <RisuPluginReport preview={plugin} />}
          {preview && (
            <>
              <div className="risu-import-summary">
                <h3>{preview.title}</h3>
                <small className="muted">
                  {preview.kind === 'module' ? '모듈' : '봇'} · {source?.name}
                </small>
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
                로어북의 사용 중인 항목은 별도로 선택하지 않아도{' '}
                {preview.kind === 'module' ? '모듈' : '봇'}의 설정으로 가져와요.
              </p>
              {preview.kind === 'module' && preview.lore.length > 0 && (
                <details className="risu-import-preview" key={preview.digest}>
                  <summary>모듈 로어 미리보기 ({preview.lore.length}개)</summary>
                  {preview.lore.map((entry) => (
                    <details key={entry.id} className="risu-import-lore-entry">
                      <summary>{entry.title || '제목 없는 로어'}</summary>
                      <p className="risu-import-lore-text">{entry.text || '(내용 없음)'}</p>
                    </details>
                  ))}
                </details>
              )}
              {preview.kind === 'bot' && preview.lore.length > 0 && (
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
                            {entry.enabled ? '사용 중' : '사용 안 함'} · {loreLoadingLabel(entry)}
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
                  확인하면 {preview.kind === 'module' ? '모듈이' : '봇과 채팅이'} 중복 생성되지
                  않아요. 이 창을 닫아도 요청은 유지돼요.
                </p>
              )}
              {result ? (
                <div className="risu-import-result">
                  <p role="status">
                    {importedModule(result)
                      ? '모듈을 서재에 등록했어요. 기존 채팅의 봇·페르소나·모듈 설정에서 장착해 주세요.'
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
                    : preview.kind === 'module'
                      ? '모듈 가져오기'
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
