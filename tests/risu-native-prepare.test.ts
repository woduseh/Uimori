import { expect, test } from 'vitest';
import { prepareNativeRisuText } from '../server/risu-native-prepare.js';
import { processNativeRisuText } from '../server/risu-native-render.js';
import { evaluateNativeRisuFields } from '../server/risu-native-cbs.js';
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
        { role: 'char' as const, data: '{{getvar::x}}{{setvar::x::first}}' },
        { role: 'user' as const, data: '{{getvar::x}}|{{lastmessage}}' },
      ],
    },
  };
  const evaluated = await evaluateNativeRisuFields({
    native,
    fields: input.fields[0].fields,
    context: input.context,
  });
  let variables = evaluated.variables;
  const texts: string[] = [];
  for (const [index, text] of [
    input.greeting,
    ...input.context.messages.map((message) => message.data),
  ].entries()) {
    const result = await processNativeRisuText({
      native,
      text,
      mode: 'editprocess',
      context: { ...input.context, variables, messageIndex: index - 1 },
    });
    variables = result.variables;
    texts.push(result.text);
  }
  const result = await prepareNativeRisuText(input);
  expect(result).toEqual({
    fields: { bot: evaluated.fields },
    greeting: texts[0],
    texts: texts.slice(1),
    variables,
    issues: [],
  });
  expect(input.context.variables).toEqual({});
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
