import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { assertRisuContent, validateRisuContent, type RisuContent } from '../core/risu-content.js';
import { assertRisuContentSource, validateRisuContentSource } from '../core/risu-native.js';
import { compileContentAttachment } from '../core/package-runtime.js';

function content(): RisuContent {
  const card = { name: 'Validation fixture', description: 'Body' };
  return {
    version: 1,
    id: 'fixture',
    revision: 1,
    title: card.name,
    description: '',
    body: card.description,
    nativeRisu: {
      version: 1,
      card,
      assets: [],
      sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
    },
    lore: [
      {
        id: 'later',
        title: 'Later',
        description: '',
        text: 'Second lore',
        loading: 'discoverable',
        relatedIds: ['first'],
        loreContext: { placement: 'scene', group: 'one', order: 2 },
        nativeRisuPosition: { mode: 'depth', depth: 1, role: 'system', order: 2 },
      },
      {
        id: 'first',
        title: 'First',
        description: '',
        text: 'First lore',
        loading: 'pinned',
        loreContext: { placement: 'scene', group: 'one', order: 1 },
      },
    ],
    instructions: [{ id: 'instruction', target: 'main', text: 'Keep the voice.' }],
  };
}
const attachment = { id: 'fixture', revision: 1, role: 'bot' as const };
const context = { chatId: 'chat', target: 'main' as const };
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

test('validation can borrow a value without replacing or mutating its object graph', () => {
  const input: unknown = content();
  const before = structuredClone(input);
  freeze(input);
  assertRisuContent(input);
  expect(input.id).toBe('fixture');
  expect(input).toEqual(before);
});

test('the existing validator still returns a detached editable copy', () => {
  const input = content();
  const result = validateRisuContent(input);
  expect(result).toEqual(input);
  expect(result).not.toBe(input);
  result.lore[0].text = 'Edited';
  result.lore[0].relatedIds!.push('later');
  result.nativeRisu.card.description = 'Edited card';
  expect(input.lore[0].text).toBe('Second lore');
  expect(input.lore[0].relatedIds).toEqual(['first']);
  expect(input.nativeRisu.card.description).toBe('Body');
});

test('compilation is read-only and preserves grouping, ordering and role filtering', () => {
  const input = content();
  freeze(input);
  const result = compileContentAttachment(input, attachment, context);
  expect(result.resources.map((item) => item.id)).toEqual([
    'package:fixture:bot:body',
    'package:fixture:bot:lore:first',
    'package:fixture:bot:lore:later',
  ]);
  expect(result.instructions).toEqual([
    { id: 'package:fixture:bot:instruction:instruction', text: 'Keep the voice.' },
  ]);
  expect(
    compileContentAttachment(input, attachment, { ...context, target: 'translation' }).instructions
  ).toEqual([]);
  expect(
    compileContentAttachment(input, attachment, { ...context, resourcesOnly: true }).instructions
  ).toEqual([]);
  expect(input.lore.map((item) => item.id)).toEqual(['later', 'first']);
});

test('mutating compiled nested metadata cannot change its source or another compilation', () => {
  const input = content();
  const before = structuredClone(input);
  const first = compileContentAttachment(input, attachment, context);
  const second = compileContentAttachment(input, attachment, context);
  const resource = first.resources.find((item) => item.id.endsWith('lore:later'))!;
  resource.text = 'Changed';
  resource.relatedIds!.push('other');
  resource.loreContext!.group = 'Changed';
  resource.nativeRisuPosition!.depth = 9;
  resource.risuSource!.sourceName = 'Changed';
  first.instructions[0].text = 'Changed';
  expect(input).toEqual(before);
  expect(compileContentAttachment(input, attachment, context)).toEqual(second);
});

test('a selected optional lore is pinned without mutating its saved loading mode', () => {
  const input = content();
  input.loreActivation = { mode: 'model' };
  const result = compileContentAttachment(input, attachment, {
    ...context,
    loreSelection: new Set(['later']),
  });
  expect(result.pinned.map((item) => item.id)).toContain('package:fixture:bot:lore:later');
  expect(input.lore[0].loading).toBe('discoverable');
});

test('assertion, copying validation and compilation reject the same malformed content', () => {
  const invalid = [
    { ...content(), extra: true },
    { ...content(), version: 2 },
    { ...content(), revision: 0 },
    { ...content(), id: 'invalid id' },
    { ...content(), title: 'x'.repeat(201) },
    { ...content(), lore: [content().lore[0], content().lore[0]] },
    { ...content(), lore: [{ ...content().lore[0], relatedIds: ['absent'] }] },
    { ...content(), lore: [{ ...content().lore[0], loading: 'other' }] },
    { ...content(), loreActivation: { mode: 'other' } },
  ];
  for (const input of invalid) {
    const code = (run: () => unknown) => {
      try {
        run();
        throw new Error('Expected invalid content to be rejected');
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('PACKAGE_')) throw error;
        return error.message;
      }
    };
    const copied = code(() => validateRisuContent(input));
    expect(code(() => assertRisuContent(input))).toBe(copied);
    expect(code(() => compileContentAttachment(input as RisuContent, attachment, context))).toBe(
      copied
    );
  }
});

test('content byte budgets are still checked before compilation', () => {
  const input = content();
  input.lore = Array.from({ length: 14 }, (_, index) => ({
    id: `entry-${index}`,
    title: '',
    description: '',
    text: 'x'.repeat(1_000_000),
    loading: 'discoverable',
  }));
  expect(() => assertRisuContent(input)).toThrow('PACKAGE_SIZE_LIMIT');
  expect(() => compileContentAttachment(input, attachment, context)).toThrow('PACKAGE_SIZE_LIMIT');
});

test('revision, attachment and chat scope checks are retained', () => {
  expect(() =>
    compileContentAttachment(content(), { ...attachment, revision: 2 }, context)
  ).toThrow('PACKAGE_REVISION_MISMATCH');
  expect(() =>
    compileContentAttachment(content(), { ...attachment, revision: 0 }, context)
  ).toThrow('PACKAGE_INVALID_ATTACHMENT');
  expect(() =>
    compileContentAttachment(content(), attachment, { ...context, chatId: '' })
  ).toThrow('PACKAGE_CHAT_REQUIRED');
});

test('native source validation borrows data while the editing API keeps a detached copy', () => {
  const input = content().nativeRisu;
  freeze(input);
  assertRisuContentSource(input);
  const edited = validateRisuContentSource(input);
  edited.card.description = 'Edited';
  expect(input.card.description).toBe('Body');
  expect(edited).not.toBe(input);
});

test('native shape, JSON, depth and byte limits are retained by all validation paths', () => {
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 101; depth++) nested = { nested };
  const invalid = [
    { ...content().nativeRisu, sourceHash: 'wrong' },
    { ...content().nativeRisu, assets: [{ name: '', uri: '', imageId: 'bad id' }] },
    { ...content().nativeRisu, card: { value: undefined } },
    { ...content().nativeRisu, card: { value: Number.NaN } },
    { ...content().nativeRisu, card: nested },
    { ...content().nativeRisu, card: { text: 'x'.repeat(8 * 1024 * 1024) } },
  ];
  for (const native of invalid) {
    expect(() => assertRisuContentSource(native)).toThrow();
    expect(() => validateRisuContentSource(native)).toThrow();
    const input = { ...content(), nativeRisu: native };
    expect(() => assertRisuContent(input)).toThrow();
    expect(() => validateRisuContent(input)).toThrow();
    expect(() => compileContentAttachment(input, attachment, context)).toThrow();
  }
});
