import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { lineFeedRange, type CbsRange } from '../core/cbs-analysis.js';
import {
  editorFocusSelection,
  type EditorFocusDiagnostic,
  type EditorFocusSelection,
} from '../core/editor-focus.js';
import { PanelErrorBoundary } from './deferredPanel.js';
import { CODE_FIELD_REVEAL, codeFieldParts } from './code-field-reveal.js';
import { IconButton } from './IconButton.js';
import { HelperIcon } from './ui-icons.js';
import { t, useI18n } from './i18n.js';
import { useEditorHelperAsk, usePublishedEditorField } from './resource-editor.js';
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

export type CodeFieldSnapshot = {
  length: number;
  usesCbs: boolean;
  selection?: EditorFocusSelection;
  diagnostics: EditorFocusDiagnostic[];
  diagnosticsOmitted: number;
  diagnostic?: EditorFocusDiagnostic;
};
export type CodeFieldController = { snapshot: (diagnostic?: CbsRange) => CodeFieldSnapshot };
export type CodeFieldHelper = {
  controller: RefObject<CodeFieldController | null>;
  report: (snapshot: CodeFieldSnapshot) => void;
  pending: (flush: (() => void) | null) => void;
  askDiagnostic: (range: CbsRange) => void;
  action: ReactNode;
};
export const CODE_FIELD_ASK_DIAGNOSTIC = 'code-field-ask-diagnostic';

const CodeMirrorField = lazy(() => import('./CodeMirrorField.js'));

function plainSnapshot(element: HTMLTextAreaElement): CodeFieldSnapshot {
  const text = element.value;
  const selection = editorFocusSelection(text, element.selectionStart, element.selectionEnd);
  return {
    length: text.length,
    usesCbs: text.includes('{{'),
    ...(selection ? { selection } : {}),
    diagnostics: [],
    diagnosticsOmitted: 0,
  };
}

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
  helper,
  name,
  base: _base,
  language: _language,
  ...aria
}: CodeFieldProps & { handoff?: RefObject<CodeFieldHandoff>; helper?: CodeFieldHelper | null }) {
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
  useEffect(() => {
    if (!helper) return;
    helper.controller.current = {
      snapshot: () =>
        field.current
          ? plainSnapshot(field.current)
          : { length: 0, usesCbs: false, diagnostics: [], diagnosticsOmitted: 0 },
    };
  }, [helper]);
  const remember = (element: HTMLTextAreaElement, focused: boolean) => {
    if (focused) helper?.report(plainSnapshot(element));
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

function useCodeFieldHelper(props: CodeFieldProps): CodeFieldHelper | null {
  useI18n();
  const ask = useEditorHelperAsk();
  const field = usePublishedEditorField();
  const controller = useRef<CodeFieldController | null>(null);
  const [selected, setSelected] = useState(false);
  const parts = codeFieldParts(props.name);
  if (!ask || !parts) return null;
  const label = props['aria-label'] ?? parts.field;
  const language = props.language ?? 'cbs';
  const describe = ({ diagnostic: _diagnostic, ...snapshot }: CodeFieldSnapshot) => ({
    ...parts,
    label,
    language,
    length: snapshot.length,
    ...(snapshot.usesCbs ? { usesCbs: true as const } : {}),
    ...(snapshot.selection ? { selection: snapshot.selection } : {}),
    ...(snapshot.diagnostics.length ? { diagnostics: snapshot.diagnostics } : {}),
    ...(snapshot.diagnosticsOmitted ? { diagnosticsOmitted: snapshot.diagnosticsOmitted } : {}),
  });
  const askAbout = (range?: CbsRange) => {
    const snapshot = controller.current?.snapshot(range);
    if (!snapshot) return;
    ask({
      section: parts.section,
      field: describe(snapshot),
      ...(snapshot.diagnostic ? { diagnostic: snapshot.diagnostic } : {}),
    });
  };
  const name = t(selected ? 'editorHelper.askSelection' : 'editorHelper.ask', { name: label });
  return {
    controller,
    report: (snapshot) => {
      setSelected(!!snapshot.selection);
      field.publish(describe(snapshot));
    },
    pending: field.pending,
    askDiagnostic: askAbout,
    action: (
      <IconButton
        className="code-field-helper"
        data-selection={selected || undefined}
        label={name}
        icon={HelperIcon}
        size={16}
        onClick={() => askAbout()}
      />
    ),
  };
}

export function CodeField(props: CodeFieldProps) {
  const handoff = useRef<CodeFieldHandoff>({ focused: false, selectionStart: 0, selectionEnd: 0 });
  const names = useContext(CbsNamesContext);
  const bases = useContext(CodeFieldBaseContext);
  const helper = useCodeFieldHelper(props);
  const plain = <PlainCodeField {...props} handoff={handoff} helper={helper} />;
  return (
    <PanelErrorBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <CodeMirrorField
          {...props}
          base={props.base ?? bases?.get(props.name)}
          handoff={handoff}
          names={names}
          helper={helper}
        />
      </Suspense>
    </PanelErrorBoundary>
  );
}
