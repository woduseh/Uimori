import { afterEach, expect, test } from 'vitest';
import { nativeRisuFieldKey } from '../core/risu-native-execution.js';
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

async function historical() {
  const seed = bundle();
  seed.snapshot = await prepareNativeRisuRun(seed.snapshot, { preview: true });
  const pkg = seed.snapshot.profile!.packages![0];
  pkg.nativeRisu.card.personality = '{{setvar::retired::EXECUTED}}RETIRED_PERSONALITY';
  pkg.nativeRisu.card.scenario = 'RETIRED_SCENARIO';
  pkg.nativeRisu.card.system_prompt = 'RETIRED_SYSTEM';
  pkg.body += '\nRETIRED_PERSONALITY\nRETIRED_SCENARIO';
  pkg.instructions = [{ id: 'card-system', target: 'main', text: 'RETIRED_SYSTEM' }];
  const execution = seed.snapshot.nativeRisuExecution!;
  execution.version = 1;
  execution.fields[nativeRisuFieldKey(seed.snapshot.profile!.packageAttachments![0])] = {
    body: pkg.body!,
    'instruction:card-system': 'RETIRED_SYSTEM',
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

test('a new read-only operation reprojects historical native source without mutating its receipt', async () => {
  const seed = await historical();
  const before = structuredClone(seed.snapshot);
  expect(nativeRisuSnapshotNeedsRefresh(seed.snapshot)).toBe(true);
  const refreshed = await prepareNativeRisuReadOnly(seed.snapshot, 'context');
  expect(refreshed.nativeRisuExecution?.version).toBe(2);
  expect(refreshed.nativeRisuExecution?.variables.retired).toBeUndefined();
  expect(JSON.stringify(refreshed)).not.toMatch(/RETIRED_|EXECUTED/);
  expect(refreshed.profile!.packages![0].body).toBe('Mira has not learned the keeper identity.');
  expect(refreshed.profile!.packages![0].instructions).toEqual([]);
  expect(nativeRisuSnapshotNeedsRefresh(refreshed)).toBe(false);
  expect(seed.snapshot).toEqual(before);
});

test('new translation from a historical source excludes retired fields from provider inputs and tools', async () => {
  const seed = await historical();
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
