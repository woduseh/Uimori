import { useEffect, useRef, useState } from 'react';
import type { Library, ModelRef, ModelWorkspace, TaskRole } from '../core/product.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { useModelSelection } from './model-selection.js';

export function ModelWorkspaceEditor({
  library,
  onDirtyChange,
  onManage,
}: {
  library: Library;
  onDirtyChange: (dirty: boolean) => void;
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
        routes: workspace.modelRoutes,
        translationPolicy: workspace.translationPolicy,
      });
  }, [workspace, dirty, busy]);
  useEffect(() => {
    onDirtyChange(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  if (!draft)
    return (
      <p role="status">
        {error || '현재 모델 설정을 불러오는 중이에요…'}{' '}
        <button type="button" onClick={() => void refresh()}>
          다시 불러오기
        </button>
      </p>
    );
  const conflict = !!workspace && workspace.revision > draft.revision;
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
                  : '모델 또는 연결 비활성'}
              </option>
            ))}
        </select>
        {selected && (!model || !canSelect(model)) && (
          <small role="status">
            이 모델을 사용할 수 없어 새 작업을 시작할 수 없어요. 모델 프리셋과 연결을 확인하거나
            다른 모델을 선택해 주세요.
          </small>
        )}
      </label>
    );
  };
  return (
    <section aria-label="현재 모델 설정" className="settings-section">
      <p>
        모든 채팅의 이후 요청에 적용해요. 진행 중인 작업과 과거 실행·결과의 설정은 바뀌지 않아요.
      </p>
      <fieldset disabled={busy} className="control-grid">
        {selector('원문 모델', draft.routes.main, (ref) =>
          change({ ...draft, routes: { ...draft.routes, main: ref } })
        )}
        <fieldset className="control-grid">
          <legend>번역</legend>
          {selector('번역 모델', draft.routes.translation, (ref) =>
            change({ ...draft, routes: { ...draft.routes, translation: ref } })
          )}
          {selector('번역 거절 판정 모델', draft.translationPolicy.refusalModel, (ref) =>
            change({
              ...draft,
              translationPolicy: { ...draft.translationPolicy, refusalModel: ref },
            })
          )}
          <details>
            <summary>거절 감지와 재시도 상세 설정</summary>
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
            <small>
              명확한 거절일 때만 추가 번역을 요청해요. 기본 1회, 0이면 자동 재요청을 꺼요.
            </small>
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
          </details>
        </fieldset>
        {(['status', 'image'] as TaskRole[]).map((role, index) => (
          <div key={role}>
            {selector(['표시 상태 모델', '이미지 배치 모델'][index], draft.routes[role], (ref) =>
              change({ ...draft, routes: { ...draft.routes, [role]: ref } })
            )}
          </div>
        ))}
        <div>
          {selector('채팅 제목 모델', draft.titleModel ?? null, (ref) =>
            change({ ...draft, titleModel: ref })
          )}
          <small>
            새 채팅의 첫 응답이 성공하면 제목을 한 번 만들어요. 직접 바꾼 제목은 유지해요.
            미지정하면 자동 제목을 만들지 않아요.
          </small>
        </div>
        <div className="form-actions">
          <button
            type="button"
            disabled={
              !dirty ||
              conflict ||
              !Number.isInteger(draft.translationPolicy.maxRetries) ||
              draft.translationPolicy.maxRetries < 0 ||
              draft.translationPolicy.maxRetries > 5 ||
              !Number.isInteger(draft.translationPolicy.maxCalls) ||
              draft.translationPolicy.maxCalls < 2 ||
              draft.translationPolicy.maxCalls > 64
            }
            onClick={() => {
              if (lock.current) return;
              lock.current = true;
              setBusy(true);
              setSaveError('');
              setMessage('');
              void api<ModelWorkspace>(
                '/model-workspace',
                {
                  expectedRevision: draft.revision,
                  routes: draft.routes,
                  titleModel: draft.titleModel ?? null,
                  translationPolicy: draft.translationPolicy,
                },
                'PUT'
              )
                .then(async (accepted) => {
                  setDraft(accepted);
                  setDirty(false);
                  await refresh();
                  setMessage('현재 모델 설정을 저장했어요. 모든 채팅의 이후 요청에 적용해요.');
                })
                .catch((caught: Error) => setSaveError(caught.message))
                .finally(() => {
                  lock.current = false;
                  setBusy(false);
                });
            }}
          >
            {busy ? '저장 중…' : '현재 모델 설정 저장'}
          </button>
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
              최신 설정 다시 불러오기
            </button>
          )}
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
        모델 프리셋·연결 관리
      </button>
    </section>
  );
}
