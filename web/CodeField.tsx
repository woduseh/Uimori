import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  type RefObject,
} from 'react';
import { lineFeedRange, type CbsRange } from '../core/cbs-analysis.js';
import { PanelErrorBoundary } from './deferredPanel.js';
import { CODE_FIELD_REVEAL } from './code-field-reveal.js';
import './code-field.css';

export type CodeLanguage = 'cbs' | 'html' | 'lua';
export type CbsNames = { chat: string[]; temp: string[]; global: string[]; toggles: string[] };
export const CbsNamesContext = createContext<CbsNames | null>(null);
export const CodeFieldBaseContext = createContext<ReadonlyMap<string, string> | null>(null);

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
  name: string;
  base?: string;
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
  name,
  base: _base,
  ...aria
}: CodeFieldProps & { handoff?: RefObject<CodeFieldHandoff> }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const source = useRef(value);
  source.current = value;
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const reveal = (event: Event) => {
      const { from, to } = lineFeedRange(source.current, (event as CustomEvent<CbsRange>).detail);
      element.focus();
      element.setSelectionRange(from, to);
    };
    element.addEventListener(CODE_FIELD_REVEAL, reveal);
    return () => element.removeEventListener(CODE_FIELD_REVEAL, reveal);
  }, []);
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
      ref={field}
      data-code-field={name}
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
  const names = useContext(CbsNamesContext);
  const bases = useContext(CodeFieldBaseContext);
  const plain = <PlainCodeField {...props} handoff={handoff} />;
  return (
    <PanelErrorBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <CodeMirrorField
          {...props}
          base={props.base ?? bases?.get(props.name)}
          handoff={handoff}
          names={names}
        />
      </Suspense>
    </PanelErrorBoundary>
  );
}
