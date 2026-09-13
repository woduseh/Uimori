import { expect, test } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import {
  preparePromptInputTransforms,
  projectPromptInputTransforms,
  validatePromptInputTransforms,
  applyPromptDisplayTransforms,
} from '../server/prompt-transforms.js';
import { buildPackagePresentation } from '../server/package-presentation.js';
import { createHash } from 'node:crypto';

const variablePackage = () => ({
  version: 1 as const,
  id: 'bot',
  revision: 1,
  title: 'Bot',
  description: '',
  lore: [],
  instructions: [],
  controls: [],
  transforms: [],
  variableDefaults: { values: { shared: 'package', packageOnly: 'package value' } },
});

test('template values remain literal while authored replacement captures retain their meaning', async () => {
  const raw = snapshot(),
    program = raw.profile!.promptPresets!.main!.program;
  program.controls = [{ id: 'label', label: 'Label', type: 'text', default: '$& $1 $$' }];
  program.transforms![0]!.replacementTemplate = [
    { kind: 'text', text: '$&:' },
    { kind: 'value', expression: { control: 'label' } },
  ];
  const prepared = await preparePromptInputTransforms(raw);
  expect(prepared.promptInputTransforms!.entries.at(-1)!.text).toBe('same:$& $1 $$');
});

function snapshot(): RunSnapshot {
  const program = createDefaultPromptProgram('Write.');
  program.transforms = [
    {
      id: 'replace',
      title: 'Replace',
      stage: 'input',
      pattern: '^same$',
      flags: '',
      replacement: '',
      replacementTemplate: [{ kind: 'value', expression: { context: ['message', 'index'] } }],
    },
  ];
  return {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'same',
    history: [],
    resources: [],
    logicalHistory: [
      { id: 'first', role: 'user', text: 'same' },
      { id: 'second', role: 'assistant', text: 'same' },
    ],
    profile: {
      ...defaultProfile('chat'),
      contents: [],
      models: {},
      promptPresets: { main: { id: 'p', revision: 1, title: 'P', role: 'main', program } },
    },
  };
}
test('frozen indices distinguish identical messages in context subsets and survive identity remapping', async () => {
  const original = snapshot(),
    frozen = structuredClone(original);
  const prepared = await preparePromptInputTransforms(original);
  expect(original).toEqual(frozen);
  const result = projectPromptInputTransforms(prepared, [
    prepared.logicalHistory![1]!,
    { id: 'current-input', role: 'user', text: 'same', current: true },
  ]);
  expect(result.history.map((message) => message.text)).toEqual(['1', '2']);
  prepared.chatId = 'fork';
  prepared.logicalHistory![1]!.id = 'remapped';
  expect(() => validatePromptInputTransforms(prepared)).not.toThrow();
  expect(await preparePromptInputTransforms(prepared)).toBe(prepared);
  expect(() => validatePromptInputTransforms({ ...prepared, request: 'different' })).toThrow(
    'PROMPT_INPUT_TRANSFORMS_INVALID'
  );
  const altered = structuredClone(prepared);
  altered.promptInputTransforms!.entries[0]!.text = 'tampered';
  expect(() => validatePromptInputTransforms(altered)).toThrow('PROMPT_INPUT_TRANSFORMS_INVALID');
});
test('historical transform configuration stays byte-identical without variable declarations', async () => {
  const prepared = await preparePromptInputTransforms(snapshot());
  expect(prepared.promptInputTransforms?.configurationHash).toBe(
    '2fe72680fa52cc1274ea8ef63c0d56ab98647ac11ce7c06c7204c97b573f8afd'
  );
});
test('transform receipts freeze shared variables and supplied programs use their own defaults', async () => {
  const raw = snapshot();
  raw.profile!.packageAttachments = [{ id: 'bot', revision: 1, role: 'bot' }];
  raw.profile!.packages = [variablePackage()];
  const program = raw.profile!.promptPresets!.main!.program;
  program.variableDefaults = { shared: 'preset', presetOnly: 'profile preset' };
  program.transforms![0]!.replacementTemplate = [
    {
      kind: 'value',
      expression: { op: 'get', args: [{ context: ['variables'] }, 'presetOnly'] },
    },
    { kind: 'text', text: ':' },
    {
      kind: 'value',
      expression: { op: 'get', args: [{ context: ['variables'] }, 'shared'] },
    },
  ];
  const prepared = await preparePromptInputTransforms(raw);
  const repeated = await preparePromptInputTransforms(structuredClone(raw));
  expect(prepared.promptInputTransforms?.configurationHash).toBe(
    repeated.promptInputTransforms?.configurationHash
  );
  expect(prepared.promptInputTransforms?.entries.at(-1)?.text).toBe('profile preset:package');

  const alternative = structuredClone(program);
  alternative.variableDefaults = { shared: 'alternative', presetOnly: 'alternative preset' };
  const alternativeRaw = snapshot();
  alternativeRaw.profile!.packageAttachments = [{ id: 'bot', revision: 1, role: 'bot' }];
  alternativeRaw.profile!.packages = [variablePackage()];
  const alternativePrepared = await preparePromptInputTransforms(alternativeRaw, alternative);
  expect(alternativePrepared.promptInputTransforms?.entries.at(-1)?.text).toBe(
    'alternative preset:package'
  );
  expect(alternativePrepared.promptInputTransforms?.configurationHash).not.toBe(
    prepared.promptInputTransforms?.configurationHash
  );
  expect(() =>
    projectPromptInputTransforms(
      alternativePrepared,
      [{ id: 'current-input', role: 'user', text: 'same', current: true }],
      alternative
    )
  ).not.toThrow();
});
test('combined variable overflow preserves input when a replacement reads variables', async () => {
  const raw = snapshot();
  raw.profile!.packageAttachments = [{ id: 'bot', revision: 1, role: 'bot' }];
  raw.profile!.packages = [
    {
      ...variablePackage(),
      variableDefaults: {
        values: Object.fromEntries(
          ['package', 'package-b', 'package-c'].map((key) => [key, 'p'.repeat(180_000)])
        ),
      },
    },
  ];
  const program = raw.profile!.promptPresets!.main!.program;
  program.variableDefaults = Object.fromEntries(
    ['preset', 'preset-b', 'preset-c'].map((key) => [key, 'q'.repeat(180_000)])
  );
  program.transforms![0]!.replacementTemplate = [
    {
      kind: 'value',
      expression: { op: 'get', args: [{ context: ['variables'] }, 'package'] },
    },
  ];
  const prepared = await preparePromptInputTransforms(raw);
  expect(prepared.promptInputTransforms?.error).toBe('PROMPT_VARIABLE_DEFAULTS_LIMIT');
  expect(prepared.promptInputTransforms?.entries.at(-1)?.text).toBeUndefined();
  expect(
    projectPromptInputTransforms(prepared, [
      { id: 'current-input', role: 'user', text: 'same', current: true },
    ]).history[0]?.text
  ).toBe('same');

  program.transforms![0]!.replacementTemplate = [{ kind: 'text', text: 'safe' }];
  const variableIndependent = await preparePromptInputTransforms({
    ...raw,
    promptInputTransforms: undefined,
  });
  expect(variableIndependent.promptInputTransforms?.error).toBeUndefined();
  expect(variableIndependent.promptInputTransforms?.entries.at(-1)?.text).toBe('safe');
});
test('timed out regex is a preserved nonblocking fallback and a fresh valid input still works', async () => {
  const raw = snapshot();
  raw.logicalHistory = [];
  raw.request = 'a'.repeat(40_000) + '!';
  Object.assign(raw.profile!.promptPresets!.main!.program.transforms![0]!, {
    pattern: '(a+)+$',
    replacementTemplate: undefined,
  });
  const prepared = await preparePromptInputTransforms(raw);
  expect(prepared.promptInputTransforms?.error).toBe('TEXT_TRANSFORM_TIMEOUT');
  expect(await preparePromptInputTransforms(prepared)).toBe(prepared);
  expect(
    projectPromptInputTransforms(prepared, [
      { id: 'current-input', role: 'user', text: raw.request, current: true },
    ]).history[0]!.text
  ).toBe(raw.request);
  expect(() => validatePromptInputTransforms(prepared)).not.toThrow();
  expect(
    (await preparePromptInputTransforms(snapshot())).promptInputTransforms?.error
  ).toBeUndefined();
});
test('preset-only request and response display preserves source and effective input separately', async () => {
  const raw = snapshot(),
    program = raw.profile!.promptPresets!.main!.program;
  program.transforms!.push({
    id: 'display',
    title: 'Display',
    stage: 'display',
    pattern: 'same',
    flags: 'g',
    replacement: 'shown',
  });
  const prepared = await preparePromptInputTransforms(raw);
  const text = 'same',
    hash = createHash('sha256').update(text).digest('hex');
  const result = await buildPackagePresentation(prepared, {
    id: 'source',
    chatId: 'chat',
    hash,
    text,
  });
  expect(result.original.text).toBe('shown');
  expect(result.request.text).toBe('shown');
  expect(result.inputTransform?.text).toBe('2');
  expect(prepared.request).toBe('same');
  expect(result.sourceHash).toBe(hash);
  expect((await applyPromptDisplayTransforms(prepared, 'same', 'user')).text).toBe('shown');
  program.transforms!.at(-1)!.replacementTemplate = [
    { kind: 'value', expression: { context: ['message', 'current'] } },
  ];
  expect((await applyPromptDisplayTransforms(raw, 'same', 'user')).text).toBe('0');
  expect((await applyPromptDisplayTransforms(raw, 'same', 'assistant')).text).toBe('1');
  raw.logicalHistory = [];
  raw.packageStart = {
    packageId: 'p',
    packageRevision: 1,
    startId: 'opening',
    mode: 'authored',
    title: 'Opening',
    text: 'same',
    values: {},
  };
  program.transforms!.at(-1)!.replacementTemplate = [
    { kind: 'value', expression: { context: ['message', 'index'] } },
    { kind: 'text', text: ':' },
    { kind: 'value', expression: { context: ['message', 'lastIndex'] } },
  ];
  expect((await applyPromptDisplayTransforms(raw, 'same', 'assistant')).text).toBe('0:0');
  expect((await applyPromptDisplayTransforms(raw, 'same', 'user')).text).toBe('same');
});
