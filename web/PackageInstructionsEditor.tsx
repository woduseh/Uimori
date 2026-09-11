import { Switch, SelectionCheckbox } from './BooleanControls.js';
import { useEffect, useRef, useState } from 'react';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';
import {
  PACKAGE_ROLES,
  PACKAGE_TARGETS,
  validateContentPackage,
  type ContentPackage,
  type PackageInstruction,
  type PackageRole,
} from '../core/content-package.js';
import { printPromptTemplate, parsePromptTemplate } from '../core/prompt-language.js';

type PackageInstructionDraft = {
  instruction: PackageInstruction;
  mode: 'text' | 'template';
  condition: string;
  template: string;
  templateFormat: 'json' | 'language';
  templateInitialized: boolean;
};
export const packageInstructionDrafts = (
  instructions: PackageInstruction[]
): PackageInstructionDraft[] =>
  instructions.map((instruction) => ({
    instruction: structuredClone(instruction),
    mode: instruction.template ? 'template' : 'text',
    condition: instruction.when === undefined ? '' : JSON.stringify(instruction.when, null, 2),
    template: JSON.stringify(
      instruction.template ?? [{ kind: 'text', text: instruction.text }],
      null,
      2
    ),
    templateFormat: 'json',
    templateInitialized: instruction.template !== undefined,
  }));
export function applyPackageInstructionDrafts(
  value: ContentPackage,
  drafts: PackageInstructionDraft[]
): PackageInstruction[] {
  const instructions = drafts.map((draft) => {
    const { template, when, position, attachmentRoles, ...instruction } = draft.instruction;
    return {
      ...instruction,
      ...(position?.trim() ? { position: position.trim() } : {}),
      ...(attachmentRoles ? { attachmentRoles } : {}),
      ...(draft.condition.trim() ? { when: JSON.parse(draft.condition) } : {}),
      ...(draft.mode === 'template'
        ? {
            template:
              draft.templateFormat === 'json'
                ? JSON.parse(draft.template)
                : parsePromptTemplate(
                    draft.template,
                    value.controls.map((control) => control.id)
                  ),
          }
        : {}),
    };
  });
  return validateContentPackage({ ...value, instructions }).instructions;
}
const targetLabels: Record<PackageInstruction['target'], string> = {
  main: '본문 창작',
  translation: '번역',
  state: '상태 계산',
  status: '표시 상태',
  image: '이미지 배치',
};
const roleLabels: Record<PackageRole, string> = { bot: '봇', persona: '페르소나', module: '모듈' };

export function PackageInstructionsEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: ContentPackage;
  onChange: (instructions: PackageInstruction[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const baseline = JSON.stringify(packageInstructionDrafts(value.instructions));
  const [drafts, setDrafts] = useBufferedEditorState('package.instructions', () =>
      packageInstructionDrafts(value.instructions)
    ),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const previous = useRef(baseline);
  useEffect(() => {
    if (baseline !== previous.current) {
      const prior = previous.current;
      setDrafts((current) => (JSON.stringify(current) === prior ? JSON.parse(baseline) : current));
      previous.current = baseline;
    }
  }, [baseline, setDrafts]);
  const dirty = JSON.stringify(drafts) !== baseline;
  const rowIds = useRef<string[]>([]);
  if (rowIds.current.length !== drafts.length)
    rowIds.current = drafts.map((_, index) => rowIds.current[index] ?? crypto.randomUUID());
  useUnappliedEditorField('package.instructions', dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  function change(next: PackageInstructionDraft[]) {
    setDrafts(next);
    setError('');
    setNotice('');
  }
  function edit(index: number, part: Partial<PackageInstructionDraft>) {
    change(drafts.map((draft, i) => (i === index ? { ...draft, ...part } : draft)));
  }
  function editInstruction(index: number, part: Partial<PackageInstruction>) {
    edit(index, { instruction: { ...drafts[index].instruction, ...part } });
  }
  function format(index: number, next: PackageInstructionDraft['templateFormat']) {
    const draft = drafts[index];
    if (draft.templateFormat === next) return;
    try {
      const template =
        draft.templateFormat === 'json'
          ? JSON.parse(draft.template)
          : parsePromptTemplate(
              draft.template,
              value.controls.map((control) => control.id)
            );
      edit(index, {
        templateFormat: next,
        template:
          next === 'json' ? JSON.stringify(template, null, 2) : printPromptTemplate(template),
      });
    } catch (caught) {
      setError(
        `템플릿 초안을 먼저 바로잡아 주세요. 입력은 유지돼요. (${(caught as Error).message})`
      );
    }
  }
  function apply() {
    try {
      const instructions = applyPackageInstructionDrafts(value, drafts);
      onChange(instructions);
      setDrafts(packageInstructionDrafts(instructions));
      setError('');
      setNotice('지침을 적용했어요. 자료 저장으로 변경 사항을 남겨 주세요.');
    } catch (caught) {
      setError(
        `지침을 확인해 주세요. 초안과 마지막 적용값은 유지돼요. (${(caught as Error).message})`
      );
      setNotice('');
    }
  }
  return (
    <div className="package-stack package-authoring-editor" aria-label="패키지 지침 편집">
      <p className="muted">
        모델이 수행할 작업, 자료를 장착한 역할, 적용 조건을 정해요. 본문과 조건 템플릿을 따로
        보관하며 실행에 사용할 방식을 직접 선택해요.
      </p>
      {drafts.map((draft, index) => {
        const instruction = draft.instruction;
        return (
          <fieldset className="package-entry" key={rowIds.current[index]}>
            <legend>지침 {index + 1}</legend>
            <label>
              담당 작업
              <select
                aria-label={`지침 ${index + 1} 담당 작업`}
                value={instruction.target}
                onChange={(event) =>
                  editInstruction(index, {
                    target: event.target.value as PackageInstruction['target'],
                    ...(event.target.value !== 'main' ? { position: undefined } : {}),
                  })
                }
              >
                {PACKAGE_TARGETS.map((target) => (
                  <option value={target} key={target}>
                    {targetLabels[target]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              실행 본문 방식
              <select
                aria-label={`지침 ${index + 1} 실행 본문 방식`}
                value={draft.mode}
                onChange={(event) =>
                  edit(index, {
                    mode: event.target.value as PackageInstructionDraft['mode'],
                    ...(event.target.value === 'template' && !draft.templateInitialized
                      ? {
                          template: JSON.stringify(
                            [{ kind: 'text', text: instruction.text }],
                            null,
                            2
                          ),
                          templateFormat: 'json',
                          templateInitialized: true,
                        }
                      : {}),
                  })
                }
              >
                <option value="text">일반 본문</option>
                <option value="template">조건 템플릿</option>
              </select>
            </label>
            <label>
              {draft.mode === 'template' ? '보관용 일반 본문' : '지침 본문'}
              <textarea
                aria-label={`지침 ${index + 1} 본문`}
                rows={6}
                maxLength={200_000}
                value={instruction.text}
                onChange={(event) => editInstruction(index, { text: event.target.value })}
              />
            </label>
            {draft.mode === 'template' ? (
              <div className="package-stack">
                <small>
                  이 일반 본문을 수정해도 실행 템플릿은 유지돼요. 일반 본문 방식으로 바꾸고 적용하면
                  템플릿을 제거해요.
                </small>
                <label>
                  템플릿 편집 형식
                  <select
                    aria-label={`지침 ${index + 1} 템플릿 편집 형식`}
                    value={draft.templateFormat}
                    onChange={(event) =>
                      format(index, event.target.value as PackageInstructionDraft['templateFormat'])
                    }
                  >
                    <option value="json">PromptTemplate JSON</option>
                    <option value="language">프롬프트 문법</option>
                  </select>
                </label>
                <label>
                  조건 템플릿
                  <textarea
                    aria-label={`지침 ${index + 1} 조건 템플릿`}
                    rows={10}
                    spellCheck={false}
                    value={draft.template}
                    onChange={(event) => edit(index, { template: event.target.value })}
                  />
                </label>
              </div>
            ) : (
              instruction.template && (
                <p className="muted">
                  검증 후 적용하면 기존 조건 템플릿을 제거하고 위 일반 본문을 실행해요. 적용 전에는
                  조건 템플릿 방식으로 되돌릴 수 있어요.
                </p>
              )
            )}
            <details>
              <summary>장착 역할과 적용 조건</summary>
              <fieldset className="package-instruction-roles">
                <legend>이 자료를 다음 역할로 사용할 때</legend>
                <label className="check">
                  <Switch
                    checked={instruction.attachmentRoles === undefined}
                    onChange={(event) =>
                      editInstruction(index, {
                        attachmentRoles: event.target.checked ? undefined : [...PACKAGE_ROLES],
                      })
                    }
                  />
                  모든 역할
                </label>
                {instruction.attachmentRoles !== undefined &&
                  PACKAGE_ROLES.map((role) => (
                    <label className="check" key={role}>
                      <SelectionCheckbox
                        checked={instruction.attachmentRoles?.includes(role) ?? false}
                        onChange={(event) =>
                          editInstruction(index, {
                            attachmentRoles: PACKAGE_ROLES.filter((item) =>
                              item === role
                                ? event.target.checked
                                : instruction.attachmentRoles?.includes(item)
                            ),
                          })
                        }
                      />
                      {roleLabels[role]}
                    </label>
                  ))}
              </fieldset>
              {instruction.target === 'main' && (
                <label>
                  본문 창작 프롬프트 위치
                  <input
                    aria-label={`지침 ${index + 1} 프롬프트 위치`}
                    value={instruction.position ?? ''}
                    onChange={(event) => editInstruction(index, { position: event.target.value })}
                  />
                  <small>
                    비우면 기본 위치에 포함해요. 위치를 지정하면 같은 ID의 프롬프트 슬롯에서
                    사용해요.
                  </small>
                </label>
              )}
              <label>
                적용 조건 · PromptExpression JSON
                <textarea
                  aria-label={`지침 ${index + 1} 적용 조건 JSON`}
                  rows={4}
                  spellCheck={false}
                  placeholder={'{"control":"enabled"}'}
                  value={draft.condition}
                  onChange={(event) => edit(index, { condition: event.target.value })}
                />
                <small>비우면 항상 적용해요. 패키지 옵션 ID를 참조할 수 있어요.</small>
              </label>
              <label>
                지침 ID
                <input
                  aria-label={`지침 ${index + 1} ID`}
                  maxLength={64}
                  value={instruction.id}
                  onChange={(event) => editInstruction(index, { id: event.target.value })}
                />
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
                  const ids = rowIds.current;
                  [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                  change(next);
                }}
              >
                지침 위로
              </button>
              <button
                type="button"
                className="ghost"
                disabled={index === drafts.length - 1}
                onClick={() => {
                  const next = [...drafts];
                  [next[index + 1], next[index]] = [next[index], next[index + 1]];
                  const ids = rowIds.current;
                  [ids[index + 1], ids[index]] = [ids[index], ids[index + 1]];
                  change(next);
                }}
              >
                지침 아래로
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  rowIds.current = rowIds.current.filter((_, i) => i !== index);
                  change(drafts.filter((_, i) => i !== index));
                }}
              >
                지침 삭제
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
            ...packageInstructionDrafts([{ id: crypto.randomUUID(), target: 'main', text: '' }]),
          ])
        }
      >
        지침 추가
      </button>
      {dirty && <p role="status">지침에 아직 적용하지 않은 초안이 있어요.</p>}
      <div className="package-role-actions">
        <button type="button" className="secondary" disabled={!dirty} onClick={apply}>
          지침 검증 후 적용
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!dirty}
          onClick={() => {
            rowIds.current = [];
            change(packageInstructionDrafts(value.instructions));
            setNotice('마지막 적용값으로 되돌렸어요.');
          }}
        >
          지침 초안 되돌리기
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
