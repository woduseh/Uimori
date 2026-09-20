import { afterAll, describe, expect, it } from 'vitest';
import { get_encoding } from 'tiktoken';
import { countTextTokens } from '../core/text-tokens.js';
import { estimateContextTokens } from '../core/context-budget.js';

const reference = get_encoding('o200k_base');
afterAll(() => reference.free());

function boundedReference(text: string): number {
  let total = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 4096, text.length);
    const before = text.charCodeAt(end - 1),
      after = text.charCodeAt(end);
    if (
      end < text.length &&
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    )
      end--;
    total += reference.encode(text.slice(start, end), [], []).length;
    start = end;
  }
  return total;
}

describe('offline text token counting', () => {
  it.each([
    '',
    'The harbor is quiet tonight.',
    '항구에는 아무도 없었다. 나는 조용히 문을 열었다.',
    'こんにちは。今日は何をしましょうか？',
    'Hello 재연님、日本語も 같이 써요. 👩‍💻 🧑🏽‍🚀',
    'line one\n"quote"\\path\n<|endoftext|>',
  ])('matches o200k for short authored text: %s', (text) => {
    expect(countTextTokens(text)).toBe(reference.encode(text, [], []).length);
  });

  it('preserves the existing bounded algorithm across mixed Unicode chunk boundaries', () => {
    const text = `${'a'.repeat(4095)}😀日本語 한국어\n${' hello'.repeat(1500)}`;
    expect(countTextTokens(text)).toBe(boundedReference(text));
    expect(countTextTokens(text)).toBe(boundedReference(text));
  });

  it('does not add JSON quoting or the request safety margin to plain text', () => {
    const text = 'a\n"b"';
    expect(countTextTokens(text)).toBe(reference.encode(text, [], []).length);
    expect(estimateContextTokens(text)).toBe(
      Math.ceil((boundedReference(JSON.stringify(text)) * 11) / 10)
    );
  });

  it('keeps serialized request v1 accounting, including special spellings and long inputs', () => {
    const body = {
      messages: [{ role: 'user', content: ' 한국어 😀 <|endoftext|>'.repeat(400) }],
      tools: [],
    };
    expect(estimateContextTokens(body)).toBe(
      Math.ceil((boundedReference(JSON.stringify(body)) * 11) / 10)
    );
  });

  it('rejects invalid text and unserializable request values', () => {
    expect(() => countTextTokens(3 as unknown as string)).toThrow('INVALID_CONTEXT_INPUT');
    expect(() => estimateContextTokens(undefined)).toThrow('INVALID_CONTEXT_INPUT');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => estimateContextTokens(circular)).toThrow('INVALID_CONTEXT_INPUT');
  });
});
