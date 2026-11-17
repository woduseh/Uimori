import { createCipheriv, createHash } from 'node:crypto';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { pack } from 'msgpackr';
import { expect, test } from 'vitest';
import { RISU_IMPORT_MAX_BYTES } from '../core/risu-import.js';
import { readRisuPresetFile } from '../server/risu-preset-file.js';
import { zip } from './fixtures/zip.js';
import { encodeRPack } from '../server/compat/risu/rpack.js';

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
    [...base, ['manifest.json', encode({ 'mainPrompt.md': '__proto__' })]],
    [...base, ['manifest.json', encode({})], ['other/preset.json', encode(document())]],
    [
      ...base,
      ['manifest.json', encode({})],
      ['.risutoki/workspace.json', encode({ version: 1, sourceFileType: 'risum' })],
    ],
  ];
  for (const entries of cases)
    expect(() => readRisuPresetFile(file(zip(entries), 'project.zip'))).toThrow();
});

test('file validation rejects malformed names, base64, UTF-8, JSON shapes and foreign documents', () => {
  const valid = file(encode(document()));
  for (const name of ['../preset.json', 'preset.json\0', 'preset.txt'])
    expect(() => readRisuPresetFile({ ...valid, name })).toThrow();
  expect(() => readRisuPresetFile({ ...valid, base64: `${valid.base64}\n` })).toThrow();
  for (const value of [
    [],
    { name: 'card', spec: 'chara_card_v3' },
    { name: 'module', type: 'risuModule' },
    { _fileType: 'risum', _presetData: document() },
    { name: 'bad', promptTemplate: [null] },
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

test('binary preset versions and compression formats decode through the RPack and AES container', () => {
  for (const compress of [gzipSync, deflateSync, deflateRawSync]) {
    for (const version of [0, 2]) {
      const compressed = compress(
        binaryFixture(pack(document()), version, version === 0 ? 'pres' : 'preset')
      );
      for (const [name, bytes] of [
        ['sample.risup', encodeRPack(compressed)],
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

test('expanded project text obeys the import byte limit', () => {
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
