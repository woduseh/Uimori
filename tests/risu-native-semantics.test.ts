import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defaultProfile } from '../core/product.js';
import { NATIVE_HOST_CONTEXT_ID } from '../core/provider-messages.js';
import type { RisuContent } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import { effectiveRisuControls, nativeToggleVariables } from '../core/risu-effective-controls.js';
import {
  nativeRisuPresetControls,
  nativeRisuPresetFields,
  nativeRisuToggleItems,
} from '../core/risu-native-preset.js';
import {
  compileRisuPrompt,
  resolveControlValues,
  validateControlDefinitions,
  validateRisuPrompt,
} from '../core/risu-prompt.js';

test('frozen option definitions preserve native input metadata for transfer and backup', () => {
  const controls = nativeRisuToggleItems(
    'short=Short=text\nlong=Long=textarea\non=Enabled'
  ).flatMap((item) => (item.type === 'control' ? [item.control] : []));
  expect(validateControlDefinitions(controls)).toEqual(controls);
  for (const input of ['switch', 'unexpected'])
    expect(() => validateControlDefinitions([{ ...controls[0], input }])).toThrow();
  expect(() => validateControlDefinitions([{ ...controls[2], input: 'textarea' }])).toThrow();
});
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
import { prepareNativeRisuRun, validateNativeRisuExecution } from '../server/risu-native-run.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import {
  prepareNativeRisuPreset,
  projectNativeRisuPresetProgram,
} from '../server/risu-native-preset.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';

afterEach(disposeAllNativeRisuSessions);

function fixture(
  blocks: Record<string, unknown>[],
  card: Record<string, unknown> = {},
  preset: Record<string, unknown> = {}
) {
  // Historical stored presets remain readable, but retired fields cannot execute.
  const program = validateRisuPrompt({
    version: 1,
    nativeRisuPreset: { version: 1, preset: { promptTemplate: blocks, ...preset } },
  });
  const pkg: RisuContent = {
    version: 1,
    id: 'bot',
    revision: 1,
    title: 'Bot',
    description: '',
    body: 'Description',
    lore: [],
    instructions: [],
    nativeRisu: {
      version: 1,
      sourceHash: 'a'.repeat(64),
      assets: [],
      card: { name: 'Bot', description: 'Description', ...card },
    },
  };
  const snapshot = {
    chatId: randomUUID(),
    parentRevision: null,
    settingsRevision: 1,
    settings: {},
    request: 'Current',
    history: [],
    logicalHistory: [],
    resources: [],
    profile: {
      ...defaultProfile('test'),
      contents: [],
      models: {},
      packages: [pkg],
      packageAttachments: [{ id: pkg.id, revision: 1, role: 'bot' }],
      promptPresets: {
        main: { id: 'preset', revision: 1, title: 'Preset', role: 'main', program, values: {} },
      },
    },
  } as unknown as RunSnapshot;
  return snapshot;
}
const chat = { type: 'chat', rangeStart: 0, rangeEnd: 'end' };
const plain = (text: string) => ({ type: 'plain', role: 'system', text });

test.each([
  {},
  { jailbreakToggle: false, chainOfThought: false },
  { jailbreakToggle: true, chainOfThought: true },
])('disabled blocks and unused field forms cannot mutate native variables (%j)', async (flags) => {
  const input = fixture(
    [
      { type: 'jailbreak', text: '{{setvar::x::bad}}' },
      { type: 'cot', text: '{{setvar::x::bad}}' },
      { type: 'memory', innerFormat: '{{setvar::x::bad}}' },
      { type: 'persona', innerFormat: '{{setvar::x::bad}}' },
      {
        ...plain('{{setvar::x::good}}'),
        innerFormat: '{{setvar::x::bad}}',
        defaultText: '{{setvar::x::bad}}',
      },
      plain('{{getvar::x}}'),
      chat,
    ],
    {},
    flags
  );
  const prepared = await prepareNativeRisuPreset(input);
  expect(prepared.nativeRisuPresetProgram?.variables.x).toBe('good');
  expect(Object.keys(prepared.nativeRisuPresetProgram!.fields)).toEqual([
    'block:4:text',
    'block:5:text',
  ]);
  expect(await prepareNativeRisuPreset(prepared)).toBe(prepared);
});

test('only native formatted slots evaluate wrappers and hidden ChatML thoughts do not run CBS', async () => {
  const input = fixture([
    {
      type: 'chatML',
      text: '<|im_start|>system<|im_sep|><Thoughts>{{setvar::x::bad}}</Thoughts>Content {{? 1+1}}<|im_end|>',
    },
    { type: 'lorebook', role2: 'assistant', innerFormat: '{{setvar::x::bad}}' },
    { type: 'postEverything', role2: 'user', innerFormat: '{{setvar::x::bad}}' },
    plain('{{getvar::x}}'),
    chat,
  ]);
  const prepared = await prepareNativeRisuPreset(input);
  expect(prepared.nativeRisuPresetProgram!.variables).not.toHaveProperty('x');
  const program = projectNativeRisuPresetProgram(
    prepared,
    prepared.profile!.promptPresets!.main!.program
  );
  const result = compileRisuPrompt(program, {
    slots: { lorebook: 'Lore', postEverything: 'Post' },
    history: [],
  });
  expect(result.messages.map((message) => [message.role, message.content[0].text])).toEqual([
    ['system', 'Content 2'],
    ['system', 'Lore'],
    ['system', 'Post'],
    ['system', 'null'],
  ]);
});

test('retired post-end and prefill fields never evaluate CBS or append messages', async () => {
  const input = fixture(
    [plain('{{setvar::x::first}}'), { type: 'postEverything' }, plain('{{getvar::x}}'), chat],
    {},
    {
      promptSettings: {
        postEndInnerFormat: '{{setvar::x::post}}End',
        assistantPrefill: '{{setvar::x::prefill}}Prefix',
      },
    }
  );
  const prepared = await prepareNativeRisuPreset(input);
  const program = projectNativeRisuPresetProgram(
    prepared,
    prepared.profile!.promptPresets!.main!.program
  );
  const result = compileRisuPrompt(program, {
    slots: { postEverything: '' },
    history: [{ id: 'current', role: 'user', text: 'Current', current: true }],
  });
  expect(prepared.nativeRisuPresetProgram!.variables.x).toBe('first');
  expect(Object.keys(prepared.nativeRisuPresetProgram!.fields)).toEqual([
    'block:0:text',
    'block:2:text',
  ]);
  expect(result.messages.map((message) => message.content[0].text)).toEqual(['first', 'Current']);
  expect(result.messages.every((message) => message.completion === 'complete')).toBe(true);
});

test('jbtoggled remains false without diagnostics even for an enabled historical preset', async () => {
  const prepared = await prepareNativeRisuPreset(
    fixture([plain('{{jbtoggled}}'), chat], {}, { jailbreakToggle: true })
  );
  expect(prepared.nativeRisuPresetProgram!.fields['block:0:text']).toBe('0');
  expect(prepared.nativeRisuPresetProgram!.issues).toEqual([]);
});

test('card global note replaces its native block with original insertion before CBS', async () => {
  const input = fixture(
    [{ ...plain('Original {{setvar::x::1}}'), type2: 'globalNote' }, plain('{{getvar::x}}'), chat],
    { post_history_instructions: 'Before {{original}} After {{getvar::x}}' }
  );
  const prepared = await prepareNativeRisuPreset(input);
  expect(prepared.nativeRisuPresetProgram!.fields['block:0:text']).toBe('Before Original  After 1');
  expect(prepared.nativeRisuPresetProgram!.fields['block:1:text']).toBe('1');
  expect(
    input.profile!.promptPresets!.main!.program.nativeRisuPreset.preset.promptTemplate
  ).toEqual([
    { ...plain('Original {{setvar::x::1}}'), type2: 'globalNote' },
    plain('{{getvar::x}}'),
    chat,
  ]);
});

test('example dialogue uses separate message roles at the beginning of native chat ranges', async () => {
  const input = fixture([{ type: 'description' }, chat], {
    mes_example:
      'Ignored {{setvar::should_not_run::yes}}\n<START>\n{{user}}: Ask: with colon\n{{char}}: Reply {{? 1+1}}\nSecond line',
  });
  const result = compileSnapshotPrompt(await prepareNativeRisuRun(input));
  const messages = result.promptCompilation!.messages.filter(
    (message) => message.id !== NATIVE_HOST_CONTEXT_ID
  );
  expect(messages.map((message) => [message.role, message.content[0].text])).toEqual([
    [
      'system',
      '<uimori_source source_role="bot" source_name="Bot" content_id="bot">\nDescription\n</uimori_source>',
    ],
    ['system', '[Start a new chat]'],
    ['user', 'Ask: with colon'],
    ['assistant', 'Reply 2\nSecond line'],
    ['user', 'Current'],
  ]);
  expect(result.nativeRisuExecution!.history).toEqual([]);
  expect(result.nativeRisuExecution!.variables).not.toHaveProperty('should_not_run');
  expect(() => validateNativeRisuExecution(result)).not.toThrow();
});

test('native ChatML and history preserve roles and text despite retired settings', () => {
  const input = fixture(
    [
      {
        type: 'chatML',
        text: '<|im_start|>system<|im_sep|>Policy<|im_end|>\n<|im_start|>user\nExample<|im_end|>',
      },
      { type: 'postEverything' },
      chat,
    ],
    {},
    { promptSettings: { postEndInnerFormat: 'End', sendName: true, sendChatAsSystem: true } }
  );
  const result = compileRisuPrompt(input.profile!.promptPresets!.main!.program, {
    slots: { postEverything: '' },
    names: { char: 'Bot', user: 'Reader' },
    examples: [{ role: 'assistant', text: 'Example reply' }],
    history: [
      { id: 'first', role: 'assistant', sourceKind: 'authored-start', text: 'Hi' },
      { id: 'request', role: 'user', text: 'Go', current: true },
    ],
  });
  expect(result.messages.map((message) => [message.role, message.content[0].text])).toEqual([
    ['system', 'Policy'],
    ['user', 'Example'],
    ['assistant', 'Example reply'],
    ['assistant', 'Hi'],
    ['user', 'Go'],
  ]);
});

test.each(['risu-native-prompt-1', 'risu-native-prompt-2'] as const)(
  '%s suppresses retired blocks and settings in historical presets',
  (compilerVersion) => {
    const input = fixture(
      [
        { type: 'jailbreak', text: 'Old default enabled' },
        { type: 'cot', text: 'Old thought' },
        { ...plain('{{slot}}'), type2: 'globalNote' },
        { type: 'postEverything' },
        chat,
      ],
      {},
      {
        jailbreakToggle: true,
        chainOfThought: true,
        promptSettings: {
          postEndInnerFormat: '<{{slot}}>',
          assistantPrefill: 'Old prefix',
          sendName: true,
          sendChatAsSystem: true,
        },
      }
    );
    const result = compileRisuPrompt(input.profile!.promptPresets!.main!.program, {
      compilerVersion,
      slots: { globalNote: 'Saved note', postEverything: 'Saved post' },
      names: { char: 'Bot', user: 'Reader' },
      history: [{ id: 'request', role: 'user', text: 'Go', current: true }],
    });
    expect(result.compilerVersion).toBe(compilerVersion);
    expect(result.messages.map((message) => message.content[0].text)).toEqual([
      compilerVersion === 'risu-native-prompt-1' ? 'Saved note' : '{{slot}}',
      'Saved post',
      'Go',
    ]);
    expect(result.messages.at(-1)?.role).toBe('user');
    expect(result.messages.every((message) => message.completion === 'complete')).toBe(true);
    expect(result.warnings).toEqual([]);
  }
);

test('a preset receipt binds authored evaluation inputs without binding remappable host catalog IDs', async () => {
  const input = fixture([{ ...plain('Original'), type2: 'globalNote' }, chat], {
    post_history_instructions: 'Card note',
  });
  const prepared = await prepareNativeRisuPreset(input);
  const remapped = structuredClone(prepared);
  remapped.resources = [
    {
      id: 'fork-resource',
      revision: 1,
      chatId: remapped.chatId,
      kind: 'lore',
      title: 'Other catalog',
      description: '',
      text: 'Read later',
      sourceKind: 'module',
      loading: 'discoverable',
    },
  ];
  expect(() =>
    projectNativeRisuPresetProgram(remapped, remapped.profile!.promptPresets!.main!.program)
  ).not.toThrow();
  remapped.profile!.packages![0].nativeRisu.card.post_history_instructions =
    'Changed after evaluation';
  expect(() =>
    projectNativeRisuPresetProgram(remapped, remapped.profile!.promptPresets!.main!.program)
  ).toThrow('RISU_NATIVE_PRESET_RECEIPT_MISMATCH');
});

test('effective toggles combine canonical sources without changing them and preserve native Unicode keys', () => {
  const input = fixture(
    [chat],
    { extensions: { risuai: { toggles: '카드.옵션=Card=text\n__proto__=Reserved=text' } } },
    { customPromptTemplateToggle: 'mode=Mode=select=A,B' }
  );
  const module = structuredClone(input.profile!.packages![0]);
  module.id = 'module';
  module.nativeRisu.card = {};
  module.nativeRisu.module = { customModuleToggle: 'module=Module=text' };
  input.profile!.packages!.push(module);
  input.profile!.packageAttachments!.push({ id: 'module', revision: 1, role: 'module' });
  const before = JSON.stringify(input.profile);
  const controls = effectiveRisuControls(
    input.profile!,
    input.profile!.promptPresets!.main!.program
  );
  expect(controls.map((item) => item.id)).toEqual([
    'mode',
    'module',
    '카드.옵션',
    'risu-toggle:__proto__',
  ]);
  const variables = nativeToggleVariables(
    controls,
    resolveControlValues(controls, { '카드.옵션': '값', 'risu-toggle:__proto__': 'safe' })
  );
  expect(variables).toMatchObject({
    'toggle_카드.옵션': '값',
    toggle___proto__: 'safe',
    toggle_mode: 'null',
  });
  expect(JSON.stringify(input.profile)).toBe(before);
  expect(
    nativeRisuPresetControls({
      version: 1,
      preset: { customPromptTemplateToggle: 'risu-toggle:__proto__=Other=text' },
    })[0].id
  ).not.toBe('risu-toggle:__proto__');
});

test('native toggles expose their editor input without changing stored control values', () => {
  const controls = nativeRisuPresetControls({
    version: 1,
    preset: {
      customPromptTemplateToggle:
        'line=Line=text\nnotes=Notes=textarea\nenabled=Enabled=check\nmode=Mode=select=A,B',
    },
  });
  expect(controls.map(({ id, type, input, options }) => ({ id, type, input, options }))).toEqual([
    { id: 'line', type: 'text', input: 'text', options: undefined },
    { id: 'notes', type: 'text', input: 'textarea', options: undefined },
    {
      id: 'enabled',
      type: 'select',
      input: 'switch',
      options: [
        { label: '미설정', value: null },
        { label: '끔', value: '0' },
        { label: '켬', value: '1' },
      ],
    },
    {
      id: 'mode',
      type: 'select',
      input: undefined,
      options: [
        { label: '미설정', value: null },
        { label: 'A', value: '0' },
        { label: 'B', value: '1' },
      ],
    },
  ]);
});

test('native captions and dividers retain authored order without becoming control values', () => {
  const declaration = [
    '=Before group=caption',
    '=Settings=group',
    '=Group introduction=caption',
    'mode=Mode=select=A,B',
    '=Mode explanation=caption',
    '=More options=divider',
    '=Another explanation=caption',
    '==groupEnd',
    '=After group=caption',
    '=Notes only=group',
    '=No controls required=caption',
    '==groupEnd',
  ].join('\r\n');
  const items = nativeRisuToggleItems(declaration);
  expect(
    items.map((item) =>
      item.type === 'control'
        ? [item.type, item.control.label, item.control.group]
        : [item.type, item.label, item.group]
    )
  ).toEqual([
    ['caption', 'Before group', undefined],
    ['caption', 'Group introduction', 'Settings'],
    ['control', 'Mode', 'Settings'],
    ['caption', 'Mode explanation', 'Settings'],
    ['divider', 'More options', 'Settings'],
    ['caption', 'Another explanation', 'Settings'],
    ['caption', 'After group', undefined],
    ['caption', 'No controls required', 'Notes only'],
  ]);
  const controls = nativeRisuPresetControls({
    version: 1,
    preset: { customPromptTemplateToggle: declaration },
  });
  expect(controls.map((control) => control.id)).toEqual(['mode']);
  expect(nativeToggleVariables(controls, resolveControlValues(controls, { mode: '1' }))).toEqual({
    toggle_mode: '1',
  });
});

test('import review distinguishes unsupported native blocks and host-specific switches', () => {
  const imported = importRisuPresetProgram({
    promptTemplate: [{ type: 'unknown' }, { type: 'memory' }],
    promptSettings: { utilOverride: true },
  });
  expect(imported.findings.filter((item) => item.level === 'unsupported')).toHaveLength(2);
  expect(imported.findings.some((item) => item.code === 'RISU_PRESET_HOST_MEMORY')).toBe(true);
  expect(nativeRisuPresetFields(imported.program.nativeRisuPreset)).toEqual({});
});
