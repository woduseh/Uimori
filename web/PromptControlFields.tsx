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
  compact = false,
}: {
  control: PromptControl;
  value: PromptValue;
  onChange: (value: PromptValue) => void;
  label: string;
  compact?: boolean;
}) {
  const descriptionId = useId();
  const describedBy = control.description ? descriptionId : undefined;
  const nativeToggle = control.input === 'switch';
  const isToggle = nativeToggle || control.type === 'boolean';
  return (
    <div className={`prompt-option-field${compact ? ' is-compact' : ''}`}>
      {isToggle ? (
        <ToggleRow
          label={label}
          description={control.description}
          checked={nativeToggle ? value === '1' : value === true}
          onChange={(checked) => onChange(nativeToggle ? (checked ? '1' : '0') : checked)}
        />
      ) : (
        <label>
          {compact ? (
            <span>
              {label}
              {control.description && <small id={descriptionId}>{control.description}</small>}
            </span>
          ) : (
            label
          )}
          {control.type === 'select' ? (
            <select
              aria-label={label}
              aria-describedby={describedBy}
              value={JSON.stringify(value)}
              onChange={(event) => onChange(JSON.parse(event.target.value) as PromptValue)}
            >
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
      {!compact && !isToggle && control.description && (
        <small id={descriptionId}>{control.description}</small>
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
  compact = false,
}: {
  program: RisuPrompt;
  values: Record<string, PromptValue>;
  visibilityValues?: Record<string, PromptValue>;
  controlIds?: string[];
  definitions?: PromptControl[];
  onChange: (id: string, value: PromptValue) => void;
  compact?: boolean;
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
  if (compact) {
    const rows: NativeRisuToggleItem[] = [];
    for (const item of items) {
      const previous = rows.at(-1);
      if (
        item.type === 'caption' &&
        previous?.type === 'control' &&
        item.group === previous.control.group
      ) {
        previous.control = {
          ...previous.control,
          description: [previous.control.description, item.label].filter(Boolean).join('\n'),
        };
      } else rows.push(item.type === 'control' ? { ...item } : item);
    }
    return (
      <div className="prompt-option-inline">
        {rows.map((item, index) =>
          item.type === 'control' ? (
            <ValueInput
              key={`control:${item.control.id}`}
              control={item.control}
              label={item.control.label}
              value={
                Object.hasOwn(values, item.control.id)
                  ? (values[item.control.id] ?? item.control.default)
                  : item.control.default
              }
              onChange={(value) => onChange(item.control.id, value)}
              compact
            />
          ) : item.type === 'caption' ? (
            <p className="prompt-option-caption" key={index}>
              {item.label}
            </p>
          ) : (
            <div className="prompt-option-divider" key={index}>
              {item.label && <span>{item.label}</span>}
              <hr />
            </div>
          )
        )}
      </div>
    );
  }
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
                  value={
                    Object.hasOwn(values, control.id)
                      ? (values[control.id] ?? control.default)
                      : control.default
                  }
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
