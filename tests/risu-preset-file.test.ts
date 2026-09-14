import { createCipheriv, createHash } from 'node:crypto';
import { crc32, deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { pack } from 'msgpackr';
import { expect, test } from 'vitest';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { readRisuPresetFile } from '../server/risu-preset-file.js';
import { decodeRPack } from '../server/compat/risu/rpack.js';

const document = () => ({
  name: 'Synthetic preset',
  promptTemplate: [{ type: 'plain', role: 'system', text: 'Keep the story.' }],
  customPromptTemplateToggle: 'style=Style',
  templateDefaultVariables: 'style=1',
  regex: [{ type: 'editprocess', in: 'old', out: 'new' }],
});
const file = (bytes: Buffer, name = 'preset.json') => ({
  name,
  base64: bytes.toString('base64'),
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

test('raw JSON and the explicit RisuToki document envelope preserve preset fields and source bytes', () => {
  const preset = document();
  for (const value of [preset, { _fileType: 'risup', _presetData: preset }]) {
    const bytes = encode(value);
    const source = file(bytes);
    expect(readRisuPresetFile(source)).toEqual({
      preset,
      source,
      hash: createHash('sha256').update(bytes).digest('hex'),
      format: 'risu-preset-json',
    });
  }
});

test('project ZIP restores all eight manifest text fields inside a containing folder', () => {
  const names = [
    'mainPrompt',
    'jailbreak',
    'globalNote',
    'instructChatTemplate',
    'JinjaTemplate',
    'autoSuggestPrompt',
    'groupTemplate',
    'systemContentReplacement',
  ];
  const preset = { ...document(), ...Object.fromEntries(names.map((name) => [name, ''])) };
  const manifest = Object.fromEntries(names.map((name) => [`${name}.md`, name]));
  const source = file(
    zip([
      ['sample/preset.json', encode(preset)],
      ['sample/manifest.json', encode(manifest)],
      ['sample/.risutoki/workspace.json', encode({ version: 1, sourceFileType: 'risup' })],
      ...names.map((name): [string, Buffer] => [
        `sample/${name}.md`,
        Buffer.from(`\n${name} 한글\n`),
      ]),
    ]),
    'project.zip'
  );
  const result = readRisuPresetFile(source);
  expect(result.format).toBe('risu-preset-project-zip');
  expect(result.source).toEqual(source);
  expect(result.preset).toEqual({
    ...preset,
    ...Object.fromEntries(names.map((name) => [name, `\n${name} 한글\n`])),
  });
});

test('project ZIP refuses missing references, path escapes, ambiguous projects, and wrong markers', () => {
  const base: [string, Buffer][] = [['preset.json', encode(document())]];
  const cases: [string, Buffer][][] = [
    base,
    [...base, ['manifest.json', encode({ 'mainPrompt.md': 'mainPrompt' })]],
    [...base, ['manifest.json', encode({ '../mainPrompt.md': 'mainPrompt' })]],
    [...base, ['manifest.json', encode({ 'C:/mainPrompt.md': 'mainPrompt' })]],
    [...base, ['manifest.json', encode({ 'mainPrompt.md': '__proto__' })]],
    [...base, ['manifest.json', encode({})], ['other/preset.json', encode(document())]],
    [...base, ['manifest.json', encode({})], ['card.json', encode({ name: 'card' })]],
    [
      ...base,
      ['manifest.json', encode({})],
      ['.risutoki/workspace.json', encode({ version: 1, sourceFileType: 'risum' })],
    ],
    [...base, ['manifest.json', encode({})], ['../outside.txt', Buffer.from('outside')]],
  ];
  for (const entries of cases)
    expect(() => readRisuPresetFile(file(zip(entries), 'project.zip'))).toThrow();
});

test('file validation rejects malformed names, base64, UTF-8, JSON shapes and foreign documents', () => {
  const valid = file(encode(document()));
  for (const name of [
    '../preset.json',
    'C:\\preset.json',
    ' preset.json',
    'preset.json\0',
    'preset.txt',
  ])
    expect(() => readRisuPresetFile({ ...valid, name })).toThrow();
  expect(() => readRisuPresetFile({ ...valid, base64: `${valid.base64}\n` })).toThrow();
  for (const value of [
    null,
    [],
    {},
    { name: 3 },
    { name: 'card', spec: 'chara_card_v3' },
    { name: 'module', type: 'risuModule' },
    { preset: document() },
    { _fileType: 'risum', _presetData: document() },
    { name: 'bad', promptTemplate: [null] },
    { name: 'bad', regex: {} },
  ])
    expect(() => readRisuPresetFile(file(encode(value)))).toThrow('RISU_PRESET_INVALID_FILE');
  const malformed = Buffer.concat([
    Buffer.from('{"name":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  expect(() => readRisuPresetFile(file(malformed))).toThrow('RISU_PRESET_INVALID_FILE');
  expect(() =>
    readRisuPresetFile(file(Buffer.from('\ufeff' + JSON.stringify(document()))))
  ).not.toThrow();
});

function binaryFixture(payload: Buffer, version = 2, field = 'preset') {
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update('risupreset').digest(),
    Buffer.alloc(12)
  );
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return pack({ type: 'preset', presetVersion: version, [field]: encrypted });
}

function encodeRPackFixture(bytes: Buffer) {
  const inverse = Buffer.alloc(256);
  for (const [encoded, plain] of decodeRPack(
    Buffer.from(Array.from({ length: 256 }, (_, index) => index))
  ).entries())
    inverse[plain] = encoded;
  return Buffer.from(bytes.map((value) => inverse[value]));
}

test('binary preset versions and compression formats decode through the RPack and AES container', () => {
  expect(decodeRPack(Buffer.from([196, 13, 30, 11]))).toEqual(Buffer.from([0, 1, 2, 3]));
  for (const compress of [gzipSync, deflateSync, deflateRawSync]) {
    for (const version of [0, 2]) {
      const compressed = compress(
        binaryFixture(pack(document()), version, version === 0 ? 'pres' : 'preset')
      );
      for (const [name, bytes] of [
        ['sample.risup', encodeRPackFixture(compressed)],
        ['sample.risupreset', compressed],
      ] as const) {
        const source = file(bytes, name);
        expect(readRisuPresetFile(source)).toEqual({
          preset: document(),
          source,
          format: 'risu-preset-binary',
          hash: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
});

test('binary decoding refuses unsupported versions, damaged authentication, oversized lengths and extensions', () => {
  const read = (bytes: Buffer) => readRisuPresetFile(file(gzipSync(bytes), 'sample.risupreset'));
  expect(() => read(binaryFixture(pack(document()), 3))).toThrow('RISU_PRESET_VERSION_UNSUPPORTED');
  const damaged = binaryFixture(pack(document()));
  damaged[damaged.length - 1] ^= 1;
  expect(() => read(damaged)).toThrow('RISU_PRESET_INVALID_FILE');
  expect(() => read(pack({ type: 'preset', presetVersion: 2, preset: 'not bytes' }))).toThrow(
    'RISU_PRESET_INVALID_FILE'
  );
  for (const payload of [
    Buffer.from([0xdd, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0xdf, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0xd4, 0x72, 0]),
    Buffer.concat([Buffer.alloc(130, 0x91), Buffer.from([0xc0])]),
  ]) {
    expect(() => read(payload)).toThrow('RISU_PRESET_INVALID_FILE');
    expect(() => read(binaryFixture(payload))).toThrow('RISU_PRESET_INVALID_FILE');
  }
  expect(() =>
    read(binaryFixture(pack({ ...document(), custom: Number.POSITIVE_INFINITY })))
  ).toThrow('RISU_PRESET_INVALID_FILE');
  expect(() => read(Buffer.alloc(RISU_IMPORT_MAX_BYTES + 1, 0x61))).toThrow(
    'RISU_IMPORT_TOO_LARGE'
  );
});

test('input and expanded project text obey the existing import byte limit', () => {
  expect(() => readRisuPresetFile(file(Buffer.alloc(RISU_IMPORT_MAX_BYTES + 1)))).toThrow(
    'RISU_IMPORT_TOO_LARGE'
  );
  const source = file(
    zip([
      ['preset.json', encode(document())],
      ['manifest.json', encode({ 'mainPrompt.md': 'mainPrompt' })],
      ['mainPrompt.md', Buffer.alloc(RISU_IMPORT_MAX_BYTES + 1, 0x61)],
    ]),
    'project.zip'
  );
  expect(() => readRisuPresetFile(source)).toThrow('RISU_IMPORT_TOO_LARGE');
});

// Reuses the standard ZIP fixture construction from risu-import.test.ts.
function zip(files: [string, Buffer][]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const path = Buffer.from(name),
      compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, path, compressed);
    central.push(directory, path);
    offset += header.length + path.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
