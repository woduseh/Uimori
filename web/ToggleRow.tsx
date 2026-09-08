import { useId } from 'react';
import './toggle-row.css';

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="toggle-row full">
      <span className="toggle-row-text">
        <span>{label}</span>
        {description && <small id={id}>{description}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-describedby={description ? id : undefined}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
