import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useEffect, useRef, useState } from 'react';
import type { Library, ModelRef, ModelWorkspace } from '../core/product.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { useModelSelection } from './model-selection.js';
import { RefreshIcon, SettingsIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { SaveButton } from './SaveButton.js';
import { ToggleRow } from './ToggleRow.js';
import './settings-actions.css';

export function ModelWorkspaceEditor({
  library,
  onDirtyChange,
  onSaveHandlerChange,
  onManage,
}: {
  library: Library;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onManage: () => void;
}) {
  const { workspace, error, refresh } = usePromptWorkspace();
  const [draft, setDraft] = useState<ModelWorkspace | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const { canSelect } = useModelSelection(library.models, library.connections);
  useEffect(() => {
    if (workspace && !dirty && !busy)
      setDraft({
        revision: workspace.revision,
        titleModel: workspace.titleModel ?? null,
        helperModel: workspace.helperModel ?? null,
        contextModel: workspace.contextModel ?? null,
        scriptModel: workspace.scriptModel ?? null,
        routes: workspace.modelRoutes,
        mainJudgmentEnabled: workspace.mainJudgmentEnabled !== false,
        translationPolicy: workspace.translationPolicy,
      });
  }, [workspace, dirty, busy]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => (!draft ? false : save()));
  if (!draft)
    return (
      <p role="status" className="settings-loading-status">
        {error || '역할별 모델 설정을 불러오는 중이에요…'}{' '}
        <IconButton
          icon={RefreshIcon}
          label="다시 불러오기"
          className="secondary"
          onClick={() => void refresh()}
        />
      </p>
    );
  const conflict = !!workspace && workspace.revision > draft.revision;
  const invalid =
    conflict ||
    !Number.isInteger(draft.translationPolicy.maxRetries) ||
    draft.translationPolicy.maxRetries < 0 ||
    draft.translationPolicy.maxRetries > 5 ||
    !Number.isInteger(draft.translationPolicy.maxCalls) ||
    draft.translationPolicy.maxCalls < 2 ||
    draft.translationPolicy.maxCalls > 64 ||
    !Number.isFinite(draft.translationPolicy.judgment.threshold) ||
    draft.translationPolicy.judgment.threshold <= 0.5 ||
    draft.translationPolicy.judgment.threshold > 1;
  async function save() {
    if (!draft || lock.current || invalid) return false;
    if (!dirty) return true;
    lock.current = true;
    setBusy(true);
    setSaveError('');
    setMessage('');
    return api<ModelWorkspace>(
      '/model-workspace',
      {
        expectedRevision: draft.revision,
        routes: draft.routes,
        mainJudgmentEnabled: draft.mainJudgmentEnabled !== false,
        titleModel: draft.titleModel ?? null,
        helperModel: draft.helperModel ?? null,
        contextModel: draft.contextModel ?? null,
        scriptModel: draft.scriptModel ?? null,
        translationPolicy: draft.translationPolicy,
      },
      'PUT'
    )
      .then(async (accepted) => {
        setDraft(accepted);
        setDirty(false);
        await refresh();
        setMessage('역할별 모델 설정을 저장했어요. 모든 채팅의 이후 요청에 적용해요.');
        return true;
      })
      .catch((caught: Error) => {
        setSaveError(caught.message);
        return false;
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  }
  function change(next: ModelWorkspace) {
    setDraft(next);
    setDirty(true);
    setMessage('');
  }
  const selector = (
    label: string,
    selected: ModelRef | null,
    onChange: (ref: ModelRef | null) => void
  ) => {
    const model = library.models.find((item) => item.id === selected?.id);
    return (
      <label>
        {label === '원문 모델' ? '본문 모델' : label}
        <select
          aria-label={label}
          value={selected?.id ?? ''}
          onChange={(event) => onChange(event.target.value ? { id: event.target.value } : null)}
        >
          <option value="">모델 미지정</option>
          {selected && !model && (
            <option value={selected.id}>선택한 모델 · 삭제되었거나 확인 필요</option>
          )}
          {library.models
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
          <small role="status">
            이 모델을 사용할 수 없어 새 작업을 시작할 수 없어요. 모델 프리셋과 프로바이더를
            확인하거나 다른 모델을 선택해 주세요.
          </small>
        )}
      </label>
    );
  };
  return (
    <section aria-label="역할별 모델 설정" className="settings-section">
      <p>
        모든 채팅의 이후 요청에 적용해요. 진행 중인 작업과 과거 실행·결과의 설정은 바뀌지 않아요.
      </p>
      <section aria-label="본문 서비스 거절 감지" className="model-secondary-settings">
        <h3>본문 서비스 거절 감지</h3>
        <ToggleRow
          label="본문 서비스 거절 감지 사용"
          checked={draft.mainJudgmentEnabled !== false}
          disabled={busy}
          onChange={(enabled) => change({ ...draft, mainJudgmentEnabled: enabled })}
        />
        <p>
          켜면 JEV가 전체 본문에서 명시적 서비스 거절만 검사해요. 거절 확신 기준은 0.9로 고정돼요.
          기준 미만이면 정상 응답으로 채택해요.
        </p>
        <p>끄면 JEV 거절 판정 없이 생성된 본문을 채택해요. 생성 자체의 오류는 계속 처리해요.</p>
        <p>
          거절하거나 JEV 판정에 실패하면 출력을 보존하고 원문으로 채택하지 않아요. 자동으로
          재생성하지 않아요.
        </p>
      </section>
      <fieldset disabled={busy} className="control-grid">
        {selector('원문 모델', draft.routes.main, (ref) =>
          change({ ...draft, routes: { ...draft.routes, main: ref } })
        )}
        {selector('번역 모델', draft.routes.translation, (ref) =>
          change({ ...draft, routes: { ...draft.routes, translation: ref } })
        )}
        <div>
          {selector('도우미 모델', draft.helperModel ?? null, (ref) =>
            change({ ...draft, helperModel: ref })
          )}
          <small>
            작품 질문과 자료 작업에 사용해요. 미지정하면 도우미의 모델 실행을 시작하지 않아요.
          </small>
        </div>
        <div>
          {selector('문맥 요약 모델', draft.contextModel ?? null, (ref) =>
            change({ ...draft, contextModel: ref })
          )}
          <small>
            자동·수동 요약에 사용해요. 미지정하면 압축이 필요한 작업만 멈추며 다른 모델로 대체하지
            않아요.
          </small>
        </div>
        <div>
          {selector('확장 호출 모델', draft.scriptModel ?? null, (ref) =>
            change({ ...draft, scriptModel: ref })
          )}
          <small>
            사용자가 허용한 패키지 코드의 추가 생성 요청에 사용해요. 미지정하면 추가 호출을 시작하지
            않아요.
          </small>
        </div>
        <details className="full model-secondary-settings">
          <summary>
            기타 자동 작업 모델 <small>장면 해설 · 채팅 제목</small>
          </summary>
          <div className="control-grid">
            <div>
              {selector('장면 해설 모델', draft.routes.status, (ref) =>
                change({ ...draft, routes: { ...draft.routes, status: ref } })
              )}
            </div>
            <div>
              {selector('채팅 제목 모델', draft.titleModel ?? null, (ref) =>
                change({ ...draft, titleModel: ref })
              )}
            </div>
          </div>
        </details>
        <details className="full model-secondary-settings">
          <summary>
            번역 서비스 거절 감지와 자동 재시도 <small>세부 설정</small>
          </summary>
          <div className="control-grid">
            <ToggleRow
              label="번역 서비스 거절 감지 사용"
              checked={draft.translationPolicy.judgment.enabled !== false}
              onChange={(enabled) =>
                change({
                  ...draft,
                  translationPolicy: {
                    ...draft.translationPolicy,
                    judgment: { ...draft.translationPolicy.judgment, enabled },
                  },
                })
              }
            />
            <p>
              켜면 JEV가 전체 번역문에서 명시적 서비스 거절만 검사해요. 이 설정은 번역에만 적용되며
              본문 판정에는 적용되지 않아요.
            </p>
            <p>
              끄면 JEV 거절 판정과 거절에 따른 자동 재시도 없이 생성된 번역을 채택해요. 빈 출력·부분
              출력·공급자 오류 같은 생성 오류는 계속 처리해요.
            </p>
            <label>
              번역 거절 확신 기준
              <input
                aria-label="번역 거절 확신 기준"
                type="number"
                min="0.51"
                max="1"
                step="0.01"
                value={
                  Number.isFinite(draft.translationPolicy.judgment.threshold)
                    ? draft.translationPolicy.judgment.threshold
                    : ''
                }
                onChange={(event) =>
                  change({
                    ...draft,
                    translationPolicy: {
                      ...draft.translationPolicy,
                      judgment: {
                        ...draft.translationPolicy.judgment,
                        threshold: event.target.valueAsNumber,
                      },
                    },
                  })
                }
              />
              <small>
                0.5 초과–1. 기준 이상인 명시적 거절만 자동 재요청해요. 기준 미만이면 번역으로
                채택해요. JEV 판정에 실패하면 후보와 이전 성공 번역을 보존하고 자동 재호출 없이
                중단해요. 프로바이더·모델 등록의 JEV 판단에서 연결을 확인할 수 있어요.
              </small>
            </label>
            <label>
              자동 재요청 횟수
              <input
                aria-label="번역 자동 재요청 횟수"
                type="number"
                min={0}
                max={5}
                step={1}
                value={
                  Number.isFinite(draft.translationPolicy.maxRetries)
                    ? draft.translationPolicy.maxRetries
                    : ''
                }
                onChange={(event) =>
                  change({
                    ...draft,
                    translationPolicy: {
                      ...draft.translationPolicy,
                      maxRetries: event.target.valueAsNumber,
                    },
                  })
                }
              />
            </label>
            <label>
              번역 작업 전체 호출 한도
              <input
                aria-label="번역 전체 호출 한도"
                type="number"
                min={2}
                max={64}
                step={1}
                value={
                  Number.isFinite(draft.translationPolicy.maxCalls)
                    ? draft.translationPolicy.maxCalls
                    : ''
                }
                onChange={(event) =>
                  change({
                    ...draft,
                    translationPolicy: {
                      ...draft.translationPolicy,
                      maxCalls: event.target.valueAsNumber,
                    },
                  })
                }
              />
            </label>
          </div>
        </details>
        <div className="form-actions settings-save-actions full">
          {(dirty || conflict) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDirty(false);
                setSaveError('');
                void refresh();
              }}
            >
              <RefreshIcon size={18} aria-hidden="true" />
              최신 설정 다시 불러오기
            </button>
          )}
          <SaveButton
            type="button"
            label="역할별 모델 설정 저장"
            aria-busy={busy}
            disabled={!dirty || invalid}
            onClick={() => void save()}
          />
        </div>
      </fieldset>
      {conflict && dirty && (
        <p role="alert">
          다른 곳에서 전역 설정이 바뀌었어요. 초안은 유지했어요. 최신 설정을 불러온 뒤 다시 적용해
          주세요.
        </p>
      )}
      {saveError && <p role="alert">{saveError} 초안은 유지했어요.</p>}
      <p role="status">{message || error}</p>
      <button type="button" className="secondary" onClick={onManage}>
        <SettingsIcon size={18} aria-hidden="true" />
        모델 프리셋·프로바이더 관리{' '}
      </button>
    </section>
  );
}
