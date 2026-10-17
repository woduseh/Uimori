import { expect, test } from 'vitest';
import type { CurrentPrompt } from '../core/product.js';
import type { OptionValues } from '../core/chat-options.js';
import { reviewGlobalOptionDraft } from '../web/global-option-review.js';
import { nativePrompt } from './fixtures/native-prompt.js';

function prompt(declarations: string, values: OptionValues, presetId = 'writing'): CurrentPrompt {
  return {
    title: '검토할 작문 프롬프트',
    presetId,
    program: nativePrompt('Writing instructions', { customPromptTemplateToggle: declarations }),
    values,
  };
}
const textControls = 'tone=문체=text\nnote=메모=text\nextra=추가 메모=text';

test('global review overlays only local changes and keeps remote values without mutating its inputs', () => {
  const base = prompt(textControls, { tone: 'old', note: 'old' });
  const draft = { tone: 'local', note: 'old' };
  const saved = prompt(textControls, { tone: 'remote', note: 'remote', extra: 'new' });
  const before = structuredClone({ base, draft, saved });
  expect(reviewGlobalOptionDraft(base, draft, saved)).toEqual({
    values: { tone: 'local', note: 'remote', extra: 'new' },
    discarded: [],
  });
  expect({ base, draft, saved }).toEqual(before);
});

test('an unrelated definition change never replays unchanged global inputs over remote edits', () => {
  const base = prompt('tone=문체=text\nnote=메모=text', { tone: 'old', note: 'old' });
  const saved = prompt(textControls, { tone: 'remote', note: 'remote', extra: 'new' });
  expect(reviewGlobalOptionDraft(base, { tone: 'local', note: 'old' }, saved)).toEqual({
    values: { tone: 'local', note: 'remote', extra: 'new' },
    discarded: [],
  });
});

test('resetting a compatible option preserves that reset and independent remote values after a definition change', () => {
  const base = prompt('tone=문체=text\nnote=메모=text', { tone: 'old', note: 'old' });
  const saved = prompt(textControls, { tone: 'remote', note: 'remote', extra: 'new' });
  expect(reviewGlobalOptionDraft(base, { note: 'old' }, saved)).toEqual({
    values: { note: 'remote', extra: 'new' },
    discarded: [],
  });
});

test.each<{
  name: string;
  before: string;
  after: string;
  initial: string;
  value: string;
  saved: OptionValues;
}>([
  {
    name: 'removed option',
    before: 'tone=문체=text',
    after: 'note=메모=text',
    initial: 'old',
    value: 'local',
    saved: { note: 'remote' },
  },
  {
    name: 'changed input type',
    before: 'tone=문체=text',
    after: 'tone=문체=select=차분하게,활기차게',
    initial: 'old',
    value: '0',
    saved: { tone: '1' },
  },
  {
    name: 'changed selected option meaning',
    before: 'tone=문체=select=차분하게,활기차게',
    after: 'tone=문체=select=냉정하게,활기차게',
    initial: '1',
    value: '0',
    saved: { tone: '1' },
  },
  {
    name: 'removed selected value',
    before: 'tone=문체=select=차분하게,활기차게,간결하게',
    after: 'tone=문체=select=차분하게,활기차게',
    initial: '0',
    value: '2',
    saved: { tone: '0' },
  },
])(
  'global review reports the original input for a $name',
  ({ before, after, initial, value, saved }) => {
    const base = prompt(before, { tone: initial });
    const latest = prompt(after, saved);
    expect(reviewGlobalOptionDraft(base, { tone: value }, latest)).toEqual({
      values: saved,
      discarded: [{ id: 'tone', label: '문체', value, reason: expect.stringMatching(/\S/u) }],
    });
  }
);

test('a text label edit preserves changed text and does not replay unchanged text', () => {
  const base = prompt('tone=이전 문체=text\nnote=메모=text', { tone: 'old', note: 'old' });
  const saved = prompt('tone=새 문체=text\nnote=메모=text', { tone: 'remote', note: 'remote' });
  expect(reviewGlobalOptionDraft(base, { tone: '', note: 'old' }, saved)).toEqual({
    values: { tone: '', note: 'remote' },
    discarded: [],
  });
});

test('an owner change retains new saved values and reports old inputs even when their IDs and types match', () => {
  const base = prompt(textControls, { tone: 'old', note: 'old' });
  const saved = prompt(textControls, { tone: 'new owner', note: 'new owner' }, 'other');
  const reviewed = reviewGlobalOptionDraft(base, { tone: 'local', note: 'old' }, saved);
  expect(reviewed.values).toEqual(saved.values);
  expect(reviewed.discarded).toEqual([
    { id: 'tone', label: '문체', value: 'local', reason: expect.stringMatching(/\S/u) },
    { id: 'note', label: '메모', value: 'old', reason: expect.stringMatching(/\S/u) },
  ]);
});

test.each(['owner', 'type'] as const)(
  'a reset from a changed %s cannot erase a new saved value and remains visible for review',
  (changed) => {
    const base = prompt('tone=문체=text', { tone: 'old' });
    const saved =
      changed === 'owner'
        ? prompt('tone=문체=text', { tone: 'new owner' }, 'other')
        : prompt('tone=문체=select=차분하게,활기차게', { tone: '1' });
    expect(reviewGlobalOptionDraft(base, {}, saved)).toEqual({
      values: saved.values,
      discarded: [
        {
          id: 'tone',
          label: '문체',
          value: null,
          unset: true,
          reason: expect.stringMatching(/\S/u),
        },
      ],
    });
  }
);

test('resetting an enum does not transfer its old selected meaning across changed choices', () => {
  const base = prompt('tone=문체=select=차분하게,활기차게', { tone: '0' });
  const saved = prompt('tone=문체=select=활기차게,냉정하게', { tone: '0' });
  expect(reviewGlobalOptionDraft(base, {}, saved)).toEqual({ values: {}, discarded: [] });
});
