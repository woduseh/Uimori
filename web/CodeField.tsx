import { lazy, Suspense, useRef, type RefObject } from 'react';
import { PanelErrorBoundary } from './deferredPanel.js';
import './code-field.css';

export type CodeLanguage = 'cbs' | 'html' | 'lua';

export type CodeFieldProps = {
  value: string;
  onChange: (value: string) => void;
  language?: CodeLanguage;
  className?: string;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  spellCheck?: boolean;
  font?: 'body' | 'mono';
  'aria-label'?: string;
  'aria-describedby'?: string;
};

export type CodeFieldHandoff = {
  focused: boolean;
  selectionStart: number;
  selectionEnd: number;
};

const CodeMirrorField = lazy(() => import('./CodeMirrorField.js'));

export function PlainCodeField({
  value,
  onChange,
  className,
  rows,
  disabled,
  readOnly,
  placeholder,
  spellCheck,
  font,
  handoff,
  ...aria
}: CodeFieldProps & { handoff?: RefObject<CodeFieldHandoff> }) {
  const remember = (element: HTMLTextAreaElement, focused: boolean) => {
    if (!handoff) return;
    handoff.current = {
      focused,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    };
  };
  return (
    <textarea
      {...aria}
      className={className}
      rows={rows}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      spellCheck={spellCheck}
      data-font={font}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => remember(event.currentTarget, true)}
      onSelect={(event) => remember(event.currentTarget, true)}
      onBlur={(event) => remember(event.currentTarget, false)}
    />
  );
}

export function CodeField(props: CodeFieldProps) {
  const handoff = useRef<CodeFieldHandoff>({ focused: false, selectionStart: 0, selectionEnd: 0 });
  const plain = <PlainCodeField {...props} handoff={handoff} />;
  return (
    <PanelErrorBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <CodeMirrorField {...props} handoff={handoff} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
