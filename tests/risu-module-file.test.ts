import { expect, test } from 'vitest';
import { HttpError } from '../server/request-validation.js';
import { readEmbeddedRisuModule } from '../server/risu-module-file.js';
import { decodeRPack } from '../server/compat/risu/rpack.js';

const encodeMap = Buffer.alloc(256);
for (const [encoded, plain] of decodeRPack(
  Buffer.from(Array.from({ length: 256 }, (_, i) => i))
).entries())
  encodeMap[plain] = encoded;
const encode = (bytes: Buffer) => Buffer.from(bytes.map((value) => encodeMap[value]));
const length = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const container = (main: Buffer, assets: Buffer[] = []) =>
  Buffer.concat([
    Buffer.from([111, 0]),
    length(main.length),
    encode(main),
    ...assets.flatMap((asset) => [Buffer.from([1]), length(asset.length), encode(asset)]),
    Buffer.from([0]),
  ]);
const file = (module: unknown, assets: Buffer[] = []) =>
  container(Buffer.from(JSON.stringify({ type: 'risuModule', module })), assets);
const expectInvalid = (bytes: Buffer) => {
  expect(() => readEmbeddedRisuModule(bytes)).toThrowError(
    expect.objectContaining({ statusCode: 400, message: 'RISU_IMPORT_INVALID_FILE' })
  );
  expect(() => readEmbeddedRisuModule(bytes)).toThrow(HttpError);
};

test('embedded module preserves arbitrary fields and binary asset order without modifying input', () => {
  const module = {
    name: '한글 모듈',
    assets: [
      ['first', '', 'png'],
      ['second', '', 'bin'],
      ['empty', '', 'png'],
    ],
    lorebook: [{ key: '숲', content: '이름 없는 숲' }],
    trigger: [{ script: 'never execute' }],
    customField: { nested: true },
  };
  const assets = [Buffer.from([0, 1, 2, 3, 255]), Buffer.from('second'), Buffer.alloc(0)];
  const bytes = file(module, assets);
  const original = Buffer.from(bytes);
  expect(readEmbeddedRisuModule(bytes)).toEqual({ module, assets });
  expect(bytes).toEqual(original);
});

test('name and description are not container requirements and an empty assets list is valid', () => {
  for (const module of [{}, { assets: [] }, { name: 123, description: null }])
    expect(readEmbeddedRisuModule(file(module))).toEqual({ module, assets: [] });
});

test('every truncated prefix fails with the stable import error', () => {
  const bytes = file({ assets: [['asset', '', 'png']] }, [Buffer.from([1, 2, 3])]);
  for (let end = 0; end < bytes.length; end++) expectInvalid(bytes.subarray(0, end));
});

test('magic, unsupported versions, record markers, lengths, and trailing data fail closed', () => {
  const bytes = file({ assets: [['asset', '', 'png']] }, [Buffer.from([1, 2, 3])]);
  const mainEnd = 6 + bytes.readUInt32LE(2);
  for (const [offset, value] of [
    [0, 0],
    [1, 1],
    [mainEnd, 2],
    [bytes.length - 1, 1],
  ]) {
    const damaged = Buffer.from(bytes);
    damaged[offset] = value;
    expectInvalid(damaged);
  }
  for (const offset of [2, mainEnd + 1]) {
    const damaged = Buffer.from(bytes);
    damaged.writeUInt32LE(0xffffffff, offset);
    expectInvalid(damaged);
  }
  expectInvalid(Buffer.concat([bytes, Buffer.from([0])]));
  expectInvalid(container(Buffer.alloc(0)));
});

test('malformed UTF-8, JSON, envelope and module shapes are rejected', () => {
  for (const main of [
    Buffer.from([0xff]),
    Buffer.concat([
      Buffer.from('{"type":"risuModule","module":{"name":"'),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from('"}}'),
    ]),
    Buffer.from('{'),
    ...[
      null,
      [],
      true,
      {},
      { type: 'foreign', module: {} },
      { type: 'risuModule' },
      { type: 'risuModule', module: null },
      { type: 'risuModule', module: [] },
    ].map((value) => Buffer.from(JSON.stringify(value))),
  ])
    expectInvalid(container(main));
});

test('asset metadata and record counts must match exactly', () => {
  for (const assets of [null, {}, [null], [[]], [['name']], [[1, '']], [['name', 2]]])
    expectInvalid(file({ assets }));
  expectInvalid(file({}, [Buffer.from('orphan')]));
  expectInvalid(file({ assets: [['missing', '', 'png']] }));
  expectInvalid(
    file({ assets: [['first', '', 'png']] }, [Buffer.from('first'), Buffer.from('extra')])
  );
});

test('asset count, JSON bytes and individual asset bytes stay bounded in larger containers', () => {
  const metadata = Array.from({ length: 2000 }, (_, index) => [`asset ${index}`, '', 'png']);
  const assets = Array.from({ length: 2000 }, () => Buffer.alloc(0));
  expect(readEmbeddedRisuModule(file({ assets: metadata }, assets)).assets).toHaveLength(2000);
  expectInvalid(file({ assets: [...metadata, ['excess', '', 'png']] }));
  // Valid JSON padding proves the byte limit itself rejects the file, not invalid JSON.
  const json = Buffer.from(JSON.stringify({ type: 'risuModule', module: {} }));
  const maximumJson = Buffer.alloc(8 * 1024 * 1024, 32);
  json.copy(maximumJson);
  expect(readEmbeddedRisuModule(container(maximumJson))).toEqual({ module: {}, assets: [] });
  expectInvalid(container(Buffer.concat([maximumJson, Buffer.from(' ')])));

  // One valid maximum-sized asset makes the whole container exceed the former 64 MiB cap.
  const prefix = file({ assets: [['large', '', 'bin']] }).subarray(0, -1);
  const assetBytes = 64 * 1024 * 1024;
  const large = Buffer.alloc(prefix.length + 6 + assetBytes, encodeMap[0]);
  prefix.copy(large);
  large[prefix.length] = 1;
  large.writeUInt32LE(assetBytes, prefix.length + 1);
  large[large.length - 1] = 0;
  const decoded = readEmbeddedRisuModule(large);
  expect(decoded.assets).toHaveLength(1);
  expect(decoded.assets[0].length).toBe(assetBytes);
  expect(decoded.assets[0].every((byte) => byte === 0)).toBe(true);

  // A valid extra payload byte crosses the retained per-asset boundary, not the file budget.
  const oversized = Buffer.concat([large.subarray(0, -1), Buffer.from([encodeMap[0], 0])]);
  oversized.writeUInt32LE(assetBytes + 1, prefix.length + 1);
  expectInvalid(oversized);
});

test('the RPack decode table matches the published map and stays a bijection', () => {
  // Fixed vector from rpack_map.bin bytes 256..511 (first four entries and the last four); the
  // helpers above derive the encoder from the decoder, so this is the one assertion that would
  // notice a corrupted table.
  expect([...decodeRPack(Buffer.from([0, 1, 2, 3, 252, 253, 254, 255]))]).toEqual([
    44, 247, 132, 139, 8, 166, 128, 64,
  ]);
  const decoded = decodeRPack(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  expect(new Set(decoded).size).toBe(256);
});
