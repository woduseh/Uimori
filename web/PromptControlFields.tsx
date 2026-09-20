import { useId } from 'react';
import { ToggleRow } from './ToggleRow.js';
import './prompt-control-fields.css';
import {
  promptControls,
  type PromptControl,
  type RisuPrompt,
  type PromptValue,
} from '../core/risu-prompt.js';

function ValueInput({
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
  const nativeToggle = control.input === 'switch';
  const isToggle = nativeToggle || control.type === 'boolean';
  return (
    <div className="prompt-option-field">
      {isToggle ? (
        <ToggleRow
          label={label}
          description={control.description}
          checked={nativeToggle ? value === '1' : value === true}
          onChange={(checked) => onChange(nativeToggle ? (checked ? '1' : '0') : checked)}
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
          ) : control.input === 'text' ? (
            <input
              aria-label={label}
              aria-describedby={describedBy}
              type="text"
              value={value === null ? '' : String(value)}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <textarea
              className="prompt-option-textarea"
              aria-label={label}
              aria-describedby={describedBy}
              rows={2}
              value={value === null ? '' : String(value)}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </label>
      )}
      {!isToggle && control.description && <small id={descriptionId}>{control.description}</small>}
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

/** Display native Risu toggle declarations; saved values do not change their structure. */
export function PromptControlFields({
  program,
  values,
  controlIds,
  definitions,
  onChange,
}: {
  program: RisuPrompt;
  values: Record<string, PromptValue>;
  visibilityValues?: Record<string, PromptValue>;
  controlIds?: string[];
  definitions?: PromptControl[];
  onChange: (id: string, value: PromptValue) => void;
}) {
  let controls: PromptControl[];
  try {
    controls = (definitions ?? promptControls(program)).filter(
      (control) => !controlIds || controlIds.includes(control.id)
    );
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
