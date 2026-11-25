import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import {
  Compartment,
  EditorState,
  Facet,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import { history, historyKeymap, insertNewline, standardKeymap } from '@codemirror/commands';
import {
  autocompletion,
  completionStatus,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { forEachDiagnostic, linter, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  analyzeCbs,
  cbsMatchingRanges,
  cbsVariableFunctionScope,
  type CbsAnalysis,
  type CbsDiagnostic,
  type CbsFunctionCatalog,
  type CbsRange,
  type CbsTokenKind,
} from '../core/cbs-analysis.js';
import { CODE_FIELD_REVEAL } from './code-field-reveal.js';
import { api } from './api.js';
import { t } from './i18n.js';
import {
  PlainCodeField,
  type CbsNames,
  type CodeFieldHandoff,
  type CodeFieldProps,
  type CodeLanguage,
} from './CodeField.js';

let catalogRequest: Promise<CbsFunctionCatalog | null> | null = null;
let loadedCatalog: CbsFunctionCatalog | null = null;

function loadCatalog() {
  catalogRequest ??= api<CbsFunctionCatalog>('/risu/cbs-functions').then(
    (catalog) => (loadedCatalog = catalog),
    () => {
      catalogRequest = null;
      return null;
    }
  );
  return catalogRequest;
}

const hostLanguages: Record<Exclude<CodeLanguage, 'cbs'>, () => Promise<Extension>> = {
  html: () =>
    import('@codemirror/lang-html').then((module) => module.html({ autoCloseTags: false })),
  lua: () =>
    import('@codemirror/legacy-modes/mode/lua').then((module) => StreamLanguage.define(module.lua)),
};

const catalogFacet = Facet.define<CbsFunctionCatalog | null, CbsFunctionCatalog | null>({
  combine: (values) => values.at(-1) ?? null,
});

const analyze = (state: EditorState) =>
  analyzeCbs(state.doc.sliceString(0, state.doc.length, '\n'), {
    catalog: state.facet(catalogFacet) ?? undefined,
  });

const analysisField = StateField.define<CbsAnalysis>({
  create: analyze,
  update: (analysis, transaction) =>
    transaction.docChanged ||
    transaction.startState.facet(catalogFacet) !== transaction.state.facet(catalogFacet)
      ? analyze(transaction.state)
      : analysis,
});

const tokenClasses: Partial<Record<CbsTokenKind, string>> = {
  open: 'cm-cbs-brace',
  close: 'cm-cbs-brace',
  name: 'cm-cbs-name',
  keyword: 'cm-cbs-keyword',
  separator: 'cm-cbs-separator',
  comment: 'cm-cbs-comment',
};
const markCache = new Map<string, Decoration>();
const mark = (className: string) => {
  let decoration = markCache.get(className);
  if (!decoration) {
    decoration = Decoration.mark({ class: className });
    markCache.set(className, decoration);
  }
  return decoration;
};

function decorate(analysis: CbsAnalysis): DecorationSet {
  const depth = (call: number | null) => {
    let level = 0;
    for (let parent = call === null ? null : analysis.calls[call]!.parent; parent !== null; ) {
      level++;
      parent = analysis.calls[parent]!.parent;
    }
    return level % 3;
  };
  const ranges: Range<Decoration>[] = [];
  for (const token of analysis.tokens) {
    const className = tokenClasses[token.kind];
    if (!className || token.to <= token.from) continue;
    const braces = token.kind === 'open' || token.kind === 'close';
    ranges.push(
      mark(braces ? `${className} cm-cbs-depth-${depth(token.call)}` : className).range(
        token.from,
        token.to
      )
    );
  }
  return Decoration.set(ranges, true);
}

const highlightField = StateField.define<DecorationSet>({
  create: (state) => decorate(state.field(analysisField)),
  update: (decorations, transaction) => {
    const analysis = transaction.state.field(analysisField);
    return analysis === transaction.startState.field(analysisField, false)
      ? decorations
      : decorate(analysis);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const matchPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged)
        this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const selection = view.state.selection.main;
      if (!view.hasFocus || !selection.empty) return Decoration.none;
      const match = cbsMatchingRanges(view.state.field(analysisField), selection.head);
      if (!match) return Decoration.none;
      const decoration = mark(match.matched ? 'cm-cbs-match' : 'cm-cbs-unmatched');
      return Decoration.set(
        match.ranges.map((range) => decoration.range(range.from, range.to)),
        true
      );
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

function diagnosticMessage(diagnostic: CbsDiagnostic) {
  switch (diagnostic.code) {
    case 'cbs.unclosed-call':
      return t('native.cbsUnclosedCall', { open: '{{', close: '}}' });
    case 'cbs.unclosed-block': {
      const keyword = diagnostic.name ?? '#';
      return t('native.cbsUnclosedBlock', {
        opener: `{{${keyword}}}`,
        closer: `{{/${keyword.slice(1)}}}`,
      });
    }
    case 'cbs.stray-closer':
      return t('native.cbsStrayCloser', { closer: `{{${diagnostic.name ?? '/'}}}` });
    case 'cbs.else-outside-when':
      return t('native.cbsElseOutsideWhen', { else: '{{:else}}', when: '{{#when}}' });
    case 'cbs.unknown-function':
      return t('native.cbsUnknownFunction', { name: diagnostic.name ?? '' });
  }
}

const cbsLinter = linter(
  (view): Diagnostic[] =>
    view.state.field(analysisField).diagnostics.map((diagnostic) => ({
      from: diagnostic.from,
      to: diagnostic.to,
      severity: diagnostic.severity,
      message: diagnosticMessage(diagnostic),
    })),
  {
    delay: 400,
    needsRefresh: (update) =>
      update.startState.field(analysisField) !== update.state.field(analysisField),
  }
);

const cursorDiagnostic = StateField.define<readonly Tooltip[]>({
  create: () => [],
  update: (_tooltips, transaction) => {
    const { state } = transaction;
    const selection = state.selection.main;
    if (!selection.empty || completionStatus(state)) return [];
    let message: string | null = null;
    forEachDiagnostic(state, (diagnostic, from, to) => {
      if (message === null && from < to && from <= selection.head && selection.head <= to)
        message = diagnostic.message;
    });
    if (message === null) return [];
    const text: string = message;
    return [
      {
        pos: selection.head,
        above: false,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'cm-cbs-cursor-diagnostic';
          dom.textContent = text;
          return { dom };
        },
      },
    ];
  },
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
});

const completionCache = new WeakMap<CbsFunctionCatalog, Completion[]>();

function completionOptions(catalog: CbsFunctionCatalog) {
  let options = completionCache.get(catalog);
  if (!options) {
    options = catalog.functions
      .filter((entry) => !entry.internal && entry.name !== '//' && entry.name !== '?')
      .map((entry) => ({
        label: entry.name,
        detail: entry.aliases.length ? entry.aliases.join(', ') : undefined,
        info: entry.description.split('\n')[0],
        type: /^[#:]/.test(entry.name) ? 'keyword' : 'function',
        boost: entry.deprecated ? -10 : 0,
      }));
    completionCache.set(catalog, options);
  }
  return options;
}

const namesFacet = Facet.define<CbsNames | null, CbsNames | null>({
  combine: (values) => values.at(-1) ?? null,
});
const nameOptionCache = new WeakMap<string[], Completion[]>();
const nameOptions = (names: string[]) => {
  let options = nameOptionCache.get(names);
  if (!options) {
    options = names.map((label) => ({ label, type: 'variable' }));
    nameOptionCache.set(names, options);
  }
  return options;
};

function variableNameCompletions(context: CompletionContext): CompletionResult | null {
  const names = context.state.facet(namesFacet);
  if (!names) return null;
  const when = context.matchBefore(/\{\{#when\b[^{}]*?::(var|toggle)::[^:{}]*$/);
  const call = when ? null : context.matchBefore(/\{\{\s*[\w-]+::[^:{}]*$/);
  const match = when ?? call;
  if (!match) return null;
  const typed = /[^:]*$/.exec(match.text)![0];
  let options: string[] | null = null;
  if (when) options = /::toggle::[^:]*$/.test(match.text) ? names.toggles : names.chat;
  else {
    const scope = cbsVariableFunctionScope(/^\{\{\s*([\w-]+)/.exec(match.text)![1]!);
    if (scope) options = names[scope];
  }
  const remaining = nameOptions(options ?? []).filter((option) => option.label !== typed);
  return remaining.length ? { from: context.pos - typed.length, options: remaining } : null;
}

function cbsCompletions(context: CompletionContext): CompletionResult | null {
  const variable = variableNameCompletions(context);
  if (variable) return variable;
  const catalog = context.state.facet(catalogFacet);
  if (!catalog) return null;
  const before = context.matchBefore(/\{\{[#:]?[\w-]*$/);
  if (!before) return null;
  return {
    from: before.from + 2,
    options: completionOptions(catalog),
    validFor: /^[#:]?[\w-]*$/,
  };
}

const cbsExtensions: Extension = [
  analysisField,
  highlightField,
  matchPlugin,
  cbsLinter,
  cursorDiagnostic,
  autocompletion({ override: [cbsCompletions], icons: false }),
];

const hostHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: 'var(--info)' },
  { tag: [tags.string, tags.attributeValue], color: 'var(--success)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--warning)' },
  { tag: [tags.tagName, tags.className, tags.typeName], color: 'var(--accent-text)' },
  { tag: [tags.attributeName, tags.propertyName], color: 'var(--info)' },
  { tag: [tags.angleBracket, tags.bracket, tags.punctuation], color: 'var(--muted)' },
]);

const editorTheme = EditorView.theme({
  '&': { color: 'inherit', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--accent-text)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    border: 'var(--hairline) solid var(--line)',
    borderRadius: 'var(--radius-control)',
    boxShadow: 'var(--shadow-float)',
    fontSize: 'var(--font-body)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    maxHeight: '16em',
    maxWidth: 'min(480px, calc(100vw - 32px))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '6px 10px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text)',
  },
  '.cm-completionLabel': { color: 'var(--text)' },
  '.cm-completionMatchedText': {
    textDecoration: 'none',
    color: 'var(--accent-text)',
    fontWeight: '600',
  },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginInlineStart: '8px' },
  '.cm-tooltip.cm-completionInfo': {
    padding: '8px 10px',
    maxWidth: 'min(320px, calc(100vw - 32px))',
  },
  '.cm-diagnostic': { padding: '6px 10px', borderLeftWidth: '4px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--error)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warning)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-cbs-cursor-diagnostic': { padding: '6px 10px', maxWidth: 'min(320px, calc(100vw - 32px))' },
});

function lineSeparatorOf(value: string): '\n' | '\r\n' | null {
  if (!value.includes('\r')) return '\n';
  const count = (pattern: RegExp) => value.match(pattern)?.length ?? 0;
  const pairs = count(/\r\n/g);
  return pairs === count(/\r/g) && pairs === count(/\n/g) ? '\r\n' : null;
}

function useFieldsetDisabled(host: RefObject<HTMLElement | null>) {
  const [disabled, setDisabled] = useState(false);
  useLayoutEffect(() => {
    const fieldsets: HTMLFieldSetElement[] = [];
    for (
      let fieldset = host.current?.parentElement?.closest('fieldset');
      fieldset;
      fieldset = fieldset.parentElement?.closest('fieldset')
    )
      fieldsets.push(fieldset);
    if (fieldsets.length === 0) return;
    const update = () => setDisabled(fieldsets.some((fieldset) => fieldset.disabled));
    update();
    const observer = new MutationObserver(update);
    for (const fieldset of fieldsets)
      observer.observe(fieldset, { attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  }, [host]);
  return disabled;
}

type EditorProps = CodeFieldProps & {
  handoff: RefObject<CodeFieldHandoff>;
  names?: CbsNames | null;
};

type EditorSettings = {
  locked: boolean;
  readOnly: boolean;
  hint?: string;
  prose: boolean;
  label?: string;
  describedBy?: string;
};

function editorOptions(settings: EditorSettings): Extension {
  return [
    EditorView.editable.of(!settings.locked),
    EditorState.readOnly.of(settings.locked || settings.readOnly),
    EditorView.contentAttributes.of({
      ...(settings.label ? { 'aria-label': settings.label } : {}),
      ...(settings.describedBy ? { 'aria-describedby': settings.describedBy } : {}),
      ...(settings.locked ? { 'aria-disabled': 'true' } : {}),
      ...(settings.prose
        ? {
            spellcheck: 'true',
            autocorrect: 'on',
            autocapitalize: 'sentences',
            writingsuggestions: 'true',
          }
        : {}),
    }),
    settings.hint ? placeholder(settings.hint) : [],
  ];
}

export default function CodeMirrorField({ names, ...props }: EditorProps) {
  if (lineSeparatorOf(props.value) === null) return <PlainCodeField {...props} />;
  return <Editor {...props} names={names} />;
}

function Editor({
  value,
  onChange,
  language = 'cbs',
  className,
  rows,
  disabled,
  readOnly,
  placeholder: hint,
  spellCheck,
  font,
  handoff,
  names = null,
  name,
  'aria-label': label,
  'aria-describedby': describedBy,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initialValue = useRef(value).current;
  const unacknowledged = useRef<string[]>([]);
  const changeHandler = useRef(onChange);
  changeHandler.current = onChange;
  const compartments = useRef({
    options: new Compartment(),
    host: new Compartment(),
    catalog: new Compartment(),
    names: new Compartment(),
  }).current;
  const namesRef = useRef(names);
  namesRef.current = names;
  const hostExtension = useRef<Extension>([]);
  const inheritedDisabled = useFieldsetDisabled(host);
  const locked = !!disabled || inheritedDisabled;
  const prose = spellCheck !== false && font !== 'mono';
  const settings = { locked, readOnly: !!readOnly, hint, prose, label, describedBy };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const stateFactory = useRef((doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineSeparatorOf(doc) === '\r\n' ? EditorState.lineSeparator.of('\r\n') : [],
        history(),
        keymap.of([
          ...(language === 'cbs' ? [{ key: 'Enter', run: insertNewline }] : []),
          ...standardKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        syntaxHighlighting(hostHighlight),
        compartments.host.of(hostExtension.current),
        language === 'lua' ? [] : cbsExtensions,
        compartments.catalog.of(catalogFacet.of(loadedCatalog)),
        compartments.names.of(namesFacet.of(namesRef.current)),
        compartments.options.of(editorOptions(settingsRef.current)),
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.sliceDoc();
          if (unacknowledged.current.push(next) > 32) unacknowledged.current.shift();
          changeHandler.current(next);
        }),
      ],
    })
  );
  const createState = stateFactory.current;
  const initialLanguage = useRef(language).current;

  useLayoutEffect(() => {
    const editor = new EditorView({ state: createState(initialValue), parent: host.current! });
    view.current = editor;
    const previous = handoff.current;
    if (previous.focused) {
      const length = editor.state.doc.length;
      editor.focus();
      editor.dispatch({
        selection: {
          anchor: Math.min(previous.selectionStart, length),
          head: Math.min(previous.selectionEnd, length),
        },
      });
    }
    let alive = true;
    void loadCatalog().then((catalog) => {
      if (alive && catalog)
        editor.dispatch({ effects: compartments.catalog.reconfigure(catalogFacet.of(catalog)) });
    });
    if (initialLanguage !== 'cbs')
      void hostLanguages[initialLanguage]().then((extension) => {
        hostExtension.current = extension;
        if (alive) editor.dispatch({ effects: compartments.host.reconfigure(extension) });
      });
    return () => {
      alive = false;
      editor.destroy();
      view.current = null;
    };
  }, [compartments, createState, handoff, initialLanguage, initialValue]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const pending = unacknowledged.current;
    const echo = pending.indexOf(value);
    if (echo >= 0) {
      pending.splice(0, echo + 1);
      return;
    }
    if (value === editor.state.sliceDoc()) return;
    pending.length = 0;
    editor.setState(createState(value));
  }, [value, createState]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.names.reconfigure(namesFacet.of(names)) });
  }, [compartments, names]);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.options.reconfigure(
        editorOptions({ locked, readOnly: !!readOnly, hint, prose, label, describedBy })
      ),
    });
  }, [compartments, locked, readOnly, hint, prose, label, describedBy]);

  useEffect(() => {
    const field = host.current;
    if (!field) return;
    const reveal = (event: Event) => {
      const editor = view.current;
      if (!editor) return;
      const length = editor.state.doc.length;
      const { from, to } = (event as CustomEvent<CbsRange>).detail;
      editor.focus();
      editor.dispatch({
        selection: { anchor: Math.min(from, length), head: Math.min(to, length) },
        effects: EditorView.scrollIntoView(Math.min(from, length), { y: 'center' }),
      });
    };
    field.addEventListener(CODE_FIELD_REVEAL, reveal);
    return () => field.removeEventListener(CODE_FIELD_REVEAL, reveal);
  }, []);

  useEffect(() => {
    const field = host.current;
    const owner = field?.closest('label');
    if (!field || !owner) return;
    const focus = (event: MouseEvent) => {
      if (!field.contains(event.target as Node)) view.current?.focus();
    };
    owner.addEventListener('click', focus);
    return () => owner.removeEventListener('click', focus);
  }, []);

  return (
    <div
      ref={host}
      className={className ? `code-field ${className}` : 'code-field'}
      data-code-field={name}
      data-font={font}
      data-language={language}
      data-disabled={locked || undefined}
      data-readonly={readOnly || undefined}
      data-rows={rows === undefined ? undefined : ''}
      style={rows === undefined ? undefined : ({ '--code-field-rows': rows } as CSSProperties)}
    />
  );
}
