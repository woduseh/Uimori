import { useId } from 'react';
import { ToggleRow } from './ToggleRow.js';
import './prompt-control-fields.css';
import { type PromptControl, type RisuPrompt, type PromptValue } from '../core/risu-prompt.js';
import { nativeRisuToggleItems, type NativeRisuToggleItem } from '../core/risu-native-preset.js';

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
  let items: NativeRisuToggleItem[];
  try {
    const declaration = program.nativeRisuPreset.preset.customPromptTemplateToggle;
    items = (
      definitions
        ? definitions.map((control): NativeRisuToggleItem => ({ type: 'control', control }))
        : nativeRisuToggleItems(typeof declaration === 'string' ? declaration : '')
    ).filter(
      (item) => !controlIds || (item.type === 'control' && controlIds.includes(item.control.id))
    );
  } catch {
    return (
      <p role="alert" className="error">
        옵션 표시 조건을 확인하지 못했어요. 프롬프트 정의를 확인해 주세요.
      </p>
    );
  }
  const groups: { name: string; items: NativeRisuToggleItem[] }[] = [];
  for (const item of items) {
    const name = (item.type === 'control' ? item.control.group : item.group)?.trim() || '기본 설정';
    const previous = groups.at(-1);
    if (previous?.name === name) previous.items.push(item);
    else groups.push({ name, items: [item] });
  }
  return (
    <div className="prompt-option-groups">
      {groups.map(({ name, items }, index) => (
        <details key={index} open className="prompt-option-group">
          <summary>{name}</summary>
          <div className="pc-control-values">
            {items.map((item, index) => {
              if (item.type === 'caption')
                return (
                  <p className="prompt-option-caption" key={`caption:${index}`}>
                    {item.label}
                  </p>
                );
              if (item.type === 'divider')
                return (
                  <div className="prompt-option-divider" key={`divider:${index}`}>
                    {item.label && <span>{item.label}</span>}
                    <hr />
                  </div>
                );
              const { control } = item;
              return (
                <ValueInput
                  key={`control:${control.id}`}
                  control={control}
                  label={control.label}
                  value={Object.hasOwn(values, control.id) ? values[control.id]! : control.default}
                  onChange={(value) => onChange(control.id, value)}
                />
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}
