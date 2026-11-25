import { expect, test } from 'vitest';
import {
  EDITOR_FOCUS_DIAGNOSTICS_MAX,
  EDITOR_FOCUS_LABEL_MAX_CHARS,
  EDITOR_FOCUS_SELECTION_MAX_CHARS,
  composeEditorFocus,
  editorFocusDiagnostics,
  editorFocusKey,
  editorFocusSelection,
  parseEditorFocus,
  type EditorFocus,
} from '../core/editor-focus.js';
import { analyzeCbs } from '../core/cbs-analysis.js';
import { editorHelperSuggestions } from '../web/editor-helper.js';

const field = (overrides: Partial<NonNullable<EditorFocus['field']>> = {}) => ({
  section: 'lore',
  item: 0,
  field: 'content',
  label: '로어 본문',
  language: 'cbs' as const,
  length: 40,
  ...overrides,
});

test('a selection is ordered, clamped to the text and bounded with its full range kept', () => {
  expect(editorFocusSelection('등대지기 이야기', 4, 1)).toEqual({ from: 1, to: 4, text: '대지기' });
  expect(editorFocusSelection('등대', 1, 1)).toBeUndefined();
  const long = 'a'.repeat(EDITOR_FOCUS_SELECTION_MAX_CHARS + 10);
  const bounded = editorFocusSelection(long, 0, long.length + 5)!;
  expect(bounded).toMatchObject({ from: 0, to: long.length, truncated: true });
  expect(bounded.text).toHaveLength(EDITOR_FOCUS_SELECTION_MAX_CHARS);
  expect(
    parseEditorFocus({
      section: 'basic',
      field: field({ length: long.length }),
      selection: bounded,
    })
  ).toMatchObject({ selection: { truncated: true } });
});

test('diagnostics carry one-based lines and columns, are bounded and count the rest', () => {
  const text = '첫 줄\n  {{getvar::mood\n';
  const { diagnostics, omitted } = editorFocusDiagnostics(text, analyzeCbs(text).diagnostics);
  expect(diagnostics).toEqual([
    expect.objectContaining({ code: 'cbs.unclosed-call', line: 2, column: 3, from: 6 }),
  ]);
  expect(omitted).toBe(0);
  const many = '{{/if}}'.repeat(EDITOR_FOCUS_DIAGNOSTICS_MAX + 3);
  const listed = editorFocusDiagnostics(many, analyzeCbs(many).diagnostics);
  expect(listed.diagnostics).toHaveLength(EDITOR_FOCUS_DIAGNOSTICS_MAX);
  expect(listed.omitted).toBe(3);
  expect(listed.diagnostics[1]).toMatchObject({ line: 1, column: 8 });
});

test('the request parser accepts the published shape and refuses anything outside it', () => {
  const focus: EditorFocus = {
    section: 'lore',
    item: { index: 0, label: '등대', id: 'lighthouse' },
    field: field({ usesCbs: true }),
    selection: { from: 0, to: 2, text: '등대' },
    diagnostics: [
      {
        code: 'cbs.unknown-function',
        severity: 'warning',
        from: 3,
        to: 8,
        line: 1,
        column: 4,
        name: 'foo',
      },
    ],
    diagnosticsOmitted: 2,
    unsavedSections: ['lore', 'basic'],
  };
  expect(parseEditorFocus(structuredClone(focus))).toEqual(focus);
  for (const invalid of [
    null,
    { section: '' },
    { section: 'lore', item: { index: -1, label: '' } },
    { section: 'lore', field: field({ language: 'python' as 'lua' }) },
    { section: 'lore', field: field(), selection: { from: 3, to: 3, text: '' } },
    { section: 'lore', field: field({ length: 1 }), selection: { from: 0, to: 2, text: '등대' } },
    { section: 'lore', diagnosticsOmitted: 1 },
    { section: 'lore', field: field(), diagnostics: [], diagnosticsOmitted: 0 },
    { section: 'lore', unsavedSections: Array(33).fill('lore') },
    { section: 'lore', field: { ...field(), raw: 'text' } },
  ])
    expect(() => parseEditorFocus(invalid), JSON.stringify(invalid)).toThrow(
      /^Invalid editor focus/u
    );
});

test('a composed focus fits the request bounds whatever the item and field are called', () => {
  const composed = composeEditorFocus(
    'lore',
    { index: 3, label: '긴 코멘트'.repeat(80), id: 'toggle_'.repeat(30) },
    field({ label: '블록 이름'.repeat(80) }),
    true
  );
  expect(composed.item).toEqual({
    index: 3,
    label: composed.item!.label,
  });
  expect(composed.item!.label).toHaveLength(EDITOR_FOCUS_LABEL_MAX_CHARS);
  expect(composed.field!.label).toHaveLength(EDITOR_FOCUS_LABEL_MAX_CHARS);
  expect(parseEditorFocus(structuredClone(composed))).toEqual(composed);
  expect(
    composeEditorFocus('lore', { index: 0, label: '등대', id: 'lighthouse' }, undefined, true).item
  ).toEqual({ index: 0, label: '등대', id: 'lighthouse' });
});

test('the focus key changes with the item, field, selection and asked diagnostic only', () => {
  const base: EditorFocus = { section: 'lore', item: { index: 0, label: '등대' }, field: field() };
  const key = editorFocusKey(base);
  expect(editorFocusKey({ ...base, item: { index: 0, label: '등대 개명' } })).toBe(key);
  expect(editorFocusKey({ ...base, unsavedSections: ['lore'] })).toBe(key);
  expect(editorFocusKey({ ...base, item: { index: 1, label: '등대' } })).not.toBe(key);
  expect(editorFocusKey({ ...base, selection: { from: 0, to: 1, text: '등' } })).not.toBe(key);
  expect(editorFocusKey(undefined)).toBe('');
});

test('suggested requests follow the item kind, its code and its state', () => {
  const lore: EditorFocus = { section: 'lore', item: { index: 0, label: '등대' } };
  expect(editorHelperSuggestions(lore)).toEqual([
    '이 로어 항목의 키워드와 내용이 맞는지 봐 줘',
    '이 로어 항목 다듬어 줘',
    '이 로어 항목 더 짧게 줄여 줘',
    '이 로어 항목 이어서 써 줘',
  ]);
  expect(
    editorHelperSuggestions({ section: 'regex', item: { index: 0, label: '상태창' } })
  ).toEqual(['이 정규식 설명해 줘', '이 정규식에 문제 없는지 점검해 줘']);
  expect(
    editorHelperSuggestions({
      section: 'triggers',
      item: { index: 0, label: '시작' },
      field: field({ section: 'triggers', field: 'effect.0', language: 'lua', label: 'Lua' }),
    })
  ).toEqual(['이 트리거 설명해 줘', '이 트리거에 문제 없는지 점검해 줘']);
  expect(
    editorHelperSuggestions({
      section: 'display',
      field: field({ section: 'display', item: null, language: 'html', field: 'backgroundHTML' }),
    })
  ).toEqual(['이 HTML 설명해 줘', '이 HTML에 문제 없는지 점검해 줘']);
  const diagnostic = {
    code: 'cbs.unclosed-call' as const,
    severity: 'error' as const,
    from: 0,
    to: 2,
    line: 1,
    column: 1,
  };
  const description: EditorFocus = {
    section: 'basic',
    field: field({
      section: 'basic',
      item: null,
      field: 'description',
      label: '카드 설명',
      usesCbs: true,
    }),
    diagnostics: [diagnostic],
  };
  expect(editorHelperSuggestions({ ...description, diagnostic })).toEqual([
    '이 오류 고쳐 줘',
    '카드 설명 다듬어 줘',
    '카드 설명 더 짧게 줄여 줘',
    '카드 설명 이어서 써 줘',
  ]);
  expect(editorHelperSuggestions(description)[0]).toBe('카드 설명의 오류 고쳐 줘');
  expect(editorHelperSuggestions({ ...description, diagnostics: undefined })).toEqual([
    '카드 설명에 문제 없는지 점검해 줘',
    '카드 설명 다듬어 줘',
    '카드 설명 더 짧게 줄여 줘',
    '카드 설명 이어서 써 줘',
  ]);
  expect(
    editorHelperSuggestions({
      ...lore,
      field: field(),
      selection: { from: 0, to: 2, text: '등대' },
    })
  ).toEqual(['선택한 부분 다듬어 줘', '선택한 부분 더 짧게 줄여 줘']);
  expect(
    editorHelperSuggestions({ section: 'greetings', item: { index: 0, label: '기본 첫 메시지' } })
  ).toEqual(['첫 메시지 다듬어 줘', '첫 메시지 더 짧게 줄여 줘', '첫 메시지 이어서 써 줘']);
});
