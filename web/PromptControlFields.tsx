import { useId } from 'react';
import { ToggleRow } from './ToggleRow.js';
import {
  visiblePromptControls,
  type PromptControl,
  type PromptProgram,
  type PromptValue,
} from '../core/prompt-program.js';

export function ValueInput({
  control,
  value,
  onChange,
  label,
}: {
  control: PromptControl;
  value: PromptValue;
  onChange: (value: PromptValue) => void;
  label: string;
}) {
  const descriptionId = useId();
  const describedBy = control.description ? descriptionId : undefined;
  return (
    <div className="prompt-option-field">
      {control.type === 'boolean' ? (
        <ToggleRow
          label={label}
          description={control.description}
          checked={value === true}
          onChange={onChange}
        />
      ) : (
        <label>
          {label}
          {control.type === 'select' ? (
            <select
              aria-label={label}
              aria-describedby={describedBy}
              value={JSON.stringify(value)}
              onChange={(event) => onChange(JSON.parse(event.target.value) as PromptValue)}
            >
              <option value="null">미설정</option>
              {control.options
                ?.filter((option) => option.value !== null)
                .map((option, index) => (
                  <option key={index} value={JSON.stringify(option.value)}>
                    {option.label}
                  </option>
                ))}
            </select>
          ) : control.type === 'number' ? (
            <input
              aria-label={label}
              aria-describedby={describedBy}
              type="number"
              min={control.min}
              max={control.max}
              step="any"
              value={value === null ? '' : String(value)}
              onChange={(event) =>
                onChange(event.target.value === '' ? null : Number(event.target.value))
              }
            />
          ) : (
            <textarea
              aria-label={label}
              aria-describedby={describedBy}
              rows={2}
              value={value === null ? '' : String(value)}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </label>
      )}
      {control.type !== 'boolean' && control.description && (
        <small id={descriptionId}>{control.description}</small>
      )}
      {control.type !== 'select' && control.type !== 'boolean' && (
        <button
          type="button"
          className="ghost prompt-option-unset"
          disabled={value === null}
          onClick={() => onChange(null)}
        >
          {value === null ? '미설정' : '미설정으로'}
        </button>
      )}
    </div>
  );
}

/** Uses the runtime's bounded evaluator; hiding an input never clears its value. */
export function PromptControlFields({
  program,
  values,
  visibilityValues = values,
  onChange,
}: {
  program: PromptProgram;
  values: Record<string, PromptValue>;
  visibilityValues?: Record<string, PromptValue>;
  onChange: (id: string, value: PromptValue) => void;
}) {
  let controls: PromptControl[];
  try {
    controls = visiblePromptControls(program.controls, visibilityValues);
  } catch {
    return (
      <p role="alert" className="error">
        옵션 표시 조건을 확인하지 못했어요. 프롬프트 정의를 확인해 주세요.
      </p>
    );
  }
  const groups = new Map<string, PromptControl[]>();
  for (const control of controls) {
    const group = control.group?.trim() || '기본 설정';
    groups.set(group, [...(groups.get(group) ?? []), control]);
  }
  return (
    <div className="prompt-option-groups">
      {[...groups].map(([group, items]) => (
        <details key={group} open className="prompt-option-group">
          <summary>{group}</summary>
          <div className="pc-control-values">
            {items.map((control) => (
              <ValueInput
                key={control.id}
                control={control}
                label={control.label}
                value={Object.hasOwn(values, control.id) ? values[control.id]! : control.default}
                onChange={(value) => onChange(control.id, value)}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
