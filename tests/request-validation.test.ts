import { describe, expect, it } from 'vitest';
import { HttpError } from '../server/store.js';
import { fields, number, record, text } from '../server/product-store.js';
import * as validation from '../server/request-validation.js';

function rejectsRequest(action: () => unknown, message: string) {
  try {
    action();
    expect.fail('Invalid request was accepted');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ statusCode: 400, message });
  }
}

describe('shared request validation contract', () => {
  it('preserves existing imports and the HttpError identity used by HTTP error handling', () => {
    expect(HttpError).toBe(validation.HttpError);
    expect({ fields, number, record, text }).toEqual({
      fields: validation.fields,
      number: validation.number,
      record: validation.record,
      text: validation.text,
    });
  });

  it('rejects non-record payloads and unknown fields without copying or dropping input', () => {
    for (const value of [null, undefined, [], 'text', 1, true])
      rejectsRequest(() => record(value), 'Expected an object');
    const body = { text: 'kept', revision: 1 };
    expect(record(body)).toBe(body);
    fields(body, ['text', 'revision']);
    rejectsRequest(() => fields(body, ['text']), 'Unknown request field');
    expect(body).toEqual({ text: 'kept', revision: 1 });
  });

  it('preserves authored whitespace and explicit empty values while enforcing character limits', () => {
    expect(text(' a ', 'text', 3)).toBe(' a ');
    expect(text('', 'text', 0, true)).toBe('');
    expect(text('  ', 'text', 2, true)).toBe('  ');
    for (const value of ['', '  ', 'abcd', null, 123])
      rejectsRequest(() => text(value, 'text', 3), 'Invalid text');
    rejectsRequest(() => text('a', 'text', 0, true), 'Invalid text');
  });

  it('accepts inclusive integer boundaries without coercion, truncation or unsafe revisions', () => {
    expect(number(0, 'revision', 0, 2)).toBe(0);
    expect(number(2, 'revision', 0, 2)).toBe(2);
    for (const value of [-1, 3, 1.5, '1', null, NaN, Infinity])
      rejectsRequest(() => number(value, 'revision', 0, 2), 'Invalid revision');
    rejectsRequest(
      () => number(Number.MAX_SAFE_INTEGER + 1, 'revision', 0, Infinity),
      'Invalid revision'
    );
  });
});
