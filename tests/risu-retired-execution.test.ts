import { afterEach, expect, test } from 'vitest';
import { nativeRisuFieldKey } from '../core/risu-native-execution.js';
import { validateRisuPrompt } from '../core/risu-prompt.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import {
  nativeRisuSnapshotNeedsRefresh,
  prepareNativeRisuReadOnly,
} from '../server/risu-native-readonly.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import {
  bridge,
  bundle,
  hooks,
  selectProvider,
  translationFixtureSlot,
} from './fixtures/translation-job.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function authoredInput() {
  const seed = bundle();
  seed.snapshot = await prepareNativeRisuRun(seed.snapshot, { preview: true });
  const pkg = seed.snapshot.profile!.packages![0];
  pkg.nativeRisu.card.personality = '{{setvar::retired::EXECUTED}}RETIRED_PERSONALITY';
  pkg.nativeRisu.card.scenario = 'RETIRED_SCENARIO';
  pkg.nativeRisu.card.system_prompt = 'RETIRED_SYSTEM';
  pkg.body += '\nRETIRED_PERSONALITY\nRETIRED_SCENARIO';
  const execution = seed.snapshot.nativeRisuExecution!;
  execution.fields[nativeRisuFieldKey(seed.snapshot.profile!.packageAttachments![0])] = {
    body: pkg.body!,
  };
  seed.snapshot.resources.push({
    id: 'package:bot:bot:body',
    chatId: seed.snapshot.chatId,
    revision: 2,
    kind: 'lore',
    title: 'Mira',
    description: '',
    text: pkg.body!,
  });
  return seed;
}

test('a read-only operation sanitizes authored native input without mutating its receipt', async () => {
  const seed = await authoredInput();
  const before = structuredClone(seed.snapshot);
  expect(nativeRisuSnapshotNeedsRefresh(seed.snapshot)).toBe(true);
  const refreshed = await prepareNativeRisuReadOnly(seed.snapshot, 'context');
  expect(refreshed.nativeRisuExecution?.version).toBe(2);
  expect(refreshed.nativeRisuExecution?.variables.retired).toBeUndefined();
  expect(JSON.stringify(refreshed)).not.toMatch(/RETIRED_|EXECUTED/);
  expect(refreshed.profile!.packages![0].body).toBe('Mira has not learned the keeper identity.');
  expect(refreshed.profile!.packages![0]).not.toHaveProperty('instructions');
  expect(nativeRisuSnapshotNeedsRefresh(refreshed)).toBe(false);
  expect(seed.snapshot).toEqual(before);
});

test('current-version historical preset receipts refresh before new work without replaying retired CBS', async () => {
  const seed = bundle();
  const program = validateRisuPrompt({
    version: 1,
    nativeRisuPreset: {
      version: 1,
      preset: {
        promptTemplate: [{ type: 'plain', role: 'system', text: 'ACTIVE' }, { type: 'chat' }],
      },
    },
  });
  seed.snapshot.profile!.promptPresets = {
    main: { id: 'historical-preset', revision: 1, title: 'Preset', role: 'main', program },
  };
  seed.snapshot = await prepareNativeRisuRun(seed.snapshot, { preview: true });
  const native = seed.snapshot.profile!.promptPresets!.main!.program.nativeRisuPreset.preset;
  native.jailbreakToggle = true;
  native.chainOfThought = true;
  native.promptSettings = {
    sendName: true,
    sendChatAsSystem: true,
    postEndInnerFormat: '{{setvar::retired::EXECUTED}}RETIRED_POST_END',
    assistantPrefill: '{{setvar::retired::EXECUTED}}RETIRED_PREFILL',
  };
  (native.promptTemplate as Record<string, unknown>[]).unshift(
    { type: 'jailbreak', text: '{{setvar::retired::EXECUTED}}RETIRED_JAILBREAK' },
    { type: 'cot', text: '{{setvar::retired::EXECUTED}}RETIRED_COT' }
  );
  const oldReceipt = seed.snapshot.nativeRisuPresetProgram!;
  oldReceipt.fields['settings:assistantPrefill'] = 'RETIRED_PREFILL';
  oldReceipt.variables.retired = 'EXECUTED';
  const before = structuredClone(seed.snapshot);
  expect(oldReceipt.version).toBe(2);
  expect(nativeRisuSnapshotNeedsRefresh(seed.snapshot)).toBe(true);
  const refreshed = await prepareNativeRisuReadOnly(seed.snapshot, 'context');
  expect(refreshed.nativeRisuPresetProgram!.fields).toEqual({ 'block:0:text': 'ACTIVE' });
  expect(refreshed.nativeRisuPresetProgram!.variables.retired).toBeUndefined();
  expect(JSON.stringify(refreshed)).not.toMatch(/RETIRED_|EXECUTED/);
  expect(nativeRisuSnapshotNeedsRefresh(refreshed)).toBe(false);
  expect(seed.snapshot).toEqual(before);
});

test('translation excludes retired authored fields from provider inputs and tools', async () => {
  const seed = await authoredInput();
  const server = await loopbackProvider(async (request, response) => {
    const body = JSON.parse(request.body);
    if (!body.input.results.length)
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'read-bot',
          name: 'knowledge.read',
          argumentsDelta: '{"id":"package:bot:bot:body"}',
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
    else
      await writeSse(response, [
        { type: 'text_delta', delta: `합성 번역 ${translationFixtureSlot(body, 'source')}` },
        { type: 'done', reason: 'stop' },
      ]);
  });
  cleanups.push(server.close);
  selectProvider(seed, server.endpoint);
  const before = structuredClone(seed);
  const state = bridge(seed);
  const outcome = await runAuxiliaryJob(
    state.store,
    seed.job.id,
    'owner',
    hooks(server.origin).options
  );
  expect(outcome?.status).toBe('completed');
  expect(server.requests).toHaveLength(2);
  const wires = JSON.stringify(server.requests.map((request) => JSON.parse(request.body)));
  expect(wires).not.toMatch(/RETIRED_|EXECUTED/);
  expect(wires).toContain('Mira has not learned the keeper identity.');
  expect(wires).toContain(seed.source.text);
  expect(JSON.stringify(state.claims)).not.toMatch(/RETIRED_|EXECUTED/);
  expect(state.data).toEqual(before);
  expect(seed).toEqual(before);
});
