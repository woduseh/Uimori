import type { ComponentProps } from 'react';
import './boolean-controls.css';

type Props = Omit<ComponentProps<'input'>, 'type' | 'role'>;

export function Switch({ className = '', ...props }: Props) {
  return <input {...props} type="checkbox" role="switch" className={`ui-switch ${className}`} />;
}

export function SelectionCheckbox({ className = '', ...props }: Props) {
  return <input {...props} type="checkbox" className={`ui-selection-checkbox ${className}`} />;
}
