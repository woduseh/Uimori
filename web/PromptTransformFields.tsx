import type { PromptTextTransform } from '../core/prompt-program.js';
import { IconButton } from './IconButton.js';
import { AddIcon, DeleteIcon, DownIcon, UpIcon } from './ui-icons.js';

export function PromptTransformFields({
  value = [],
  onChange,
  onAdvanced,
}: {
  value?: PromptTextTransform[];
  onChange: (value: PromptTextTransform[]) => void;
  onAdvanced: () => void;
}) {
  const update = (index: number, changes: Partial<PromptTextTransform>) =>
    onChange(value.map((rule, i) => (i === index ? { ...rule, ...changes } : rule)));
  const move = (index: number, offset: number) => {
    const next = [...value];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="prompt-transform-fields">
      <h3>텍스트 변환</h3>
      <p className="muted">
        위에서 아래 순서로 적용해요. 전송 전 변환은 모델이 받는 대화를 바꾸고, 표시 변환은 읽는
        화면만 바꿔요. 저장된 요청과 원문은 유지해요.
      </p>
      {value.map((rule, index) => (
        <fieldset key={rule.id} aria-label={`텍스트 변환 ${index + 1}`}>
          <legend>
            {index + 1}. {rule.title || '이름 없는 규칙'}
          </legend>
          <div className="pc-actions">
            <label>
              <input
                type="checkbox"
                checked={rule.enabled !== false}
                onChange={(event) => update(index, { enabled: event.target.checked })}
              />
              사용
            </label>
            <IconButton
              icon={UpIcon}
              label="변환 위로 이동"
              className="secondary"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            />
            <IconButton
              icon={DownIcon}
              label="변환 아래로 이동"
              className="secondary"
              disabled={index === value.length - 1}
              onClick={() => move(index, 1)}
            />
            <IconButton
              icon={DeleteIcon}
              label="변환 삭제"
              className="secondary"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            />
          </div>
          <label>
            이름
            <input
              aria-label="변환 이름"
              value={rule.title}
              onChange={(event) => update(index, { title: event.target.value })}
            />
          </label>
          <div className="prompt-editor-row">
            <label>
              적용 단계
              <select
                aria-label="변환 적용 단계"
                value={rule.stage}
                onChange={(event) =>
                  update(index, { stage: event.target.value as PromptTextTransform['stage'] })
                }
              >
                <option value="input">전송 전</option>
                <option value="display">표시</option>
              </select>
            </label>
            <label>
              대상
              <select
                aria-label="변환 대상"
                value={rule.role ?? 'all'}
                onChange={(event) =>
                  update(index, { role: event.target.value as PromptTextTransform['role'] })
                }
              >
                <option value="all">요청과 응답</option>
                <option value="user">사용자 요청</option>
                <option value="assistant">모델 응답</option>
              </select>
            </label>
          </div>
          <label>
            정규식 패턴
            <input
              aria-label="변환 정규식 패턴"
              spellCheck={false}
              value={rule.pattern}
              onChange={(event) => update(index, { pattern: event.target.value })}
            />
          </label>
          <label>
            플래그
            <input
              aria-label="변환 플래그"
              spellCheck={false}
              value={rule.flags}
              onChange={(event) => update(index, { flags: event.target.value })}
            />
          </label>
          {rule.replacementTemplate && (
            <p className="muted">
              옵션·조건을 사용하는 치환 템플릿이 있어요. 아래 치환문을 직접 수정하면 템플릿을
              해제해요. 구조 편집은 전체 구성 JSON에서 할 수 있어요.
            </p>
          )}
          <label>
            치환문
            <textarea
              aria-label="변환 치환문"
              rows={3}
              spellCheck={false}
              value={rule.replacement}
              onChange={(event) =>
                update(index, { replacement: event.target.value, replacementTemplate: undefined })
              }
            />
          </label>
        </fieldset>
      ))}
      <div className="pc-actions">
        <button
          type="button"
          className="secondary"
          onClick={() =>
            onChange([
              ...value,
              {
                id: `transform-${crypto.randomUUID()}`,
                title: '새 변환',
                enabled: false,
                stage: 'display',
                role: 'all',
                pattern: '',
                flags: 'g',
                replacement: '',
              },
            ])
          }
        >
          <AddIcon size={18} aria-hidden="true" />
          변환 추가
        </button>
        <button type="button" className="secondary" onClick={onAdvanced}>
          전체 구성 JSON 편집
        </button>
      </div>
    </div>
  );
}
