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
});
