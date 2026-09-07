import { expect, test } from 'vitest';
import { presentText, PRESENTATION_LIMITS } from '../server/presentation.js';

test('S06 renders a derived plain text value and preserves original source including HTML', async () => {
  const source = Object.freeze({ text: '<script>alert(1)</script> cat cat' });
  expect(await presentText(source.text, [{ pattern: 'cat', flags: 'g', replacement: '$1 <b>dog</b>' }])).toEqual({ ok: true, text: '<script>alert(1)</script> $1 <b>dog</b> $1 <b>dog</b>' });
  expect(source.text).toBe('<script>alert(1)</script> cat cat');
});

test('S06 terminates catastrophic regex and can run a subsequent worker', async () => {
  const original = 'a'.repeat(40_000) + '!';
  const start = performance.now();
  expect(await presentText(original, [{ pattern: '(a+)+$', flags: '', replacement: '' }])).toEqual({ ok: false, text: original, error: 'REGEX_TIMEOUT' });
  expect(performance.now() - start).toBeLessThan(3_000);
  expect(await presentText('still alive', [{ pattern: 'alive', flags: '', replacement: 'responsive' }])).toEqual({ ok: true, text: 'still responsive' });
});

test('S06 enforces input, rule, pattern, replacement and expanded output limits', async () => {
  const rule = { pattern: 'a', flags: 'g', replacement: 'b' };
  expect(await presentText('a'.repeat(PRESENTATION_LIMITS.input + 1), [rule])).toMatchObject({ ok: false, error: 'INPUT_LIMIT' });
  expect(await presentText('a', Array.from({ length: 9 }, () => rule))).toMatchObject({ ok: false, error: 'RULE_LIMIT' });
  expect(await presentText('a', [{ ...rule, pattern: 'a'.repeat(513) }])).toMatchObject({ ok: false, error: 'RULE_SIZE_LIMIT' });
  expect(await presentText('a', [{ ...rule, replacement: 'b'.repeat(2049) }])).toMatchObject({ ok: false, error: 'RULE_SIZE_LIMIT' });
  expect(await presentText('a'.repeat(100), [{ ...rule, replacement: 'b'.repeat(2048) }])).toEqual({ ok: false, text: 'a'.repeat(100), error: 'OUTPUT_LIMIT' });
});

test('S06 rejects invalid flags and patterns without leaking regex error details', async () => {
  for (const flags of ['gg', 'y', 'd', 'v', 'z', 'g;process.exit()']) {
    expect(await presentText('original', [{ pattern: 'a', flags, replacement: '' }])).toEqual({ ok: false, text: 'original', error: 'INVALID_FLAGS' });
  }
  expect(await presentText('original', [{ pattern: '[PRIVATE', flags: '', replacement: '' }])).toEqual({ ok: false, text: 'original', error: 'INVALID_PATTERN' });
});

test('S06 advances zero-length Unicode matches without looping or splitting characters', async () => {
  expect(await presentText('😀', [{ pattern: '(?:)', flags: 'gu', replacement: '-' }])).toEqual({ ok: true, text: '-😀-' });
});
