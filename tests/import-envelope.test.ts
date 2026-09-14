import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { RISU_PLUGIN_MAX_BYTES } from '../core/risu-plugin.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { readImportEnvelope } from '../server/import-envelope.js';
import { HttpError } from '../server/request-validation.js';
import { readRisuPresetFile } from '../server/risu-preset-file.js';
import { readRisuPlugin } from '../server/risu-plugin-import.js';

const options = {
  maxBytes: 64,
  extensions: /\.json$/iu,
  invalid: 'SAMPLE_INVALID_FILE',
  tooLarge: 'SAMPLE_TOO_LARGE',
};
const payload = Buffer.from('{"name":"sample"}');
const inline = (bytes = payload, name = 'sample.json') => ({
  name,
  base64: bytes.toString('base64'),
});
const uploadId = 'a'.repeat(32);
const refuses = (value: unknown, statusCode: number, message: string) => {
  expect(() => readImportEnvelope(value, options)).toThrowError(
    expect.objectContaining({ statusCode, message })
  );
  expect(() => readImportEnvelope(value, options)).toThrow(HttpError);
};

test('the inline form returns the sent bytes, its name and their SHA-256', () => {
  const source = inline();
  expect(readImportEnvelope(source, options)).toEqual({
    name: 'sample.json',
    bytes: payload,
    sha256: createHash('sha256').update(payload).digest('hex'),
    staged: false,
    source,
  });
  // The digest names the file that arrived, not the decoded text or the reader's own reading.
  expect(readImportEnvelope(source, options).sha256).toBe(
    '976cd2d13306ef7b411425368f511318aed70ea05278b4e7559099f7820eaf1b'
  );
});

test('only the exact field set of the offered form is read', () => {
  for (const value of [null, [], 'sample.json', 3])
    expect(() => readImportEnvelope(value, options)).toThrowError(
      expect.objectContaining({ statusCode: 400, message: 'Expected an object' })
    );
  for (const value of [
    { ...inline(), kind: 'bot' },
    { ...inline(), uploadId },
    { ...inline(), b: 1 },
  ])
    refuses(value, 400, 'Unknown request field');
  // A missing half of the form is the reader's own refusal, not an unknown field.
  refuses({}, 400, options.invalid);
  refuses({ name: 'sample.json' }, 400, options.invalid);
  refuses({ base64: payload.toString('base64') }, 400, options.invalid);
});

test('the file name must be one trimmed visible segment with an extension the reader reads', () => {
  for (const name of [
    '',
    '   ',
    ' sample.json',
    'sample.json ',
    '../sample.json',
    'folder/sample.json',
    'folder\\sample.json',
    'C:sample.json',
    'sample\u0000.json',
    'sample\u001f.json',
    'sample\u007f.json',
    `${'a'.repeat(251)}.json`,
    'sample.txt',
    'sample',
    3,
    null,
  ])
    refuses({ name, base64: payload.toString('base64') }, 400, options.invalid);
  expect(readImportEnvelope(inline(payload, `${'a'.repeat(250)}.json`), options).name).toHaveLength(
    255
  );
  expect(readImportEnvelope(inline(payload, 'sample.JSON'), options).name).toBe('sample.JSON');
});

test('the body must re-encode to exactly the bytes that were sent', () => {
  const base64 = payload.toString('base64');
  for (const value of [
    '',
    ' ',
    `${base64}\n`,
    ` ${base64}`,
    `${base64}===`,
    'not base64!!',
    3,
    null,
    undefined,
  ])
    refuses({ name: 'sample.json', base64: value }, 400, options.invalid);
  expect(() =>
    readImportEnvelope(inline(Buffer.from('x')), { ...options, minBytes: 2 })
  ).toThrowError(expect.objectContaining({ statusCode: 400, message: options.invalid }));
});

test('an oversized body answers with the caller limit code, whether or not it decodes', () => {
  // 65 bytes still encode within the pre-check length; 67 bytes do not.
  for (const size of [options.maxBytes + 1, options.maxBytes + 3])
    refuses(inline(Buffer.alloc(size, 0x61)), 413, options.tooLarge);
  expect(
    readImportEnvelope(inline(Buffer.alloc(options.maxBytes, 0x61)), options).bytes
  ).toHaveLength(options.maxBytes);
});

test('each reader keeps its own too-large and invalid-file codes', () => {
  const oversized = Buffer.alloc(RISU_IMPORT_MAX_BYTES + 3, 0x61).toString('base64');
  const tooLarge = (call: () => unknown, message: string) =>
    expect(call).toThrowError(expect.objectContaining({ statusCode: 413, message }));
  tooLarge(
    () => readCharacterCard({ name: 'card.json', base64: oversized }),
    'RISU_IMPORT_TOO_LARGE'
  );
  tooLarge(
    () => readRisuPresetFile({ name: 'preset.json', base64: oversized }),
    'RISU_IMPORT_TOO_LARGE'
  );
  tooLarge(
    () =>
      readRisuPlugin({
        name: 'plugin.js',
        base64: Buffer.alloc(RISU_PLUGIN_MAX_BYTES + 3, 0x61).toString('base64'),
      }),
    'RISU_PLUGIN_TOO_LARGE'
  );
});

test('the card reader now refuses the path-like file names the preset reader already refused', () => {
  const card = Buffer.from(JSON.stringify({ name: 'Sample', description: '' })).toString('base64');
  for (const name of [
    '../card.json',
    'folder/card.json',
    'C:\\card.json',
    ' card.json',
    'card\u0000.json',
  ])
    expect(() => readCharacterCard({ name, base64: card })).toThrowError(
      expect.objectContaining({ statusCode: 400, message: 'RISU_IMPORT_INVALID_FILE' })
    );
  // The card's format still comes from its bytes, so any other extension stays readable.
  expect(readCharacterCard({ name: 'card.txt', base64: card }).card.name).toBe('Sample');
});

test('the staged form is read only when the caller offers a staged reader', () => {
  const stored = Buffer.from('staged bytes');
  const reads: string[] = [];
  const staged = {
    ...options,
    staged: (id: string) => {
      reads.push(id);
      return stored;
    },
  };
  expect(readImportEnvelope({ name: 'sample.json', uploadId }, staged)).toEqual({
    name: 'sample.json',
    bytes: stored,
    sha256: createHash('sha256').update(stored).digest('hex'),
    staged: true,
    source: { name: 'sample.json', uploadId },
  });
  expect(reads).toEqual([uploadId]);
  // The inline form still works, and it never touches the staged file.
  expect(readImportEnvelope(inline(), staged)).toMatchObject({ staged: false, bytes: payload });
  expect(reads).toEqual([uploadId]);
  // A staged file obeys the upload route's limit, not the inline one, but still holds a format.
  const large = Buffer.alloc(options.maxBytes + 1, 0x61);
  expect(
    readImportEnvelope({ name: 'sample.json', uploadId }, { ...staged, staged: () => large }).bytes
  ).toHaveLength(options.maxBytes + 1);
  expect(() =>
    readImportEnvelope({ name: 'sample.json', uploadId }, { ...staged, minBytes: 99 })
  ).toThrowError(expect.objectContaining({ statusCode: 400, message: options.invalid }));
  for (const value of [3, '', ' ', 'a'.repeat(101)])
    expect(() => readImportEnvelope({ name: 'sample.json', uploadId: value }, staged)).toThrowError(
      expect.objectContaining({ statusCode: 400, message: 'Invalid upload ID' })
    );
  expect(() =>
    readImportEnvelope({ name: 'sample.json', uploadId, base64: '' }, staged)
  ).toThrowError(expect.objectContaining({ statusCode: 400, message: 'Unknown request field' }));
  // Without a reader the staged form is not part of the field set at all.
  refuses({ name: 'sample.json', uploadId }, 400, 'Unknown request field');
});
