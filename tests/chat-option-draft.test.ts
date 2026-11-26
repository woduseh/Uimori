import { expect, test } from 'vitest';
import type { ChatOptionState } from '../core/chat-options.js';
import type { PromptControl } from '../core/risu-prompt.js';
import {
  editOptionDraft,
  optionDraftValues,
  reviewOptionDraft,
  type OptionDraft,
} from '../web/chat-option-draft.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const base: ChatOptionState = {
  chatId: 'draft-chat',
  revision: 1,
  binding: { owner: 'preset:writing', definitionHash: 'same-controls' },
  workspaceRevision: 1,
  program: nativePrompt('', { customPromptTemplateToggle: 'tone=문체=text\nnote=메모=text' }),
  globalValues: { tone: '기본 문체', note: '기본 메모' },
  fixedValues: { tone: '채팅 문체' },
  pending: [],
  conflicts: [],
};

test('both scopes keep the same edits while preserving untouched fixed values', () => {
  expect(optionDraftValues(base, {})).toEqual({ fixed: { tone: '채팅 문체' }, oneoff: {} });
  const fixedEdit = editOptionDraft(base, {}, 'fixed', { tone: '채팅 문체', note: '새 메모' });
  expect(optionDraftValues(base, fixedEdit)).toEqual({
    fixed: { tone: '채팅 문체', note: '새 메모' },
    oneoff: { note: '새 메모' },
  });
  const oneoffEdit = editOptionDraft(base, fixedEdit, 'oneoff', { note: '다시 편집한 메모' });
  expect(optionDraftValues(base, oneoffEdit)).toEqual({
    fixed: { tone: '채팅 문체', note: '다시 편집한 메모' },
    oneoff: { note: '다시 편집한 메모' },
  });
  expect(base.fixedValues).toEqual({ tone: '채팅 문체' });
});

test('clearing a fixed override keeps its displayed prompt default in oneoff scope and its unset intent on return', () => {
  const draft = editOptionDraft(base, {}, 'fixed', {});
  expect(optionDraftValues(base, draft)).toEqual({ fixed: {}, oneoff: { tone: '기본 문체' } });
  const edited = editOptionDraft(base, draft, 'oneoff', { tone: '기본 문체', note: '이번 메모' });
  expect(optionDraftValues(base, edited)).toEqual({
    fixed: { note: '이번 메모' },
    oneoff: { tone: '기본 문체', note: '이번 메모' },
  });
});

test('clearing a oneoff edit restores saved fixed inheritance, and reverting a fixed edit is clean', () => {
  const draft = editOptionDraft(base, {}, 'oneoff', { tone: '한 번 문체' });
  expect(editOptionDraft(base, draft, 'oneoff', {})).toEqual({});
  expect(editOptionDraft(base, draft, 'fixed', { tone: '채팅 문체' })).toEqual({});
});

test('applying a draft to refreshed state preserves edits and independently saved fixed values', () => {
  const draft = editOptionDraft(base, {}, 'fixed', { tone: '채팅 문체', note: '작성 중인 메모' });
  const accepted = { ...base, revision: 4, fixedValues: { tone: '다른 창의 문체' } };
  expect(optionDraftValues(accepted, draft)).toEqual({
    fixed: { tone: '다른 창의 문체', note: '작성 중인 메모' },
    oneoff: { note: '작성 중인 메모' },
  });
});

test('saved-version review retains an explicit value equal to the previous fixed value and independent saved edits', () => {
  const draft = editOptionDraft(base, {}, 'oneoff', { tone: '채팅 문체' });
  const saved = { ...base, revision: 2, fixedValues: { tone: '외부 문체', note: '외부 메모' } };
  const review = reviewOptionDraft(base, draft, saved);
  expect(review).toEqual({ draft: { tone: { value: '채팅 문체' } }, discarded: [] });
  expect(optionDraftValues(saved, review.draft)).toEqual({
    fixed: { tone: '채팅 문체', note: '외부 메모' },
    oneoff: { tone: '채팅 문체' },
  });
});

test('saved-version review preserves unset intent even when the saved override is already absent', () => {
  const draft = editOptionDraft(base, {}, 'fixed', {});
  const saved = { ...base, revision: 2, fixedValues: { note: '외부 메모' } };
  expect(reviewOptionDraft(base, draft, saved)).toEqual({
    draft: { tone: { inherit: true } },
    discarded: [],
  });
});

test('definition review reports each incompatible edit once and does not copy untouched saved fixed values', () => {
  const initial = { ...base, fixedValues: { tone: '채팅 문체', note: '기존 메모' } };
  const draft = editOptionDraft(initial, {}, 'oneoff', { tone: '채팅 문체' });
  const saved = {
    ...initial,
    binding: { ...base.binding, definitionHash: 'removed-tone' },
    program: nativePrompt('', { customPromptTemplateToggle: 'note=메모=text' }),
    fixedValues: { note: '외부 메모' },
  };
  const review = reviewOptionDraft(initial, draft, saved);
  expect(review.draft).toEqual({});
  expect(review.discarded).toEqual([expect.objectContaining({ id: 'tone', value: '채팅 문체' })]);
  const unchanged = reviewOptionDraft(initial, {}, saved);
  expect(unchanged).toEqual({ draft: {}, discarded: [] });
  expect(optionDraftValues(saved, unchanged.draft).fixed).toEqual({ note: '외부 메모' });
});

const text = (id = 'tone', label = '문체'): PromptControl => ({
  id,
  label,
  type: 'text',
  default: '',
});
const choice = (label = '차분하게'): PromptControl => ({
  id: 'tone',
  label: '문체',
  type: 'select',
  default: '0',
  options: [
    { value: '0', label },
    { value: '1', label: '활기차게' },
  ],
});

test.each([
  { name: 'changed selected meaning', before: choice(), after: [choice('냉정하게')], value: '0' },
  {
    name: 'narrowed number range',
    before: { id: 'tone', label: '횟수', type: 'number' as const, default: 0, min: 0, max: 10 },
    after: [{ id: 'tone', label: '횟수', type: 'number' as const, default: 0, min: 0, max: 3 }],
    value: 5,
  },
])(
  'definition review reports $name once without mutating either state or the draft',
  ({ before, after, value }) => {
    const initial = { ...base, controls: [before] };
    const saved = {
      ...base,
      controls: after,
      binding: { ...base.binding, definitionHash: 'changed-definition' },
    };
    const draft = { tone: { value } };
    const originals = structuredClone({ initial, saved, draft });
    expect(reviewOptionDraft(initial, draft, saved)).toEqual({
      draft: {},
      discarded: [
        {
          scope: 'oneoff',
          id: 'tone',
          label: before.label,
          value,
          reason: expect.stringMatching(/\S/u),
        },
      ],
    });
    expect({ initial, saved, draft }).toEqual(originals);
  }
);

test('a heading rename preserves the edited value and explicit unset', () => {
  const initial = { ...base, controls: [choice()] };
  const saved = {
    ...initial,
    controls: [{ ...choice(), label: '새 제목' }],
    binding: { ...base.binding, definitionHash: 'renamed-definition' },
  };
  const draft: OptionDraft = { tone: { value: '0' } };
  expect(reviewOptionDraft(initial, draft, saved)).toEqual({ draft, discarded: [] });
  expect(reviewOptionDraft(initial, { tone: { inherit: true } }, saved)).toEqual({
    draft: { tone: { inherit: true } },
    discarded: [],
  });
});

test('definition review retains explicit false, zero and empty text values', () => {
  const initial = {
    ...base,
    controls: [
      { id: 'enabled', label: '사용', type: 'boolean' as const, default: true },
      { id: 'count', label: '횟수', type: 'number' as const, default: 1, min: 0, max: 3 },
      text('note', '메모'),
    ],
  };
  const draft: OptionDraft = {
    enabled: { value: false },
    count: { value: 0 },
    note: { value: '' },
  };
  expect(reviewOptionDraft(initial, draft, { ...initial, revision: 2 })).toEqual({
    draft,
    discarded: [],
  });
});
