import type { ComponentProps } from 'react';
import './boolean-controls.css';

type Props = Omit<ComponentProps<'input'>, 'type' | 'role'>;

/** Independent on/off value; the surrounding label supplies the touch target. */
export function Switch({ className = '', ...props }: Props) {
  return <input {...props} type="checkbox" role="switch" className={`ui-switch ${className}`} />;
}

/** Multiple items may be selected; preserve native checkbox keyboard behavior. */
export function SelectionCheckbox({ className = '', ...props }: Props) {
  return <input {...props} type="checkbox" className={`ui-selection-checkbox ${className}`} />;
}
