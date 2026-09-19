import { expect, test } from 'vitest';
import { compilePromptProgram, validatePromptProgram } from '../core/prompt-program.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
import {
  nativeRisuPresetPending,
  prepareNativeRisuPreset,
  projectNativeRisuPresetProgram,
} from '../server/risu-native-preset.js';
import { processNativeRisuText } from '../server/risu-native-render.js';

const preset = (text: string, extra: Record<string, unknown> = {}) => ({
  name: 'Synthetic native preset',
  customPromptTemplateToggle: 'mode=Mode=select=First,Second\ncustom=Custom=text',
  promptTemplate: [
    { type: 'plain', role: 'system', text },
    { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  ],
  ...extra,
});
function snapshot(source: unknown, values: Record<string, string | null> = {}): RunSnapshot {
  const imported = importRisuPresetProgram(source);
  return {
    chatId: 'test',
    parentRevision: null,
    settingsRevision: 1,
    settings: {},
    request: 'CURRENT',
    history: [],
    resources: [],
    logicalHistory: [{ id: 'current', role: 'user', text: 'CURRENT', current: true }],
    profile: {
      ...defaultProfile('test'),
      contents: [],
      models: {},
      promptPresets: {
        main: {
          id: 'preset',
          revision: 1,
          title: 'Synthetic',
          role: 'main',
          program: imported.program,
        },
      },
      promptControls: { 'preset@1': { values, combinations: [] } },
    },
  } as unknown as RunSnapshot;
}
async function render(source: unknown, values: Record<string, string | null> = {}) {
  const prepared = await prepareNativeRisuPreset(snapshot(source, values));
  const program = projectNativeRisuPresetProgram(
    prepared,
    prepared.profile!.promptPresets!.main!.program
  );
  const compiled = compilePromptProgram(program, {
    values,
    slots: {
      slot: '',
      description: 'BOT',
      persona: 'USER',
      lorebook: 'LORE',
      authorNote: '',
      globalNote: '',
      postEverything: '',
    },
    history: [{ id: 'current', role: 'user', text: 'CURRENT', current: true }],
  });
  return {
    prepared,
    program,
    compiled,
    text: compiled.messages
      .filter((message) => message.provenance.origin === 'prompt')
      .map((message) => message.content[0]!.text)
      .join('\n'),
  };
}
test('native preset stores original CBS and excludes model configuration, keys and generation options', () => {
  const input = preset('{{#each ["a","b"] as item}}{{slot::item}}{{/each}}', {
    aiModel: 'foreign',
    openAIKey: 'secret',
    temperature: 2,
    promptSettings: { assistantPrefill: 'Hello', temperature: 4, apiKey: 'secret' },
  });
  const imported = importRisuPresetProgram(input);
  expect(imported.program.nativeRisuPreset?.preset.promptTemplate).toEqual(input.promptTemplate);
  expect(JSON.stringify(imported.program)).not.toMatch(/secret|foreign|temperature/u);
  expect(imported.findings.some((item) => item.level === 'unsupported')).toBe(false);
});
test('native CBS evaluates loops and toggle conditions without changing chat defaults into global toggles', async () => {
  const input = preset(
    '{{#when::mode::tis::0}}zero{{:else}}other{{/when}}|{{#each ["a","b"] as item}}{{slot::item}}{{/each}}',
    { templateDefaultVariables: 'mode=0' }
  );
  expect((await render(input)).text).toBe('other|ab');
  expect((await render(input, { mode: '0' })).text).toBe('zero|ab');
});
test('native fields share variable mutations and replay uses their frozen result', async () => {
  const input = preset('', {
    promptTemplate: [
      { type: 'plain', role: 'system', text: '{{setvar::count::3}}first' },
      { type: 'plain', role: 'system', text: '{{getvar::count}}' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ],
  });
  const result = await render(input);
  expect(result.text).toBe('first\n3');
  expect(result.prepared.nativeRisuPresetProgram?.variables.count).toBe('3');
  expect(nativeRisuPresetPending(result.prepared)).toBe(false);
  expect(await prepareNativeRisuPreset(result.prepared)).toBe(result.prepared);
  const tampered = structuredClone(result.prepared);
  tampered.nativeRisuPresetProgram!.sourceHash = 'bad';
  expect(() =>
    projectNativeRisuPresetProgram(tampered, tampered.profile!.promptPresets!.main!.program)
  ).toThrow('RECEIPT_MISMATCH');
});
test('source edits cannot silently diverge from derived blocks', () => {
  const imported = importRisuPresetProgram(preset('authoritative'));
  imported.program.blocks[0]!.title = 'changed derived projection';
  expect(() => validatePromptProgram(imported.program)).toThrow('PROJECTION_MISMATCH');
});
test('preset CBS sees messages after pre-turn scripts and the current input', async () => {
  const input = snapshot(preset('{{lastmessage}}'));
  input.nativeRisuExecution = {
    version: 1,
    inputHash: 'test',
    beforeVariableRevision: 0,
    variables: {},
    fields: {},
    request: 'CURRENT',
    messages: [{ role: 'user', data: 'AFTER PRE-TURN' }],
    history: [],
    issues: [],
  };
  const result = await prepareNativeRisuPreset(input);
  expect(result.nativeRisuPresetProgram?.fields['block:0:text']).toBe('AFTER PRE-TURN');
});
test('slot wrappers, fallback author note, role overrides and prefill retain ordering', async () => {
  const result = await render(
    preset('', {
      promptTemplate: [
        { type: 'description', role2: 'system', innerFormat: '<box>{{slot}}</box>' },
        { type: 'authornote', role2: 'system', defaultText: 'default note' },
        { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      ],
      promptSettings: { assistantPrefill: '{{? 1+2}}', sendChatAsSystem: true },
    })
  );
  expect(
    result.compiled.messages.map((message) => [message.role, message.content[0]!.text])
  ).toEqual([
    ['system', '<box>BOT</box>'],
    ['system', 'default note'],
    ['system', 'CURRENT'],
    ['assistant', '3'],
  ]);
});
test('native regex keeps captures and evaluates CBS after substitution in every supported stage', async () => {
  const regex = ['editinput', 'editoutput', 'editprocess', 'editdisplay'].map((type) => ({
    type,
    in: 'value (\\d+)',
    out: '{{? $1+1}}',
  }));
  const imported = importRisuPresetProgram(preset('prompt', { regex }));
  expect(imported.program.transforms).toBeUndefined();
  for (const mode of ['editinput', 'editoutput', 'editprocess', 'editdisplay'] as const) {
    const result = await processNativeRisuText({
      native: {
        version: 1,
        card: {},
        assets: [],
        sourceHash: 'a'.repeat(64),
        module: { regex: imported.program.nativeRisuPreset!.preset.regex },
      },
      text: 'value 3',
      context: { variables: {} },
      mode,
    });
    expect(result.text).toBe('4');
  }
});
test('existing nonnative programs stay valid and need no native preparation', async () => {
  const program = validatePromptProgram({
    version: 1,
    controls: [],
    blocks: [{ id: 'history', title: 'history', kind: 'history', from: 0, to: 'end' }],
  });
  const old = snapshot(preset('x'));
  old.profile!.promptPresets!.main!.program = program;
  expect(await prepareNativeRisuPreset(old)).toBe(old);
  expect(nativeRisuPresetPending(old)).toBe(false);
});
