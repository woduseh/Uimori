import { expect, test } from 'vitest';
import {
  compileRisuPrompt,
  validateEditableRisuPrompt,
  validateRisuPrompt,
} from '../core/risu-prompt.js';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
import {
  nativeRisuPresetPending,
  prepareNativeRisuPreset,
  prepareNativeRisuTranslationPrompt,
  projectNativeRisuPresetProgram,
} from '../server/risu-native-preset.js';
import { processNativeRisuText } from '../server/risu-native-render.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativeRisuContext } from '../server/risu-native-context.js';
import { nativePromptSlots } from '../server/native-prompt-slots.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';

const preset = (text: string, extra: Record<string, unknown> = {}) => ({
  name: 'Synthetic native preset',
  customPromptTemplateToggle: 'mode=Mode=select=First,Second\ncustom=Custom=text',
  promptTemplate: [
    { type: 'plain', role: 'system', text },
    { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  ],
  ...extra,
});

test('persona macros in cards and presets use the frozen selected body, also present in the persona slot', async () => {
  const body = 'A navigator carrying a silver compass.';
  const persona = nativeContent(
    { name: 'Navigator', description: body },
    { id: 'persona' },
    'persona'
  );
  const bot = nativeContent(
    { name: 'Guide', description: '{{persona}}|{{userpersona}}' },
    { id: 'bot' }
  );
  const source = snapshot(preset('{{user}}|{{persona}}|{{userpersona}}'));
  source.profile!.packages = structuredClone([bot, persona]);
  source.profile!.packageAttachments = [
    { id: 'bot', revision: 1, role: 'bot' },
    { id: 'persona', revision: 1, role: 'persona' },
  ];
  persona.body = 'Changed library value';
  expect(nativeRisuContext(source)?.persona).toBe(body);
  expect(nativePromptSlots(source).persona).toContain(body);
  const prepared = await prepareNativeRisuRun(source, { preview: true });
  expect(
    Object.values(prepared.nativeRisuExecution!.fields).some(
      (fields) => fields.body === `${body}|${body}`
    )
  ).toBe(true);
  expect(prepared.nativeRisuPresetProgram!.fields['block:0:text']).toBe(
    `Navigator|${body}|${body}`
  );
  prepared.profile!.promptPresets!.translation = {
    ...prepared.profile!.promptPresets!.main!,
    role: 'translation',
  };
  const translated = await prepareNativeRisuTranslationPrompt(prepared);
  const translatedSource =
    translated.profile!.promptPresets!.translation!.program.nativeRisuPreset!.preset;
  expect(JSON.stringify(translatedSource.promptTemplate)).toContain(body);
  expect(JSON.stringify(translatedSource.promptTemplate)).not.toContain('{{persona}}');
  const frozen = structuredClone(prepared.nativeRisuPresetProgram);
  prepared.profile!.packages![1].body = 'Later edited profile';
  expect((await prepareNativeRisuPreset(prepared)).nativeRisuPresetProgram).toEqual(frozen);
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
  const compiled = compileRisuPrompt(program, {
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
  expect(JSON.stringify(imported.program)).not.toMatch(
    /secret|foreign|temperature|assistantPrefill/u
  );
  expect(imported.findings.some((item) => item.level === 'unsupported')).toBe(false);
});

test('retired preset options and blocks disappear silently on import and edit while historical source stays readable', () => {
  const active = preset('ACTIVE', { promptSettings: { utilOverride: false } });
  const input = {
    ...active,
    jailbreakToggle: true,
    chainOfThought: true,
    promptSettings: {
      utilOverride: false,
      sendName: true,
      sendChatAsSystem: true,
      postEndInnerFormat: '{{setvar::retired::POST_END}}',
      assistantPrefill: '{{setvar::retired::PREFILL}}',
    },
    promptTemplate: [
      { type: 'jailbreak', text: '{{setvar::retired::JAILBREAK}}' },
      { ...active.promptTemplate[0], type2: 'jailbreak' },
      { ...active.promptTemplate[1], chatAsOriginalOnSystem: true },
      { type: 'cot', text: '{{setvar::retired::COT}}' },
    ],
  };
  const original = structuredClone(input);
  const clean = importRisuPresetProgram(active);
  expect(importRisuPresetProgram(input)).toEqual(clean);
  const historical = { version: 1, nativeRisuPreset: { version: 1, preset: input } };
  expect(validateRisuPrompt(historical)).toEqual(historical);
  expect(validateEditableRisuPrompt(historical)).toEqual(clean.program);
  expect(input).toEqual(original);
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
test('native source is authoritative and rejects a second authored representation', () => {
  const imported = importRisuPresetProgram(preset('authoritative'));
  expect(() => validateRisuPrompt({ ...imported.program, blocks: [] })).toThrow();
  expect(validateRisuPrompt(imported.program).nativeRisuPreset.preset.promptTemplate).toEqual(
    preset('authoritative').promptTemplate
  );
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
test('slot wrappers and fallback notes keep ordering without retired role overrides or prefill', async () => {
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
    ['user', 'CURRENT'],
  ]);
});
test('native regex keeps captures and evaluates CBS after substitution in every supported stage', async () => {
  const regex = ['editinput', 'editoutput', 'editprocess', 'editdisplay'].map((type) => ({
    type,
    in: 'value (\\d+)',
    out: '{{? $1+1}}',
  }));
  const imported = importRisuPresetProgram(preset('prompt', { regex }));
  expect(imported.program).not.toHaveProperty('transforms');
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
test('nonnative authored programs are rejected', () => {
  expect(() =>
    validateRisuPrompt({
      version: 1,
      controls: [],
      blocks: [{ id: 'history', title: 'history', kind: 'history', from: 0, to: 'end' }],
    })
  ).toThrow();
});
