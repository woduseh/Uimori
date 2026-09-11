import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshIcon } from './ui-icons.js';
import type { Library, ModelRef } from '../core/product.js';
import type { IllustrationSettings } from '../core/illustration.js';
import { api, ApiError } from './api.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { Switch } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useModelSelection } from './model-selection.js';
import { useTestMode } from './useTestMode.js';
import { illustrationErrorMessage } from './illustration-labels.js';
import './settings-actions.css';
import './illustrations.css';

type Draft = Omit<IllustrationSettings, 'revision'> & { revision: number };
type TestResult =
  | {
      ok: true;
      system: { os: string | null; comfyuiVersion: string | null };
      devices: { name: string; vramTotal: number | null }[];
    }
  | { ok: false; code: string; nodeErrors?: unknown };

/** Global illustration settings. Frozen into each job at reservation; running jobs keep their copy. */
export function IllustrationSettingsEditor({
  library,
  onDirtyChange,
}: {
  library: Library;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<IllustrationSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [message, setMessage] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const lock = useRef(false);
  const testMode = useTestMode();
  const { canSelect } = useModelSelection(library.models, library.connections);
  const load = useCallback(async () => {
    try {
      const value = await api<IllustrationSettings>('/illustration-settings');
      setSaved(value);
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (saved && !dirty && !busy) setDraft(structuredClone(saved));
  }, [saved, dirty, busy]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  if (!draft)
    return (
      <p role="status" className="settings-loading-status">
        {loadError || '삽화 설정을 불러오는 중이에요…'}{' '}
        <IconButton
          icon={RefreshIcon}
          label="다시 불러오기"
          className="secondary"
          onClick={() => void load()}
        />
      </p>
    );
  const conflict = !!saved && saved.revision > draft.revision;
  const change = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setMessage('');
  };
  const codexModels = library.models.filter(
    (model) =>
      library.connections.find((connection) => connection.id === model.connectionId)?.protocol ===
      'codex-app-server-v1'
  );
  const selector = (
    label: string,
    selected: ModelRef | null,
    models: Library['models'],
    onChange: (ref: ModelRef | null) => void,
    emptyLabel = '모델 미지정'
  ) => {
    const model = library.models.find((item) => item.id === selected?.id);
    return (
      <label>
        {label}
        <select
          aria-label={label}
          value={selected?.id ?? ''}
          onChange={(event) => onChange(event.target.value ? { id: event.target.value } : null)}
        >
          <option value="">{emptyLabel}</option>
          {selected && !models.some((item) => item.id === selected.id) && (
            <option value={selected.id}>선택한 모델 · 삭제되었거나 확인 필요</option>
          )}
          {models
            .filter((item) => canSelect(item) || item.id === selected?.id)
            .map((item) => (
              <option key={item.id} value={item.id} disabled={!canSelect(item)}>
                {item.title} ·{' '}
                {canSelect(item)
                  ? library.connections.find((connection) => connection.id === item.connectionId)
                      ?.title
                  : '모델 또는 프로바이더 비활성'}
              </option>
            ))}
        </select>
        {selected && (!model || !canSelect(model)) && (
          <small role="status">이 모델을 사용할 수 없어 새 삽화 작업을 시작할 수 없어요.</small>
        )}
      </label>
    );
  };
  const numberField = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
    step = 1
  ) => (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </label>
  );
  const valid =
    Number.isInteger(draft.maxPerSource) &&
    draft.maxPerSource >= 1 &&
    draft.maxPerSource <= 8 &&
    Number.isInteger(draft.maxAutoRetries) &&
    draft.maxAutoRetries >= 0 &&
    draft.maxAutoRetries <= 5 &&
    Number.isInteger(draft.comfyui.timeoutMs) &&
    draft.comfyui.timeoutMs >= 10_000 &&
    Number.isInteger(draft.comfyui.pollIntervalMs) &&
    draft.comfyui.pollIntervalMs >= 250;
  const save = () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setSaveError('');
    setMessage('');
    const { revision, ...body } = draft;
    void api<IllustrationSettings>(
      '/illustration-settings',
      { expectedRevision: revision, ...body },
      'PUT'
    )
      .then(async (accepted) => {
        setSaved(accepted);
        setDraft(structuredClone(accepted));
        setDirty(false);
        setMessage('삽화 설정을 저장했어요. 이후 예약하는 삽화 작업부터 적용해요.');
      })
      .catch((caught: Error) => setSaveError(caught.message))
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  };
  const reload = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setLoadError('');
    setMessage('');
    try {
      const value = await api<IllustrationSettings>('/illustration-settings');
      setSaved(value);
      setDraft(structuredClone(value));
      setDirty(false);
      setSaveError('');
      setMessage('');
      setConfirmReload(false);
    } catch {
      setLoadError('설정을 불러오지 못했어요. 초안은 유지했어요.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const result = await api<{
        system: { os: string | null; comfyuiVersion: string | null };
        devices: { name: string; vramTotal: number | null }[];
      }>('/illustration-settings/comfyui/test', {
        baseUrl: draft.comfyui.baseUrl,
        authorizationEnv: draft.comfyui.authorizationEnv,
      });
      setTest({ ok: true, ...result });
    } catch (error) {
      const raw = error instanceof ApiError ? error.message : '';
      let code = 'COMFYUI_UNREACHABLE';
      try {
        const parsed = JSON.parse(raw) as { code?: string };
        if (typeof parsed.code === 'string') code = parsed.code;
      } catch {
        if (error instanceof ApiError && error.status === 400) code = 'COMFYUI_BASE_URL_INVALID';
      }
      setTest({ ok: false, code });
    } finally {
      setTesting(false);
    }
  };
  return (
    <section aria-label="삽화 설정" className="settings-section illustration-settings">
      <p>완성된 장면의 삽화를 만들어요. 설정은 새 작업부터 적용해요.</p>
      <fieldset disabled={busy} className="control-grid">
        <label>
          삽화 생성기
          <select
            aria-label="삽화 생성기"
            value={draft.generator}
            onChange={(event) =>
              change({
                ...draft,
                generator: event.target.value as IllustrationSettings['generator'],
              })
            }
          >
            <option value="none">사용 안 함</option>
            <option value="codex">Codex · ChatGPT 구독의 이미지 생성</option>
            <option value="comfyui">ComfyUI · 원격 PC의 API</option>
            {(testMode || draft.generator === 'fixture') && (
              <option value="fixture">모의 생성기 (테스트 모드)</option>
            )}
          </select>
        </label>
        <label className="check">
          <Switch
            aria-label="응답 완료 후 자동 삽화 생성"
            checked={draft.automatic}
            onChange={(event) => change({ ...draft, automatic: event.target.checked })}
          />
          자동 생성
        </label>
        <small className="full">응답이 완성되면 삽화를 만들어요.</small>
        {numberField('장면당 최대 삽화 개수', draft.maxPerSource, 1, 8, (value) =>
          change({ ...draft, maxPerSource: value })
        )}
        {numberField('자동 재요청 횟수', draft.maxAutoRetries, 0, 5, (value) =>
          change({ ...draft, maxAutoRetries: value })
        )}
        <small className="full">일시적인 오류가 나면 설정한 횟수만큼 다시 시도해요.</small>
        <label className="full">
          그림 지침
          <textarea
            aria-label="삽화 그림 지침"
            rows={3}
            maxLength={2000}
            value={draft.styleGuidance}
            placeholder="예: 수채화, 부드러운 빛, 인물 중심 구성"
            onChange={(event) => change({ ...draft, styleGuidance: event.target.value })}
          />
        </label>
        {draft.generator === 'codex' && (
          <fieldset className="control-grid full">
            <legend>Codex</legend>
            {selector(
              'Codex 삽화 모델',
              draft.codex.model,
              codexModels,
              (ref) => change({ ...draft, codex: { ...draft.codex, model: ref } }),
              codexModels.length ? '모델 미지정' : 'Codex 프로바이더의 모델 프리셋이 없어요'
            )}
            <small className="full">
              에이전트에서 로그인한 Codex 프로바이더의 모델을 선택해요.
            </small>
            <label className="check">
              <Switch
                aria-label="채팅의 참조 이미지 사용"
                checked={draft.codex.useReferences}
                onChange={(event) =>
                  change({
                    ...draft,
                    codex: { ...draft.codex, useReferences: event.target.checked },
                  })
                }
              />
              채팅의 참조 이미지 사용
            </label>
          </fieldset>
        )}
        {draft.generator === 'comfyui' && (
          <fieldset className="control-grid full">
            <legend>ComfyUI</legend>
            <label className="full">
              ComfyUI 주소
              <input
                aria-label="ComfyUI 주소"
                type="url"
                placeholder="http://192.168.0.10:8188"
                value={draft.comfyui.baseUrl}
                onChange={(event) =>
                  change({ ...draft, comfyui: { ...draft.comfyui, baseUrl: event.target.value } })
                }
              />
            </label>
            <label>
              인증 헤더 환경변수 (선택)
              <input
                aria-label="ComfyUI 인증 환경변수"
                type="text"
                placeholder="NR_COMFYUI_AUTHORIZATION"
                value={draft.comfyui.authorizationEnv}
                onChange={(event) =>
                  change({
                    ...draft,
                    comfyui: { ...draft.comfyui, authorizationEnv: event.target.value },
                  })
                }
              />
            </label>
            <small className="full">인증이 필요한 서버에서만 입력해요.</small>
            <div className="illustration-test full">
              <button
                type="button"
                className="secondary"
                disabled={testing || !draft.comfyui.baseUrl.trim()}
                onClick={() => void runTest()}
              >
                {testing ? '연결 확인 중…' : 'ComfyUI 연결 확인'}
              </button>
              {test && (
                <span className="illustration-test-result" role="status">
                  {test.ok
                    ? `연결됨 · ComfyUI ${test.system.comfyuiVersion ?? '버전 미확인'} · ${test.system.os ?? ''} · ${test.devices
                        .map((device) => device.name)
                        .join(', ')}`
                    : `${illustrationErrorMessage(test.code)} (${test.code})`}
                </span>
              )}
            </div>
            {selector('프롬프트 모델', draft.comfyui.promptModel, library.models, (ref) =>
              change({ ...draft, comfyui: { ...draft.comfyui, promptModel: ref } })
            )}
            <small className="full">장면을 그림 설명으로 바꿀 모델이에요.</small>
            <label className="full">
              네거티브 프롬프트 지침
              <textarea
                aria-label="ComfyUI 네거티브 프롬프트 지침"
                rows={2}
                maxLength={1000}
                value={draft.comfyui.negativeGuidance}
                placeholder="예: lowres, bad anatomy, text, watermark"
                onChange={(event) =>
                  change({
                    ...draft,
                    comfyui: { ...draft.comfyui, negativeGuidance: event.target.value },
                  })
                }
              />
            </label>
            <label className="full">
              워크플로 JSON (API 형식)
              <textarea
                aria-label="ComfyUI 워크플로 JSON"
                rows={10}
                value={draft.comfyui.workflow}
                placeholder="ComfyUI에서 내보낸 API 형식 JSON을 넣어요."
                onChange={(event) =>
                  change({ ...draft, comfyui: { ...draft.comfyui, workflow: event.target.value } })
                }
              />
            </label>
            <details className="full">
              <summary>워크플로 작성 도움말</summary>
              <p>ComfyUI에서 API 형식으로 내보낸 JSON을 사용해요.</p>
              <p>
                문자열 입력의 {'{{prompt}}'}는 그림 설명, {'{{negative}}'}는 네거티브 프롬프트,
                {'{{seed}}'}는 시드로 바뀌어요. 모델·해상도는 워크플로에서 정하고 SaveImage 노드의
                이미지를 가져와요.
              </p>
              <p>인증 환경변수의 값은 Authorization 헤더로 보내요.</p>
            </details>
            {numberField(
              '시간 제한 (초)',
              draft.comfyui.timeoutMs / 1000,
              10,
              1800,
              (value) =>
                change({
                  ...draft,
                  comfyui: { ...draft.comfyui, timeoutMs: Math.round(value * 1000) },
                }),
              1
            )}
            {numberField(
              '확인 간격 (초)',
              draft.comfyui.pollIntervalMs / 1000,
              0.25,
              10,
              (value) =>
                change({
                  ...draft,
                  comfyui: { ...draft.comfyui, pollIntervalMs: Math.round(value * 1000) },
                }),
              0.25
            )}
          </fieldset>
        )}
        <div className="form-actions settings-save-actions full">
          <IconButton
            icon={RefreshIcon}
            label="저장된 설정 다시 불러오기"
            className="secondary"
            aria-busy={busy}
            onClick={() => (dirty ? setConfirmReload(true) : void reload())}
          />
          <SaveButton
            type="button"
            label="삽화 설정 저장"
            aria-busy={busy}
            disabled={!dirty || conflict || !valid}
            onClick={save}
          />
        </div>
      </fieldset>
      <Dialog
        open={confirmReload}
        title="삽화 설정 다시 불러오기"
        role="alertdialog"
        onClose={() => {
          if (!busy) setConfirmReload(false);
        }}
      >
        <p>저장된 설정을 불러오면 현재 초안이 사라져요.</p>
        {loadError && (
          <p role="alert" className="error">
            {loadError}
          </p>
        )}
        <DraftDiscardActions
          open={confirmReload}
          disabled={busy}
          onContinue={() => setConfirmReload(false)}
          onDiscard={reload}
          discardLabel="초안 버리고 불러오기"
        />
      </Dialog>
      {conflict && dirty && (
        <p role="alert">
          다른 곳에서 삽화 설정이 바뀌었어요. 초안은 유지했어요. 최신 설정을 불러온 뒤 다시 적용해
          주세요.
        </p>
      )}
      {saveError && <p role="alert">{saveError} 초안은 유지했어요.</p>}
      <p role="status">{message || loadError}</p>
    </section>
  );
}
