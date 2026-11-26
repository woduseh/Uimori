import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { zip } from './fixtures/zip.js';
import { afterEach, expect, test } from 'vitest';
import { cardZip, readCharacterCardPath } from '../server/character-card-file.js';

const directories: string[] = [];
function fixture(bytes: Buffer, name: string) {
  const root = mkdtempSync(join(tmpdir(), 'uimori-card-formats-'));
  directories.push(root);
  const path = join(root, name);
  writeFileSync(path, bytes);
  return { path, workspace: join(root, 'prepared') };
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const card = (assets: unknown[] = []) => ({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Format fixture',
    description: 'Preserve {{raw::portrait}} and scripts',
    assets,
    extensions: {
      risuai: { triggerscript: [{ code: 'return "data:image/png;base64,untouched"' }] },
    },
  },
});
function pngChunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8),
    footer = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  header.write(type, 4);
  footer.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, footer]);
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const textChunk = (key: string, value: string) => pngChunk('tEXt', Buffer.from(`${key}\0${value}`));

test('JPEG-prefixed CHARX preserves original identity and reads archive offsets relative to its start', async () => {
  const archive = zip([['card.json', Buffer.from(JSON.stringify(card()))]]),
    bytes = Buffer.concat([Buffer.from([255, 216, 255, 217]), archive]);
  expect(JSON.parse(cardZip(bytes).get('card.json')!().toString()).data.name).toBe(
    'Format fixture'
  );
  const { path, workspace } = fixture(bytes, 'export.jpeg');
  const result = await readCharacterCardPath(path, 'export.jpeg', undefined, workspace);
  expect(result.format).toBe('charx');
  expect(result.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(result.card.name).toBe('Format fixture');
});

test('v3 JSON externalizes chunked binary data URIs while preserving asset roles, order and script text', async () => {
  const binary = Buffer.alloc(200_003, 123),
    input = card([
      {
        name: 'portrait',
        type: 'icon',
        ext: 'png',
        uri: `data:application/octet-stream;base64,${binary.toString('base64')}`,
      },
      { name: 'remote', type: 'background', ext: 'jpg', uri: 'https://example.invalid/image.jpg' },
    ]);
  const { path, workspace } = fixture(Buffer.from(JSON.stringify(input)), 'card.json');
  const result = await readCharacterCardPath(path, 'card.json', undefined, workspace);
  const assets = result.card.assets as Record<string, unknown>[];
  expect(assets[0]).toEqual({
    ...(input.data.assets[0] as object),
    uri: 'embeded://__card_inline__/1.bin',
  });
  expect(result.members.get('__card_inline__/1.bin')!()).toEqual(binary);
  expect(assets[1]).toEqual(input.data.assets[1]);
  expect((result.nativeCard as Record<string, unknown>).extensions).toEqual(input.data.extensions);
  expect(JSON.stringify(result.nativeCard).length).toBeLessThan(1000);
});

test('v3 PNG chooses ccv3, resolves attachments and default cover without transport chunks', async () => {
  const binary = Buffer.from('attachment bytes'),
    input = card([
      { name: 'portrait', type: 'icon', ext: 'png', uri: 'ccdefault:' },
      { name: 'emotion', type: 'emotion', ext: 'webp', uri: '__asset:7' },
    ]);
  const ordinary = pngChunk('tEXt', Buffer.from('Author\0Someone')),
    end = pngChunk('IEND', Buffer.alloc(0));
  const bytes = Buffer.concat([
    signature,
    ordinary,
    textChunk('chara', Buffer.from(JSON.stringify({ spec: 'chara_card_v2' })).toString('base64')),
    textChunk('ccv3', Buffer.from(JSON.stringify(input)).toString('base64')),
    textChunk('chara-ext-asset_:7', binary.toString('base64')),
    end,
  ]);
  const { path, workspace } = fixture(bytes, 'card.png');
  const result = await readCharacterCardPath(path, 'card.png', undefined, workspace);
  expect(result.format).toBe('character-card-png');
  expect(result.members.get('__png_asset__/1.bin')!()).toEqual(binary);
  expect(result.members.get('__png_cover__.png')!()).toEqual(
    Buffer.concat([signature, ordinary, end])
  );
  expect((result.card.assets as Record<string, unknown>[]).map((asset) => asset.uri)).toEqual([
    'embeded://__png_cover__.png',
    'embeded://__png_asset__/1.bin',
  ]);
});

test('v2-only PNG and JSON have an explicit unsupported result', async () => {
  for (const [name, bytes] of [
    [
      'old.json',
      Buffer.from(
        JSON.stringify({ spec: 'chara_card_v2', data: { name: 'Old', description: '' } })
      ),
    ],
    [
      'old.png',
      Buffer.concat([signature, textChunk('chara', 'e30='), pngChunk('IEND', Buffer.alloc(0))]),
    ],
  ] as const) {
    const { path, workspace } = fixture(bytes, name);
    await expect(readCharacterCardPath(path, name, undefined, workspace)).rejects.toThrow(
      'RISU_IMPORT_V3_REQUIRED'
    );
  }
});

test('bad PNG CRC and noncanonical JSON base64 are rejected rather than silently decoding', async () => {
  const png = Buffer.concat([
    signature,
    textChunk('ccv3', Buffer.from(JSON.stringify(card())).toString('base64')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  png[png.length - 1] ^= 1;
  const a = fixture(png, 'bad.png');
  await expect(readCharacterCardPath(a.path, 'bad.png', undefined, a.workspace)).rejects.toThrow(
    'RISU_IMPORT_INVALID_FILE'
  );
  const b = fixture(
    Buffer.from(JSON.stringify(card([{ uri: 'data:application/octet-stream;base64,YR==' }]))),
    'bad.json'
  );
  await expect(readCharacterCardPath(b.path, 'bad.json', undefined, b.workspace)).rejects.toThrow(
    'RISU_IMPORT_INVALID_FILE'
  );
});

test('JSON tokenizer preserves escaped Unicode, primitive arrays and duplicate-key last-wins semantics', async () => {
  const input =
    '{"spec":"chara_card_v3","data":{"name":"old","name":"새 이름 🌙","description":"line\\nquote\\"","extensions":{"mixed":[true,false,null,-1.25e3,"\\uD55C"],"__proto__":{"ok":true}}}}';
  const { path, workspace } = fixture(Buffer.from(input), 'unicode.json');
  const result = await readCharacterCardPath(path, 'unicode.json', undefined, workspace);
  expect(result.nativeCard).toEqual(JSON.parse(input).data);
  expect(
    Object.hasOwn((result.nativeCard as Record<string, unknown>).extensions as object, '__proto__')
  ).toBe(true);
});
