import { useEffect, useRef, useState } from 'react';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import type { PromptControl, PromptValue } from '../core/prompt-program.js';
import { PackageControlValues } from './PackageControlValues.js';

type ScalarDraft = { type: 'string' | 'number' | 'boolean' | 'null'; text: string };
export type PackageControlDraft = {
  control: PromptControl;
  defaultValue: ScalarDraft;
  min: string;
  max: string;
  condition: string;
  options: { label: string; value: ScalarDraft }[];
};
const scalar = (value: PromptValue): ScalarDraft => ({
  type: value === null ? 'null' : (typeof value as ScalarDraft['type']),
  text: value === null ? '' : String(value),
});
function parseScalar(value: ScalarDraft): PromptValue {
  if (value.type === 'null') return null;
  if (value.type === 'boolean') return value.text === 'true';
  if (value.type === 'string') return value.text;
  if (!value.text.trim() || !Number.isFinite(Number(value.text)))
    throw new Error('숫자 값을 입력해 주세요.');
  return Number(value.text);
}
export const packageControlDrafts = (controls: PromptControl[]): PackageControlDraft[] =>
  controls.map((control) => ({
    control: structuredClone(control),
    defaultValue: scalar(control.default),
    min: control.min === undefined ? '' : String(control.min),
    max: control.max === undefined ? '' : String(control.max),
    condition:
      control.visibleWhen === undefined ? '' : JSON.stringify(control.visibleWhen, null, 2),
    options: (control.options ?? []).map((option) => ({
      label: option.label,
      value: scalar(option.value),
    })),
  }));
export function applyPackageControlDrafts(
  value: ContentPackage,
  drafts: PackageControlDraft[]
): PromptControl[] {
  const controls = drafts.map((draft) => {
    const { options, min, max, visibleWhen, ...control } = draft.control;
    return {
      ...control,
      default: parseScalar(draft.defaultValue),
      ...(control.type === 'select'
        ? {
            options: draft.options.map((option) => ({
              label: option.label,
              value: parseScalar(option.value),
            })),
          }
        : {}),
      ...(control.type === 'number' && draft.min.trim()
        ? { min: parseScalar({ type: 'number', text: draft.min }) as number }
        : {}),
      ...(control.type === 'number' && draft.max.trim()
        ? { max: parseScalar({ type: 'number', text: draft.max }) as number }
        : {}),
      ...(draft.condition.trim() ? { visibleWhen: JSON.parse(draft.condition) } : {}),
    };
  });
  return validateContentPackage({ ...value, controls }).controls;
}
function ScalarEditor({
  value,
  onChange,
  label,
  fixedType,
}: {
  value: ScalarDraft;
  onChange: (value: ScalarDraft) => void;
  label: string;
  fixedType?: ScalarDraft['type'];
}) {
  const type = value.type;
  const kinds: ScalarDraft['type'][] = fixedType
    ? [fixedType, 'null']
    : ['string', 'number', 'boolean', 'null'];
  return (
    <div className="package-scalar-editor">
      <label>
        {label} 형식
        <select
          aria-label={`${label} 형식`}
          value={type}
          onChange={(event) => {
            const next = event.target.value as ScalarDraft['type'];
            onChange({
              type: next,
              text: next === 'boolean' ? 'false' : next === 'number' ? '0' : '',
            });
          }}
        >
          {kinds.map((kind) => (
            <option value={kind} key={kind}>
              {{ string: '문자', number: '숫자', boolean: '참/거짓', null: '미설정' }[kind]}
            </option>
          ))}
        </select>
      </label>
      {type === 'boolean' ? (
        <label className="check">
          <input
            aria-label={label}
            type="checkbox"
            checked={value.text === 'true'}
            onChange={(event) => onChange({ ...value, text: String(event.target.checked) })}
          />
          {label}
        </label>
      ) : (
        type !== 'null' && (
          <label>
            {label}
            <input
              aria-label={label}
              type={type === 'number' ? 'number' : 'text'}
              value={value.text}
              onChange={(event) => onChange({ ...value, text: event.target.value })}
            />
          </label>
        )
      )}
    </div>
  );
}

export function PackageControlsEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: ContentPackage;
  onChange: (controls: PromptControl[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const baseline = JSON.stringify(packageControlDrafts(value.controls));
  const [drafts, setDrafts] = useState(() => packageControlDrafts(value.controls)),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [previewValues, setPreviewValues] = useState<Record<string, PromptValue>>({});
  const previous = useRef(baseline);
  useEffect(() => {
    if (baseline !== previous.current) {
      const prior = previous.current;
      setDrafts((current) => (JSON.stringify(current) === prior ? JSON.parse(baseline) : current));
      previous.current = baseline;
    }
  }, [baseline]);
  const dirty = JSON.stringify(drafts) !== baseline;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  function change(next: PackageControlDraft[]) {
    setDrafts(next);
    setError('');
    setNotice('');
    setPreviewValues({});
  }
  function edit(index: number, part: Partial<PackageControlDraft>) {
    change(drafts.map((draft, i) => (i === index ? { ...draft, ...part } : draft)));
  }
  function editControl(index: number, part: Partial<PromptControl>) {
    edit(index, { control: { ...drafts[index].control, ...part } });
  }
  function changeType(index: number, type: PromptControl['type']) {
    const draft = drafts[index],
      defaultValue = scalar(type === 'boolean' ? false : type === 'number' ? 0 : '');
    edit(index, {
      control: { ...draft.control, type },
      defaultValue,
      min: '',
      max: '',
      options: type === 'select' ? [{ label: '선택 1', value: scalar('') }] : [],
    });
  }
  function apply() {
    try {
      const controls = applyPackageControlDrafts(value, drafts);
      onChange(controls);
      setDrafts(packageControlDrafts(controls));
      setError('');
      setNotice('옵션을 적용했어요. 자료 저장으로 새 버전을 남겨 주세요.');
    } catch (caught) {
      setError(
        `옵션을 확인해 주세요. 초안과 마지막 적용값은 유지돼요. (${(caught as Error).message})`
      );
      setNotice('');
    }
  }
  let preview: PromptControl[] | undefined;
  try {
    preview = applyPackageControlDrafts(value, drafts);
  } catch {
    /* Incomplete authoring drafts remain editable. */
  }
  return (
    <div className="package-stack package-authoring-editor" aria-label="패키지 옵션 편집">
      <p className="muted">
        옵션을 기능별로 묶고 채팅에서 보여 줄 조건을 정해요. 숨겨진 옵션도 선택값과 실행 효과를
        유지해요. 실행 여부는 지침이나 행동의 조건으로 정해 주세요.
      </p>
      {drafts.map((draft, index) => {
        const control = draft.control;
        return (
          <fieldset className="package-entry" key={index}>
            <legend>옵션 {index + 1}</legend>
            <div className="package-authoring-row">
              <label>
                옵션 이름
                <input
                  aria-label={`옵션 ${index + 1} 이름`}
                  maxLength={200}
                  value={control.label}
                  onChange={(event) => editControl(index, { label: event.target.value })}
                />
              </label>
              <label>
                옵션 종류
                <select
                  aria-label={`옵션 ${index + 1} 종류`}
                  value={control.type}
                  onChange={(event) =>
                    changeType(index, event.target.value as PromptControl['type'])
                  }
                >
                  <option value="boolean">토글</option>
                  <option value="select">선택형</option>
                  <option value="number">숫자</option>
                  <option value="text">텍스트</option>
                </select>
              </label>
            </div>
            <label>
              설명
              <textarea
                rows={2}
                maxLength={4000}
                value={control.description ?? ''}
                onChange={(event) => editControl(index, { description: event.target.value })}
              />
            </label>
            <label>
              기능 그룹
              <input
                aria-label={`옵션 ${index + 1} 기능 그룹`}
                maxLength={200}
                placeholder="예: 마법, 이미지, 시작 설정"
                value={control.group ?? ''}
                onChange={(event) => editControl(index, { group: event.target.value })}
              />
            </label>
            {control.type === 'select' ? (
              <>
                <div className="package-stack" aria-label={`옵션 ${index + 1} 선택지`}>
                  {draft.options.map((option, optionIndex) => (
                    <fieldset className="package-entry" key={optionIndex}>
                      <legend>선택지 {optionIndex + 1}</legend>
                      <label>
                        선택지 이름
                        <input
                          aria-label={`옵션 ${index + 1} 선택지 ${optionIndex + 1} 이름`}
                          value={option.label}
                          onChange={(event) =>
                            edit(index, {
                              options: draft.options.map((item, i) =>
                                i === optionIndex ? { ...item, label: event.target.value } : item
                              ),
                            })
                          }
                        />
                      </label>
                      <ScalarEditor
                        label={`옵션 ${index + 1} 선택지 ${optionIndex + 1} 값`}
                        value={option.value}
                        onChange={(value) =>
                          edit(index, {
                            options: draft.options.map((item, i) =>
                              i === optionIndex ? { ...item, value } : item
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          edit(index, {
                            options: draft.options.filter((_, i) => i !== optionIndex),
                          })
                        }
                      >
                        선택지 삭제
                      </button>
                    </fieldset>
                  ))}
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={draft.options.length >= 100}
                  onClick={() =>
                    edit(index, {
                      options: [
                        ...draft.options,
                        {
                          label: `선택 ${draft.options.length + 1}`,
                          value: scalar(`choice_${draft.options.length + 1}`),
                        },
                      ],
                    })
                  }
                >
                  선택지 추가
                </button>
                <label>
                  기본 선택
                  <select
                    aria-label={`옵션 ${index + 1} 기본 선택`}
                    value={
                      draft.defaultValue.type === 'null'
                        ? 'unset'
                        : String(
                            draft.options.findIndex(
                              (option) =>
                                JSON.stringify(option.value) === JSON.stringify(draft.defaultValue)
                            )
                          )
                    }
                    onChange={(event) =>
                      edit(index, {
                        defaultValue:
                          event.target.value === 'unset'
                            ? scalar(null)
                            : structuredClone(draft.options[Number(event.target.value)].value),
                      })
                    }
                  >
                    <option value="unset">미설정</option>
                    <option value="-1" disabled>
                      기본 선택을 골라 주세요
                    </option>
                    {draft.options.map((option, i) => (
                      <option value={i} key={i}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <ScalarEditor
                label={`옵션 ${index + 1} 기본값`}
                fixedType={control.type === 'text' ? 'string' : control.type}
                value={draft.defaultValue}
                onChange={(defaultValue) => edit(index, { defaultValue })}
              />
            )}
            {control.type === 'number' && (
              <div className="package-authoring-row">
                <label>
                  최솟값
                  <input
                    aria-label={`옵션 ${index + 1} 최솟값`}
                    type="number"
                    value={draft.min}
                    onChange={(event) => edit(index, { min: event.target.value })}
                  />
                </label>
                <label>
                  최댓값
                  <input
                    aria-label={`옵션 ${index + 1} 최댓값`}
                    type="number"
                    value={draft.max}
                    onChange={(event) => edit(index, { max: event.target.value })}
                  />
                </label>
              </div>
            )}
            <details>
              <summary>옵션 ID와 표시 조건</summary>
              <label>
                옵션 ID
                <input
                  aria-label={`옵션 ${index + 1} ID`}
                  maxLength={160}
                  value={control.id}
                  onChange={(event) => editControl(index, { id: event.target.value })}
                />
                <small>
                  지침과 다른 옵션의 조건에서 이 ID를 참조해요. 바꾸면 관련 참조도 수정해 주세요.
                </small>
              </label>
              <label>
                표시 조건 · PromptExpression JSON
                <textarea
                  aria-label={`옵션 ${index + 1} 표시 조건 JSON`}
                  rows={4}
                  spellCheck={false}
                  placeholder={'{"control":"enabled"}'}
                  value={draft.condition}
                  onChange={(event) => edit(index, { condition: event.target.value })}
                />
                <small>비우면 항상 보여요. 다른 옵션은 {'{"control":"옵션_ID"}'}로 읽어요.</small>
              </label>
            </details>
            <div className="package-role-actions">
              <button
                type="button"
                className="ghost"
                disabled={index === 0}
                onClick={() => {
                  const next = [...drafts];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  change(next);
                }}
              >
                옵션 위로
              </button>
              <button
                type="button"
                className="ghost"
                disabled={index === drafts.length - 1}
                onClick={() => {
                  const next = [...drafts];
                  [next[index + 1], next[index]] = [next[index], next[index + 1]];
                  change(next);
                }}
              >
                옵션 아래로
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => change(drafts.filter((_, i) => i !== index))}
              >
                옵션 삭제
              </button>
            </div>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary"
        disabled={drafts.length >= 150}
        onClick={() =>
          change([
            ...drafts,
            ...packageControlDrafts([
              {
                id: `option_${crypto.randomUUID().slice(0, 8)}`,
                label: '새 옵션',
                type: 'boolean',
                default: false,
              },
            ]),
          ])
        }
      >
        옵션 추가
      </button>
      {preview && (
        <details>
          <summary>채팅 옵션 미리보기</summary>
          <p className="muted">미리보기의 선택은 자료 기본값을 바꾸지 않아요.</p>
          <PackageControlValues
            controls={preview}
            values={previewValues}
            onChange={setPreviewValues}
          />
        </details>
      )}
      {dirty && <p role="status">옵션에 아직 적용하지 않은 초안이 있어요.</p>}
      <div className="package-role-actions">
        <button type="button" className="secondary" disabled={!dirty} onClick={apply}>
          옵션 검증 후 적용
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!dirty}
          onClick={() => {
            change(packageControlDrafts(value.controls));
            setNotice('마지막 적용값으로 되돌렸어요.');
          }}
        >
          옵션 초안 되돌리기
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
