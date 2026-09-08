import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { afterEach, describe, expect, test } from 'vitest';
import { runAuxiliaryJob, sourceTimeContext } from '../server/product-auxiliary.js';
import { bundle, bridge, hooks, selectProvider } from './fixtures/translation-job.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) {
  const server = await loopbackProvider(handler);
  cleanups.push(server.close);
  return server;
}
function translationBody(wire: string) {
  return `합성 번역 ${JSON.parse(wire).input.source.text}`;
}

describe('M1 durable auxiliary orchestration with actual fixture HTTP', () => {
  test('P07 P05 records actual selected transport attempts, paired batched calls and opaque source-time results', async () => {
    const seed = bundle();
    const server = await fixture(async (request, response) => {
      const body = JSON.parse(request.body);
      if (!body.input.results.length)
        await writeSse(
          response,
          [
            {
              type: 'tool_delta',
              index: 0,
              id: 'read-old-glossary',
              name: 'knowledge.read',
              argumentsDelta: '{"id":"old-glossary"}',
            },
            {
              type: 'tool_delta',
              index: 1,
              id: 'load-method',
              name: 'skills.load',
              argumentsDelta: '{"id":"craft"}',
            },
            { type: 'opaque_state', state: { continuation: 'opaque-for-translation' } },
            {
              type: 'usage',
              inputTokens: 13,
              outputTokens: 2,
              costUsd: null,
              raw: { fixture: 'first' },
              priceRevision: null,
            },
            { type: 'done', reason: 'tool_calls' },
          ],
          true
        );
      else
        await writeSse(response, [
          { type: 'text_delta', delta: translationBody(request.body) },
          { type: 'done', reason: 'stop' },
        ]);
    });
    selectProvider(seed, server.endpoint);
    const state = bridge(seed);
    const observed = hooks(server.origin);
    const original = JSON.stringify(seed.source);
    observed.options.onInput = () => {
      seed.snapshot.profile!.contents[0].text = 'FUTURE_MUTATION';
    };
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options);
    expect(outcome?.status).toBe('completed');
    expect(outcome?.result?.mock).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(observed.wire).toHaveLength(2);
    expect(observed.finishes).toHaveLength(2);
    expect(observed.finishes[0]).toMatchObject({
      id: 'attempt-1',
      result: { status: 'tool_calls', usage: { inputTokens: 13 } },
    });
    const first = JSON.parse(server.requests[0].body);
    const second = JSON.parse(server.requests[1].body);
    expect(first.role).toBe('translation');
    expect(first.modelId).toBe('explicit-fixture-model');
    expect(first.input.source.context).toMatchObject({
      revision: 'chat-a@4',
      bot: { id: 'bot', revision: 2, text: 'Mira has not learned the keeper identity.' },
      references: [
        { id: 'names', revision: 3 },
        { id: 'canon', revision: 4 },
      ],
    });
    expect(first.input.source.context.modelPresetRevision).toBe('model-translation@5');
    expect(JSON.stringify(first)).not.toContain('SOURCE_TIME_GLOSSARY');
    expect(second.opaqueState).toEqual({ continuation: 'opaque-for-translation' });
    expect(second.input.results.map((item: { callId: string }) => item.callId)).toEqual([
      'read-old-glossary',
      'load-method',
    ]);
    expect(second.input.results[0].result.text).toContain('SOURCE_TIME_GLOSSARY');
    expect(second.input.results[0].result.source.revision).toBe(7);
    expect(JSON.stringify(server.requests)).not.toMatch(/FUTURE_MUTATION|EXCLUDED_OTHER_CHAT/);
    expect(JSON.stringify(seed.source)).toBe(original);
  });

  test('P07 P13 disabled transport uses labeled local fixture; annotations stay separate and cancellation preserves source', async () => {
    const seed = bundle();
    const original = JSON.stringify(seed.source);
    const state = bridge(seed);
    const observed = hooks();
    const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'server-a', observed.options);
    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toMatchObject({ mock: true, text: seed.source.text });
    expect(observed.wire).toEqual([]);
    seed.job.kind = 'image';
    const imageState = bridge(seed);
    const images = await runAuxiliaryJob(
      imageState.store,
      seed.job.id,
      'server-a',
      observed.options
    );
    expect(images?.result?.annotations).toEqual([]);
    expect(images?.result).not.toHaveProperty('text');
    expect(images?.result).not.toHaveProperty('display');
    seed.job.kind = 'status';
    const displayState = bridge(seed);
    const annotation = await runAuxiliaryJob(
      displayState.store,
      seed.job.id,
      'server-a',
      observed.options
    );
    expect(annotation?.result?.display?.[0].summary).toContain('정사에 반영하지 않음');
    expect(sourceTimeContext(seed.snapshot, 'image').references).toMatchObject([
      { id: 'names', revision: 3 },
      { id: 'canon', revision: 4 },
    ]);
    const controller = new AbortController();
    controller.abort('PRIVATE_ABORT_REASON');
    observed.options.signal = controller.signal;
    const cancelled = await runAuxiliaryJob(
      bridge(seed).store,
      seed.job.id,
      'server-a',
      observed.options
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', error: 'AUXILIARY_CANCELLED' });
    expect(JSON.stringify(cancelled)).not.toContain('PRIVATE_ABORT_REASON');
    expect(JSON.stringify(seed.source)).toBe(original);
  });
});

test('custom translation prompt survives tool continuation and refusal retry without inheriting later edits', async () => {
  const custom = '  Translate into French.\r\n{{char}} remains literal.  ';
  const seed = bundle();
  seed.snapshot.profile!.promptPresets = {
    translation: {
      id: 'translation-custom',
      revision: 8,
      role: 'translation',
      title: 'Custom translation',
      program: createDefaultPromptProgram(custom, 'translation'),
    },
  };
  let requests = 0;
  const server = await fixture(async (captured, response) => {
    requests++;
    if (requests === 1)
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'custom-glossary',
          name: 'knowledge.read',
          argumentsDelta: '{"id":"old-glossary"}',
        },
        { type: 'opaque_state', state: { test: 'custom-translation' } },
        { type: 'done', reason: 'tool_calls' },
      ]);
    else {
      await writeSse(
        response,
        requests === 2
          ? [
              { type: 'refusal', message: 'terminal refusal' },
              { type: 'done', reason: 'refusal' },
            ]
          : [
              { type: 'text_delta', delta: translationBody(captured.body) },
              { type: 'done', reason: 'stop' },
            ]
      );
    }
  });
  selectProvider(seed, server.endpoint);
  const state = bridge(seed);
  const observed = hooks(server.origin);
  observed.options.onInput = () => {
    seed.snapshot.profile!.promptPresets!.translation!.program = createDefaultPromptProgram(
      'FUTURE TRANSLATION PROMPT',
      'translation'
    );
  };
  const outcome = await runAuxiliaryJob(state.store, seed.job.id, 'first-owner', observed.options);
  expect(outcome?.status).toBe('completed');
  expect(server.requests).toHaveLength(3);
  for (const captured of server.requests) {
    const wire = JSON.parse(captured.body);
    expect(wire.stable.contract).toBe('');
    expect(wire.prompt.messages[0].content[0].text).toBe(custom);
    expect(wire.input.task).not.toContain('Korean');
    expect(wire.input.controls).toMatchObject({
      instructionRevision: 'prompt:translation-custom@8',
      customPrompt: true,
    });
    expect(JSON.stringify(wire.input.source.outputSchema)).not.toContain('Korean');
    expect(captured.body).not.toContain('FUTURE TRANSLATION PROMPT');
  }
  expect(JSON.parse(server.requests[1].body).input.results[0].callId).toBe('custom-glossary');
});
