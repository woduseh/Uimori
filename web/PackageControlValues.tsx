import { Switch } from './BooleanControls.js';
import {
  visiblePromptControls,
  type PromptControl,
  type PromptValue,
} from '../core/prompt-program.js';

/** The option index keeps distinct values such as 1 and "1" separate. */
export function PackageControlInput({
  control,
  value,
  onChange,
  label = control.label,
  disabled = false,
}: {
  control: PromptControl;
  value: PromptValue;
  onChange: (value: PromptValue) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        control.type === 'boolean' ? 'check package-control-value' : 'package-control-value'
      }
    >
      {control.type === 'boolean' ? (
        <>
          <Switch
            aria-label={label}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{control.label}</span>
        </>
      ) : (
        <>
          <span>{control.label}</span>
          {control.type === 'select' ? (
            <select
              aria-label={label}
              disabled={disabled}
              value={
                value === null
                  ? 'unset'
                  : String(control.options?.findIndex((option) => option.value === value) ?? -1)
              }
              onChange={(event) =>
                onChange(
                  event.target.value === 'unset'
                    ? null
                    : (control.options?.[Number(event.target.value)]?.value ?? null)
                )
              }
            >
              <option value="unset">미설정</option>
              {control.options?.map((option, index) => (
                <option key={index} value={index}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={label}
              disabled={disabled}
              type={control.type === 'number' ? 'number' : 'text'}
              min={control.min}
              max={control.max}
              step={control.type === 'number' ? 'any' : undefined}
              value={value === null ? '' : String(value)}
              onChange={(event) => {
                const text = event.target.value;
                if (control.type !== 'number') onChange(text);
                else if (text === '') onChange(null);
                else if (Number.isFinite(Number(text))) onChange(Number(text));
              }}
            />
          )}
        </>
      )}
      {value === null && control.type === 'boolean' && <small>미설정</small>}
      {control.description && <small>{control.description}</small>}
    </label>
  );
}

export function PackageControlValues({
  controls,
  values = {},
  onChange,
  labelPrefix = '',
  disabled = false,
}: {
  controls: PromptControl[];
  values?: Record<string, PromptValue>;
  onChange: (values: Record<string, PromptValue>) => void;
  labelPrefix?: string;
  disabled?: boolean;
}) {
  let visible: PromptControl[],
    error = '';
  try {
    visible = visiblePromptControls(controls, values);
  } catch (caught) {
    visible = controls;
    error = `옵션 표시 조건을 확인해 주세요. 현재 선택값은 유지돼요. (${(caught as Error).message})`;
  }
  const groups = new Map<string, PromptControl[]>();
  for (const control of visible) {
    const group = control.group?.trim() ?? '';
    groups.set(group, [...(groups.get(group) ?? []), control]);
  }
  return (
    <div className="package-control-values">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {[...groups].map(([group, items]) => (
        <fieldset className="package-control-group" key={group}>
          <legend>{group || '일반 옵션'}</legend>
          {items.map((control) => (
            <PackageControlInput
              key={control.id}
              control={control}
              disabled={disabled}
              label={[labelPrefix, control.label].filter(Boolean).join(' ')}
              value={Object.hasOwn(values, control.id) ? values[control.id] : control.default}
              onChange={(value) => onChange({ ...values, [control.id]: value })}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}
