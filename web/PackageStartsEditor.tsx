import { useEffect, useState } from 'react';
import type { ContentPackage } from '../core/content-package.js';
import { behaviorActionTriggers, type BehaviorSchema } from '../core/package-behavior.js';
import { validatePackageStarts, type PackageStart } from '../core/package-start.js';
import type { PromptExpression, RuntimeValue } from '../core/prompt-program.js';
import { PackageControlValues } from './PackageControlValues.js';

function initialInput(schema: BehaviorSchema): RuntimeValue {
  switch (schema.type) {
    case 'record':
      return Object.fromEntries(
        Object.entries(schema.properties).map(([key, child]) => [key, initialInput(child)])
      );
    case 'list':
      return [];
    case 'enum':
      return schema.values[0];
    case 'boolean':
      return false;
    case 'number':
      return schema.min;
    case 'string':
      return '';
  }
}

export function PackageStartsEditor({
  value,
  onChange,
  onDraftChange,
}: {
  value: ContentPackage;
  onChange: (value: ContentPackage) => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const [selected, setSelected] = useState(value.starts?.[0]?.id ?? '');
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    onDraftChange?.(!!draft);
  }, [draft, onDraftChange]);
  useEffect(
    () => () => {
      onDraftChange?.(false);
    },
    [onDraftChange]
  );
  const starts = value.starts ?? [],
    active = starts.find((item) => item.id === selected);
  const actions =
    value.behavior?.actions.filter((action) => behaviorActionTriggers(action).includes('user')) ??
    [];
  function update(next: PackageStart) {
    onChange({ ...value, starts: starts.map((item) => (item.id === next.id ? next : item)) });
  }
  return (
    <details className="full package-start-editor">
      <summary>도입문과 시작 선택 ({starts.length})</summary>
      <p className="muted">
        같은 자료로 시작할 때 작성한 도입문을 사용하거나 선택한 요청으로 첫 장면을 생성해요. 시작
        옵션은 이번 채팅에 저장돼요.
      </p>
      <label>
        편집할 시작
        <select
          aria-label="편집할 시작"
          value={selected}
          disabled={!!draft}
          onChange={(event) => {
            setSelected(event.target.value);
            setError('');
          }}
        >
          <option value="">시작 선택</option>
          {starts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title || '이름 없는 시작'}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="secondary"
        disabled={starts.length >= 20 || !!draft}
        onClick={() => {
          const start: PackageStart = {
            id: `start-${crypto.randomUUID()}`,
            title: '새 도입문',
            mode: 'authored',
            text: '',
          };
          onChange({ ...value, starts: [...starts, start] });
          setSelected(start.id);
        }}
      >
        시작 추가
      </button>
      {active && (
        <div className="editor-grid">
          <label>
            시작 이름
            <input
              aria-label="시작 이름"
              value={active.title}
              maxLength={200}
              onChange={(event) => update({ ...active, title: event.target.value })}
            />
          </label>
          <label>
            시작 방식
            <select
              aria-label="시작 방식"
              value={active.mode}
              onChange={(event) =>
                update({ ...active, mode: event.target.value as PackageStart['mode'] })
              }
            >
              <option value="authored">작성된 도입문</option>
              <option value="generate">모델로 첫 장면 생성</option>
            </select>
          </label>
          <label className="full">
            선택 설명
            <input
              aria-label="시작 설명"
              value={active.description ?? ''}
              maxLength={2000}
              onChange={(event) => update({ ...active, description: event.target.value })}
            />
          </label>
          <label className="full">
            {active.mode === 'authored' ? '도입문 원문' : '첫 장면 생성 요청'}
            <textarea
              aria-label="시작 본문"
              value={active.text}
              rows={8}
              maxLength={active.mode === 'generate' ? 4000 : 100000}
              onChange={(event) => update({ ...active, text: event.target.value })}
            />
          </label>
          {!!value.controls.length && (
            <div className="full">
              <h4>이 시작의 기본 옵션</h4>
              <PackageControlValues
                controls={value.controls}
                values={active.values}
                labelPrefix="시작 기본 옵션"
                onChange={(values) => update({ ...active, values })}
              />
            </div>
          )}
          {!!actions.length && (
            <div className="full">
              <label>
                확정할 때 한 번 실행할 초기 행동
                <select
                  aria-label="시작 초기 행동"
                  value={active.initialAction?.actionId ?? ''}
                  disabled={!!draft}
                  onChange={(event) => {
                    const action = actions.find((item) => item.id === event.target.value);
                    if (!action) {
                      const { initialAction: _removed, ...next } = active;
                      update(next);
                    } else
                      update({
                        ...active,
                        initialAction: {
                          actionId: action.id,
                          input: { literal: initialInput(action.inputSchema) },
                        },
                      });
                  }}
                >
                  <option value="">초기 행동 없음</option>
                  {actions.map((action) => (
                    <option key={action.id} value={action.id}>
                      {action.label || action.id}
                    </option>
                  ))}
                </select>
              </label>
              {active.initialAction && (
                <details>
                  <summary>초기 행동 입력식</summary>
                  <p className="muted">
                    선택값은 {'{"control":"옵션 ID"}'}로 읽어요. 행동 입력 스키마에 맞는
                    PromptExpression을 입력해요.
                  </p>
                  <textarea
                    aria-label="시작 입력식 JSON"
                    rows={6}
                    spellCheck={false}
                    value={
                      draft?.id === active.id
                        ? draft.text
                        : JSON.stringify(active.initialAction.input, null, 2)
                    }
                    onChange={(event) => setDraft({ id: active.id, text: event.target.value })}
                  />
                  {draft && (
                    <div className="form-actions">
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            const next = {
                              ...active,
                              initialAction: {
                                ...active.initialAction!,
                                input: JSON.parse(draft.text) as PromptExpression,
                              },
                            };
                            validatePackageStarts([next], value);
                            update(next);
                            setDraft(null);
                            setError('');
                          } catch (caught) {
                            setError((caught as Error).message);
                          }
                        }}
                      >
                        시작 입력식 적용
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setDraft(null);
                          setError('');
                        }}
                      >
                        입력식 초안 취소
                      </button>
                    </div>
                  )}
                </details>
              )}
            </div>
          )}
          <button
            type="button"
            className="ghost"
            disabled={!!draft}
            onClick={() => {
              onChange({ ...value, starts: starts.filter((item) => item.id !== active.id) });
              setSelected('');
            }}
          >
            이 시작 삭제
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
