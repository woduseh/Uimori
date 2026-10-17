import { expect, test } from 'vitest';
import type { ChatOptionState, OptionValues } from '../core/chat-options.js';
import type { PromptControl } from '../core/risu-prompt.js';
import { reviewChatOptionDraft } from '../web/chat-option-review.js';
import { nativePrompt } from './fixtures/native-prompt.js';

const text = (id: string, label = id): PromptControl => ({
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
function state(
  controls: PromptControl[],
  fixedValues: OptionValues = {},
  patch: Partial<ChatOptionState> = {}
): ChatOptionState {
  return {
    chatId: 'review-chat',
    revision: 7,
    binding: { owner: 'preset:writing', definitionHash: 'original-definition' },
    workspaceRevision: 3,
    program: nativePrompt(),
    controls,
    globalValues: {},
    fixedValues,
    pending: [],
    conflicts: [],
    ...patch,
  };
}

test('same-binding review overlays only local edits and explicit removals on independent saved changes', () => {
  const controls = ['edited', 'untouched', 'removed', 'remoteOnly'].map((id) => text(id));
  const base = state(controls, { edited: 'old', untouched: 'old', removed: 'old' });
  const saved = state(
    controls,
    { edited: 'remote', untouched: 'remote', removed: 'remote', remoteOnly: 'new' },
    { revision: 8 }
  );
  const fixed = { edited: 'local', untouched: 'old' };
  const oneoff = { edited: 'next generation only' };
  const before = structuredClone({ base, saved, fixed, oneoff });
  expect(reviewChatOptionDraft(base, fixed, oneoff, saved)).toEqual({
    fixed: { edited: 'local', untouched: 'remote', remoteOnly: 'new' },
    oneoff,
    discarded: [],
  });
  expect({ base, saved, fixed, oneoff }).toEqual(before);
});

test('an unchanged local draft adopts saved fixed values while keeping valid oneoff inputs', () => {
  const controls = [text('tone'), text('note')];
  const base = state(controls, { tone: 'old' });
  const saved = state(controls, { tone: 'remote', note: 'new' }, { revision: 8 });
  expect(reviewChatOptionDraft(base, { tone: 'old' }, { note: 'oneoff' }, saved)).toEqual({
    fixed: { tone: 'remote', note: 'new' },
    oneoff: { note: 'oneoff' },
    discarded: [],
  });
});

test('a changed definition rechecks all fixed inputs and retains valid text values after a label edit', () => {
  const base = state([text('tone', '이전 문체')], { tone: 'unchanged local value' });
  const saved = state(
    [text('tone', '새 문체'), text('remoteOnly')],
    { remoteOnly: 'remote' },
    {
      revision: 8,
      binding: { ...base.binding, definitionHash: 'renamed-definition' },
    }
  );
  expect(
    reviewChatOptionDraft(base, { tone: 'unchanged local value' }, { tone: 'oneoff' }, saved)
  ).toEqual({
    fixed: { remoteOnly: 'remote', tone: 'unchanged local value' },
    oneoff: { tone: 'oneoff' },
    discarded: [],
  });
});

test.each([
  {
    name: 'removed control',
    before: text('tone', '문체'),
    after: [] as PromptControl[],
    value: 'my text',
  },
  { name: 'changed control type', before: text('tone', '문체'), after: [choice()], value: '0' },
  {
    name: 'removed selected value',
    before: choice(),
    after: [{ ...choice(), options: [{ value: '0', label: '차분하게' }] }],
    value: '1',
  },
  {
    name: 'changed meaning of the selected value',
    before: choice(),
    after: [choice('냉정하게')],
    value: '0',
  },
  {
    name: 'value outside the new number range',
    before: { id: 'tone', label: '횟수', type: 'number' as const, default: 0, min: 0, max: 10 },
    after: [{ id: 'tone', label: '횟수', type: 'number' as const, default: 0, min: 0, max: 3 }],
    value: 5,
  },
])(
  'review reports original fixed and oneoff values for $name without applying them',
  ({ before, after, value }) => {
    const base = state([before]);
    const saved = state(
      after,
      {},
      {
        revision: 8,
        binding: { ...base.binding, definitionHash: 'changed-definition' },
      }
    );
    const review = reviewChatOptionDraft(base, { tone: value }, { tone: value }, saved);
    expect(review.fixed).toEqual({});
    expect(review.oneoff).toEqual({});
    expect(review.discarded).toHaveLength(2);
    for (const scope of ['fixed', 'oneoff'])
      expect(review.discarded).toContainEqual({
        scope,
        id: 'tone',
        label: before.label,
        value,
        reason: expect.any(String),
      });
    expect(review.discarded.every((item) => item.reason.trim().length > 0)).toBe(true);
  }
);

test('unchanged selected option meaning survives an enum heading rename', () => {
  const base = state([choice()]);
  const saved = state(
    [{ ...choice(), label: '새 문체 제목' }],
    {},
    {
      binding: { ...base.binding, definitionHash: 'renamed-heading' },
    }
  );
  expect(reviewChatOptionDraft(base, { tone: '0' }, { tone: '1' }, saved)).toEqual({
    fixed: { tone: '0' },
    oneoff: { tone: '1' },
    discarded: [],
  });
});

test('a new prompt owner never receives values from an old owner despite identical IDs and declarations', () => {
  const controls = [text('tone', '문체')];
  const base = state(controls, { tone: 'old saved value' });
  const saved = state(
    controls,
    { tone: 'new owner value' },
    {
      binding: { owner: 'preset:another-prompt', definitionHash: base.binding.definitionHash },
    }
  );
  const reviewed = reviewChatOptionDraft(
    base,
    { tone: 'old saved value' },
    { tone: 'oneoff' },
    saved
  );
  expect(reviewed.fixed).toEqual(saved.fixedValues);
  expect(reviewed.oneoff).toEqual({});
  expect(reviewed.discarded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: 'fixed', id: 'tone', value: 'old saved value' }),
      expect.objectContaining({ scope: 'oneoff', id: 'tone', value: 'oneoff' }),
    ])
  );
  expect(reviewed.discarded).toHaveLength(2);
});

test('adding an unrelated option preserves a local unset on the same owner and unchanged control type', () => {
  const base = state([text('tone', '문체')], { tone: 'old saved value' });
  const saved = state(
    [text('tone', '문체'), text('remoteOnly', '새 옵션')],
    { tone: 'old saved value', remoteOnly: 'independent' },
    { binding: { ...base.binding, definitionHash: 'definition-with-another-option' } }
  );
  expect(reviewChatOptionDraft(base, {}, {}, saved)).toEqual({
    fixed: { remoteOnly: 'independent' },
    oneoff: {},
    discarded: [],
  });
});

test('an enum label or order change does not prevent unsetting that option', () => {
  const base = state([choice()], { tone: '0' });
  const saved = state(
    [{ ...choice('새 선택지'), options: [...choice('새 선택지').options!].reverse() }],
    { tone: '0' },
    { binding: { ...base.binding, definitionHash: 'changed-enum-label-and-order' } }
  );
  expect(reviewChatOptionDraft(base, {}, {}, saved)).toEqual({
    fixed: {},
    oneoff: {},
    discarded: [],
  });
});

test.each(['owner', 'type'] as const)(
  'an unset cannot delete a saved value after an incompatible %s change and remains visible for review',
  (changed) => {
    const controls = [text('tone'), text('remoteOnly')];
    const base = state(controls, { tone: 'old saved value' });
    const saved = state(
      changed === 'type' ? [choice(), text('remoteOnly')] : controls,
      { tone: changed === 'type' ? '0' : 'new owner value', remoteOnly: 'independent' },
      {
        binding: {
          owner: changed === 'owner' ? 'preset:other' : base.binding.owner,
          definitionHash: changed === 'type' ? 'new-type-definition' : base.binding.definitionHash,
        },
      }
    );
    expect(reviewChatOptionDraft(base, {}, {}, saved)).toEqual({
      fixed: saved.fixedValues,
      oneoff: {},
      discarded: [
        {
          scope: 'fixed',
          id: 'tone',
          label: 'tone',
          value: null,
          unset: true,
          reason: expect.any(String),
        },
      ],
    });
  }
);

test('false, zero and empty text are valid explicit overrides rather than missing values', () => {
  const controls: PromptControl[] = [
    { id: 'enabled', label: '사용', type: 'boolean', default: true },
    { id: 'count', label: '횟수', type: 'number', default: 1, min: 0, max: 3 },
    text('note', '메모'),
  ];
  const base = state(controls);
  const values = { enabled: false, count: 0, note: '' };
  expect(reviewChatOptionDraft(base, values, values, state(controls))).toEqual({
    fixed: values,
    oneoff: values,
    discarded: [],
  });
});
