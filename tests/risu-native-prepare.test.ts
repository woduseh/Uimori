import { expect, test } from 'vitest';
import { prepareNativeRisuText } from '../server/risu-native-prepare.js';
import { nativeContent } from './fixtures/native-content.js';

test('batched preparation preserves field, greeting and message variable order and full-history reads', async () => {
  const native = nativeContent().nativeRisu!;
  const input = {
    native,
    fields: [{ key: 'bot', fields: { body: '{{setvar::x::field}}' } }],
    greeting: '{{getvar::x}}{{setvar::x::greeting}}',
    context: {
      variables: {},
      messages: [
        { role: 'char' as const, data: '{{getvar::x}}{{setvar::x::first}}|{{lastmessage}}' },
        { role: 'user' as const, data: '{{getvar::x}}' },
      ],
    },
  };
  const result = await prepareNativeRisuText(input);
  expect(result).toEqual({
    fields: { bot: { body: '' } },
    greeting: 'field',
    texts: ['greeting|{{getvar::x}}', 'first'],
    variables: { x: 'first' },
    issues: [],
  });
  expect(input.context.variables).toEqual({});
});

test('history preparation retains assistant scenes and authored greeting before a user input', async () => {
  const result = await prepareNativeRisuText({
    native: nativeContent().nativeRisu!,
    fields: [],
    greeting: '{{#if {{equal::{{role}}::char}}}}OPENING{{/if}}',
    context: {
      variables: {},
      messages: [
        { role: 'char', data: '{{#if {{equal::{{role}}::char}}}}PREVIOUS SCENE{{/if}}' },
        { role: 'user', data: '{{#if {{equal::{{role}}::user}}}}CONTINUE{{/if}}' },
      ],
    },
  });
  expect(result.texts).toEqual(['PREVIOUS SCENE', 'CONTINUE']);
  expect(result.greeting).toBe('OPENING');
  expect(result.issues).toEqual([]);
});

test('an aborted or timed-out batch returns no partial preparation', async () => {
  const input = {
    native: nativeContent().nativeRisu!,
    fields: [],
    context: { variables: {}, messages: [] },
  };
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(prepareNativeRisuText(input, cancelled.signal)).rejects.toThrow('CANCELLED');
  const active = new AbortController();
  const pending = prepareNativeRisuText(input, active.signal);
  active.abort();
  await expect(pending).rejects.toThrow('CANCELLED');
  const slow = {
    ...input,
    native: {
      ...input.native,
      module: { regex: [{ type: 'editprocess', in: '(a+)+$', out: '' }] },
    },
    context: { variables: {}, messages: [{ role: 'user' as const, data: 'a'.repeat(40) + '!' }] },
  };
  await expect(prepareNativeRisuText(slow, undefined, 100)).rejects.toThrow('RISU_NATIVE_TIMEOUT');
});
