import { useRef, useState } from 'react';
import type { Library } from '../core/product.js';
import { NATIVE_TRANSFER_MAX_BYTES } from '../core/native-transfer.js';
import type {
  NativeTransferFile,
  NativeTransferModelBinding,
  NativeTransferPrepare,
  NativeTransferReceipt,
} from '../core/native-transfer.js';
import { ApiError, api, saveDownload } from './api.js';
import { Dialog } from './Dialog.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { IconButton } from './IconButton.js';
import { DownloadIcon } from './ui-icons.js';
import './native-transfer.css';

type ApplyRequest = {
  file: NativeTransferFile;
  digest: string;
  modelBindings: NativeTransferModelBinding[];
  idempotencyKey: string;
};
const categoryLabels: Record<string, string> = {
  bot: '봇',
  persona: '페르소나',
  module: '모듈',
  main: '작문 프롬프트',
  translation: '번역 프롬프트',
};

/** The dialog preserves its prepared file and uncertain submission when closed. */
export function NativeTransfer({
  library,
  reload,
}: {
  library: Library;
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [file, setFile] = useState<NativeTransferFile | null>(null);
  const [filename, setFilename] = useState('');
  const [prepared, setPrepared] = useState<NativeTransferPrepare | null>(null);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<NativeTransferReceipt | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const submission = useRef<ApplyRequest | null>(null);
  const requestKey = useRef<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const items = [
    ...library.contents.map((item) => ({
      kind: 'content' as const,
      id: item.id,
      title: item.title,
      category: item.kind,
    })),
    ...(library.promptPresets ?? []).map((item) => ({
      kind: 'prompt-preset' as const,
      id: item.id,
      title: item.title,
      category: item.role,
    })),
  ];
  const availableModels = library.models.filter(
    (model) =>
      model.enabled !== false &&
      library.connections.some(
        (connection) => connection.id === model.connectionId && connection.enabled
      )
  );
  const ready =
    !!prepared &&
    (uncertain ||
      prepared.modelRequirements.every(
        (requirement) =>
          bindings[requirement.key] === 'inherit-main' ||
          availableModels.some((model) => model.id === bindings[requirement.key])
      ));

  async function prepare(input: File) {
    if (active.current || uncertain) return;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (input.size > NATIVE_TRANSFER_MAX_BYTES)
        throw new Error('자료 파일은 64 MB 이하여야 해요.');
      const parsed = JSON.parse(await input.text()) as NativeTransferFile;
      const result = await api<NativeTransferPrepare>('/native-transfers/prepare', {
        file: parsed,
      });
      setFile(parsed);
      setFilename(input.name);
      setPrepared(result);
      setBindings({});
      setReceipt(null);
      submission.current = null;
      requestKey.current = null;
    } catch (cause) {
      setError(`${(cause as Error).message}${prepared ? ' 앞서 확인한 파일은 유지했어요.' : ''}`);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  async function apply() {
    if (active.current || !file || !prepared || !ready || receipt) return;
    const payload = submission.current ?? {
      file,
      digest: prepared.digest,
      modelBindings: prepared.modelRequirements.map(
        (requirement): NativeTransferModelBinding =>
          bindings[requirement.key] === 'inherit-main'
            ? { requirementKey: requirement.key, mode: 'inherit-main' }
            : {
                requirementKey: requirement.key,
                mode: 'local',
                model: { id: bindings[requirement.key] },
              }
      ),
      idempotencyKey: (requestKey.current ??= crypto.randomUUID()),
    };
    submission.current = payload;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<NativeTransferReceipt>('/native-transfers/apply', payload);
      setReceipt(result);
      setUncertain(false);
      try {
        await reload();
      } catch {
        setNotice('가져오기는 완료했어요. 목록을 다시 열면 저장한 자료를 확인할 수 있어요.');
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

  async function download() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const selection = items.filter((item) => selected.includes(`${item.kind}:${item.id}`));
      const result = await api<NativeTransferFile>('/native-transfers/export', {
        items: selection.map(({ kind, id }) => ({ kind, id })),
      });
      saveDownload('자료.uimori-library.json', result, true);
      setNotice('연결된 모듈·이미지·프롬프트 옵션 조합을 포함해 파일을 준비했어요.');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <IconButton
        label="자료 파일 가져오기·내보내기"
        className="secondary"
        icon={DownloadIcon}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        title="자료 파일 가져오기·내보내기"
        onClose={() => setOpen(false)}
        className="native-transfer-dialog"
        wide
      >
        <div className="native-transfer-tabs" role="group" aria-label="자료 파일 작업">
          <button
            type="button"
            className="secondary"
            aria-pressed={tab === 'import'}
            onClick={() => setTab('import')}
          >
            가져오기
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={tab === 'export'}
            onClick={() => setTab('export')}
          >
            내보내기
          </button>
        </div>
        {tab === 'import' ? (
          <section aria-label="자료 파일 가져오기" className="native-transfer-body">
            <p className="muted">
              봇·페르소나·모듈·프롬프트와 연결된 자료를 확인하고 새 사본으로 저장해요.
            </p>
            <label>
              Uimori 자료 파일
              <input
                type="file"
                aria-label="자료 파일 선택"
                accept=".json,application/json"
                disabled={busy || uncertain}
                onChange={(event) => {
                  const input = event.target.files?.[0];
                  event.target.value = '';
                  if (input) void prepare(input);
                }}
              />
            </label>
            {prepared && (
              <>
                <p>
                  <strong>{filename}</strong>
                </p>
                <p>
                  자료 {prepared.summary.contents}개 · 프롬프트 {prepared.summary.prompts}개 · 옵션
                  조합 {prepared.summary.combinations}개 · 이미지 {prepared.summary.images}개
                </p>
                <details>
                  <summary>가져올 항목 확인</summary>
                  <ul className="native-transfer-entries">
                    {prepared.entries.map((entry) => (
                      <li key={entry.key}>
                        <strong>{entry.title}</strong>{' '}
                        <small>
                          {categoryLabels[entry.category] ?? entry.category}
                          {entry.root ? '' : ' · 연결 자료'}
                        </small>
                      </li>
                    ))}
                  </ul>
                </details>
                {prepared.warnings.length > 0 && (
                  <ul>
                    {prepared.warnings.map((warning, index) => (
                      <li key={`${warning.code}:${warning.key}:${index}`}>{warning.message}</li>
                    ))}
                  </ul>
                )}
                {prepared.modelRequirements.length > 0 && (
                  <fieldset disabled={busy || uncertain || !!receipt}>
                    <legend>보조 모델 연결</legend>
                    <p className="muted">
                      원본 프롬프트에 지정된 보조 모델을 이 설치의 모델에 연결해 주세요.
                    </p>
                    {prepared.modelRequirements.map((requirement) => (
                      <label key={requirement.key}>
                        {requirement.promptTitle} · {requirement.agentTitle}
                        <select
                          aria-label={`${requirement.promptTitle} · ${requirement.agentTitle} 모델 연결`}
                          value={bindings[requirement.key] ?? ''}
                          onChange={(event) => {
                            setBindings((current) => ({
                              ...current,
                              [requirement.key]: event.target.value,
                            }));
                            requestKey.current = null;
                            submission.current = null;
                            setError('');
                          }}
                        >
                          <option value="">사용할 모델 선택</option>
                          <option value="inherit-main">실행 시 본문 모델 사용</option>
                          {availableModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </fieldset>
                )}
                {uncertain && (
                  <p role="status">
                    서버의 완료 여부를 확인하지 못했어요. 같은 요청으로 다시 확인하면 사본이 중복
                    생성되지 않아요.
                  </p>
                )}
                {receipt ? (
                  <p role="status">
                    자료 {receipt.summary.contents}개와 프롬프트 {receipt.summary.prompts}개를 새
                    사본으로 가져왔어요.
                  </p>
                ) : (
                  <button type="button" disabled={busy || !ready} onClick={() => void apply()}>
                    {uncertain ? '같은 요청으로 다시 확인' : '새 사본으로 가져오기'}
                  </button>
                )}
              </>
            )}
          </section>
        ) : (
          <section aria-label="자료 파일 내보내기" className="native-transfer-body">
            <p className="muted">
              저장된 자료를 선택해 주세요. 연결된 모듈·이미지와 프롬프트의 옵션 조합도 함께 담아요.
            </p>
            <label>
              내보낼 자료 찾기
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="native-transfer-selection">
              {items
                .filter(
                  (item) =>
                    !query || item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
                )
                .map((item) => {
                  const key = `${item.kind}:${item.id}`;
                  return (
                    <label key={key}>
                      <SelectionCheckbox
                        aria-label={`${item.title} 내보내기`}
                        disabled={busy}
                        checked={selected.includes(key)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, key]
                              : current.filter((value) => value !== key)
                          )
                        }
                      />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{categoryLabels[item.category] ?? item.category}</small>
                      </span>
                    </label>
                  );
                })}
            </div>
            <button
              type="button"
              disabled={busy || !items.some((item) => selected.includes(`${item.kind}:${item.id}`))}
              onClick={() => void download()}
            >
              선택한 자료 내보내기
            </button>
          </section>
        )}
        {busy && <p role="status">자료 파일을 처리하고 있어요…</p>}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
