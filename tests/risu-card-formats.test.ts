import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { cardZip, readCharacterCardPath } from '../server/character-card-file.js';
import { encodeRPack } from '../server/compat/risu/rpack.js';
import { readCardModule } from '../server/risu-card-module.js';
import { moduleJsonDocument } from '../server/risu-module-json.js';

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
function zipCard(bytes: Buffer) {
  const name = Buffer.from('card.json'),
    compressed = deflateRawSync(bytes),
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
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
  const archive = zipCard(Buffer.from(JSON.stringify(card()))),
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
  expect(result.members.get('__png_asset__/7.bin')!()).toEqual(binary);
  expect(result.members.get('__png_cover__.png')!()).toEqual(
    Buffer.concat([signature, ordinary, end])
  );
  expect((result.card.assets as Record<string, unknown>[]).map((asset) => asset.uri)).toEqual([
    'embeded://__png_cover__.png',
    'embeded://__png_asset__/7.bin',
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

test('binary modules index asset payloads without decoding them during metadata preparation', () => {
  const asset = Buffer.alloc(100_003, 37);
  const main = Buffer.from(
    JSON.stringify({
      type: 'risuModule',
      module: { name: 'Module', assets: [['image', 'local-image']] },
    })
  );
  const payload = (value: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(value.length);
    return Buffer.concat([size, encodeRPack(value)]);
  };
  const bytes = Buffer.concat([
    Buffer.from([111, 0]),
    payload(main),
    Buffer.from([1]),
    payload(asset),
    Buffer.from([0]),
  ]);
  const sizes: number[] = [];
  const result = readCardModule(bytes.length, (offset, length) => {
    sizes.push(length);
    return bytes.subarray(offset, offset + length);
  });
  expect(Math.max(...sizes)).toBe(main.length);
  expect(result.module.name).toBe('Module');
  const members = new Map<string, () => Buffer>();
  moduleJsonDocument({ type: 'risuModule', module: result.module }, members, result.assets);
  expect(Math.max(...sizes)).toBe(main.length);
  expect(members.get('module-assets/0')!()).toEqual(asset);
  expect(sizes.at(-1)).toBe(asset.length);
});

test('ZIP accepts 32768 entries and rejects the next entry independently of the asset count', () => {
  const archive = (count: number) => {
    const locals: Buffer[] = [],
      central: Buffer[] = [];
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const name = Buffer.from(index === 0 ? 'card.json' : `metadata/${index}`);
      const bytes = index === 0 ? Buffer.from(JSON.stringify(card())) : Buffer.alloc(0);
      const local = Buffer.alloc(30),
        entry = Buffer.alloc(46);
      local.writeUInt32LE(0x04034b50);
      local.writeUInt32LE(crc32(bytes), 14);
      local.writeUInt32LE(bytes.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(name.length, 26);
      entry.writeUInt32LE(0x02014b50);
      entry.writeUInt32LE(crc32(bytes), 16);
      entry.writeUInt32LE(bytes.length, 20);
      entry.writeUInt32LE(bytes.length, 24);
      entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE(offset, 42);
      locals.push(local, name, bytes);
      central.push(entry, name);
      offset += local.length + name.length + bytes.length;
    }
    const directory = Buffer.concat(central),
      end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
  };
  const accepted = cardZip(archive(32768));
  expect(accepted.size).toBe(32768);
  expect(JSON.parse(accepted.get('card.json')!().toString()).data.name).toBe('Format fixture');
  expect(() => cardZip(archive(32769))).toThrow('RISU_IMPORT_INVALID_FILE');
});
