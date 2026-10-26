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

test('switching a clean draft does not reserve saved fixed options or make changes', () => {
  expect(optionDraftValues(base, {})).toEqual({ fixed: { tone: '채팅 문체' }, oneoff: {} });
});

test('both scopes keep the same edits while preserving untouched fixed values', () => {
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
  // An edit to a different field must not turn the removed fixed override into a pinned default.
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

test('a oneoff value equal to the inherited value remains an explicit reservation', () => {
  const draft = editOptionDraft(base, {}, 'oneoff', { tone: '채팅 문체' });
  expect(optionDraftValues(base, draft).oneoff).toEqual({ tone: '채팅 문체' });
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

test('an incompatible unset is reviewed once even if the saved fixed value is absent', () => {
  const draft = editOptionDraft(base, {}, 'fixed', {});
  const saved = { ...base, binding: { ...base.binding, owner: 'preset:other' }, fixedValues: {} };
  const review = reviewOptionDraft(base, draft, saved);
  expect(review.draft).toEqual({});
  expect(review.discarded).toEqual([expect.objectContaining({ id: 'tone', unset: true })]);
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
  { name: 'removed control', before: text(), after: [], value: 'my text' },
  { name: 'changed control type', before: text(), after: [choice()], value: '0' },
  {
    name: 'removed selected value',
    before: choice(),
    after: [{ ...choice(), options: [{ value: '0', label: '차분하게' }] }],
    value: '1',
  },
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

test.each([text(), choice()])(
  'a heading rename preserves the edited value and explicit unset for $type',
  (control) => {
    const initial = { ...base, controls: [control] };
    const saved = {
      ...initial,
      controls: [{ ...control, label: '새 제목' }],
      binding: { ...base.binding, definitionHash: 'renamed-definition' },
    };
    const draft: OptionDraft = { tone: { value: control.type === 'select' ? '0' : 'my text' } };
    expect(reviewOptionDraft(initial, draft, saved)).toEqual({ draft, discarded: [] });
    expect(reviewOptionDraft(initial, { tone: { inherit: true } }, saved)).toEqual({
      draft: { tone: { inherit: true } },
      discarded: [],
    });
  }
);

test('an enum choice label or order change still permits an explicit unset', () => {
  const initial = { ...base, controls: [choice()] };
  const saved = {
    ...initial,
    controls: [{ ...choice('새 선택지'), options: [...choice('새 선택지').options!].reverse() }],
  };
  expect(reviewOptionDraft(initial, { tone: { inherit: true } }, saved)).toEqual({
    draft: { tone: { inherit: true } },
    discarded: [],
  });
});

test.each(['owner', 'type'] as const)(
  'incompatible %s review preserves saved values and reports unsets before values',
  (changed) => {
    const initial = { ...base, controls: [text(), text('note', '메모')] };
    const saved = {
      ...initial,
      controls:
        changed === 'type'
          ? [choice(), { ...text('note', '메모'), type: 'boolean' as const, default: true }]
          : initial.controls,
      binding: {
        ...base.binding,
        owner: changed === 'owner' ? 'preset:other' : base.binding.owner,
      },
      fixedValues: { tone: changed === 'type' ? '0' : 'other owner', note: 'independent' },
    };
    const draft: OptionDraft = { note: { value: 'local note' }, tone: { inherit: true } };
    const originals = structuredClone({ initial, saved, draft });
    expect(reviewOptionDraft(initial, draft, saved)).toEqual({
      draft: {},
      discarded: [
        {
          scope: 'fixed',
          id: 'tone',
          label: '문체',
          value: null,
          unset: true,
          reason: expect.stringMatching(/\S/u),
        },
        {
          scope: 'oneoff',
          id: 'note',
          label: '메모',
          value: 'local note',
          reason: expect.stringMatching(/\S/u),
        },
      ],
    });
    expect({ initial, saved, draft }).toEqual(originals);
  }
);

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
