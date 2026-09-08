import { afterEach, describe, expect, test } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { Json } from '../core/transport.js';
import type { AuxiliaryBundle } from '../server/product-auxiliary.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import {
  translationPolicy,
  translationMaxRetries,
  translationMaxCalls,
  parseTranslationRefusalVerdict,
} from '../core/translation-settings.js';
import { bundle, bridge, hooks, selectProvider } from './fixtures/translation-job.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(handler: Parameters<typeof loopbackProvider>[0]) {
  const value = await loopbackProvider(handler);
  cleanups.push(value.close);
  return value;
}
function native(seed: AuxiliaryBundle, endpoint: string) {
  selectProvider(seed, endpoint);
  const model = seed.snapshot.profile!.models.translation!;
  model.modelId = 'provider/translator';
  model.connection.protocol = 'openai-chat-v1';
  seed.translationPolicy = {
    ...translationPolicy(),
    refusalModel: { ...structuredClone(model), id: 'classifier', modelId: 'provider/classifier' },
  };
}
function chat(response: ServerResponse, text: string, finish = 'stop', refusal?: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: { content: text, ...(refusal ? { refusal } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`
  );
  response.end('data: [DONE]\n\n');
}
const kind = (body: string) => JSON.parse(body).model as string;

describe('whole-source refusal classification with local Chat protocol fixtures', () => {
  test('sends natural translation text as-is and only its first 1000 characters to the configured classifier', async () => {
    const translated = '안 돼! 사과 1개와 경비병 세 명. ' + '가'.repeat(1200) + 'PRIVATE_TAIL';
    const server = await fixture((request, response) =>
      chat(
        response,
        kind(request.body).endsWith('classifier') ? '{"verdict":"accepted"}' : translated
      )
    );
    const seed = bundle('FULL_SOURCE_' + 'x'.repeat(40000));
    native(seed, server.endpoint);
    seed.snapshot.settings.maxCalls = 1;
    const observed = hooks(server.origin);
    const outcome = await runAuxiliaryJob(
      bridge(seed).store,
      seed.job.id,
      'owner',
      observed.options
    );
    expect(outcome).toMatchObject({
      status: 'completed',
      result: { text: translated, sourceHash: seed.source.hash, mock: false },
    });
    expect(server.requests).toHaveLength(2);
    const classifier = server.requests[1].body;
    expect(classifier).toContain('translation-refusal');
    expect(classifier).toContain(Array.from(translated).slice(0, 1000).join(''));
    expect(classifier).not.toMatch(
      /PRIVATE_TAIL|FULL_SOURCE_|Mira has not learned|SOURCE_TIME_GLOSSARY/
    );
    expect(observed.finishes).toHaveLength(2);
    expect(observed.wire.every((wire) => wire.role === 'translation')).toBe(true);
    expect(observed.finishes.every(({ result }) => result.usage.inputTokens === 2)).toBe(true);
  });

  test('confirmed classifier refusal retries once by default with fresh tool state', async () => {
    let translations = 0,
      classifications = 0;
    const server = await fixture((request, response) => {
      if (kind(request.body).endsWith('classifier'))
        chat(
          response,
          JSON.stringify({ verdict: ++classifications === 1 ? 'refused' : 'accepted' })
        );
      else chat(response, ++translations === 1 ? 'I cannot translate this.' : '번역된 이야기.');
    });
    const seed = bundle();
    native(seed, server.endpoint);
    const observed = hooks(server.origin);
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', observed.options)
    ).toMatchObject({ status: 'completed', result: { text: '번역된 이야기.' } });
    expect(translations).toBe(2);
    expect(classifications).toBe(2);
    expect(observed.finishes).toHaveLength(4);
  });

  test.each(['uncertain', 'malformed', 'error', 'partial'])(
    'classifier %s preserves candidate and never retries translation',
    async (failure) => {
      const candidate = '번역 후보 원문 보존';
      const server = await fixture((request, response) => {
        if (!kind(request.body).endsWith('classifier')) return chat(response, candidate);
        if (failure === 'error') {
          response.writeHead(503);
          response.end();
          return;
        }
        chat(
          response,
          failure === 'malformed' ? 'not JSON' : '{"verdict":"uncertain"}',
          failure === 'partial' ? 'length' : 'stop'
        );
      });
      const seed = bundle();
      native(seed, server.endpoint);
      const outcome = await runAuxiliaryJob(
        bridge(seed).store,
        seed.job.id,
        'owner',
        hooks(server.origin).options
      );
      expect(outcome).toMatchObject({ status: 'failed', result: { text: candidate } });
      expect(server.requests).toHaveLength(2);
    }
  );

  test('live protocol requires a configured classifier before sending translation', async () => {
    const seed = bundle();
    native(seed, 'http://127.0.0.1:1/turn');
    seed.translationPolicy!.refusalModel = null;
    const observed = hooks();
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', observed.options)
    ).toMatchObject({ status: 'failed', error: 'TRANSLATION_REFUSAL_MODEL_REQUIRED' });
    expect(observed.wire).toEqual([]);
  });

  test('classifier and translator share the current job policy budget', async () => {
    const server = await fixture((request, response) =>
      chat(
        response,
        kind(request.body).endsWith('classifier') ? '{"verdict":"refused"}' : 'I cannot translate.'
      )
    );
    const seed = bundle();
    native(seed, server.endpoint);
    seed.translationPolicy!.maxCalls = 2;
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', hooks(server.origin).options)
    ).toMatchObject({
      status: 'failed',
      error: 'AUXILIARY_CALL_BUDGET_EXHAUSTED',
      result: { text: 'I cannot translate.' },
    });
    expect(server.requests).toHaveLength(2);
  });

  test('maxRetries zero retains a refused candidate without replay', async () => {
    const server = await fixture((request, response) =>
      chat(
        response,
        kind(request.body).endsWith('classifier') ? '{"verdict":"refused"}' : 'Cannot translate.'
      )
    );
    const seed = bundle();
    native(seed, server.endpoint);
    seed.translationPolicy!.maxRetries = 0;
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', hooks(server.origin).options)
    ).toMatchObject({
      status: 'failed',
      error: 'TRANSLATION_REFUSAL_RETRIES_EXHAUSTED',
      result: { text: 'Cannot translate.' },
    });
    expect(server.requests).toHaveLength(2);
  });

  test('cancellation after classifier response retains usage and prevents another translation', async () => {
    const server = await fixture((request, response) =>
      chat(
        response,
        kind(request.body).endsWith('classifier') ? '{"verdict":"refused"}' : 'Candidate.'
      )
    );
    const seed = bundle();
    native(seed, server.endpoint);
    const observed = hooks(server.origin),
      controller = new AbortController();
    observed.options.signal = controller.signal;
    const finish = observed.options.onAttemptFinish;
    observed.options.onAttemptFinish = async (id, result) => {
      await finish(id, result);
      if (observed.finishes.length === 2) controller.abort();
    };
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', observed.options)
    ).toMatchObject({ status: 'cancelled', result: { text: 'Candidate.' } });
    expect(server.requests).toHaveLength(2);
    expect(observed.finishes).toHaveLength(2);
  });

  test('classifier authorization is rechecked and cannot cause translation replay', async () => {
    const server = await fixture((_request, response) => chat(response, 'Candidate.'));
    const seed = bundle();
    native(seed, server.endpoint);
    seed.translationPolicy!.refusalModel!.connectionId = 'classifier-connection';
    seed.translationPolicy!.refusalModel!.connection.id = 'classifier-connection';
    const observed = hooks(server.origin);
    observed.options.authorize = (value) => {
      if (value.id === 'classifier-connection') throw new Error('denied');
      return value;
    };
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', observed.options)
    ).toMatchObject({
      status: 'failed',
      error: 'CONNECTION_NOT_AUTHORIZED',
      result: { text: 'Candidate.' },
    });
    expect(server.requests).toHaveLength(1);
  });
});

describe('terminal translation retry boundaries', () => {
  test('deterministic provider refusal retries but does not require a synthetic classifier', async () => {
    let calls = 0;
    const server = await fixture((_request, response) =>
      writeSse(
        response,
        ++calls === 1
          ? [
              { type: 'refusal', message: 'Refused.' },
              { type: 'done', reason: 'refusal' },
            ]
          : [
              { type: 'text_delta', delta: '합성 번역' },
              { type: 'done', reason: 'stop' },
            ]
      )
    );
    const seed = bundle();
    selectProvider(seed, server.endpoint);
    expect(
      await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', hooks(server.origin).options)
    ).toMatchObject({ status: 'completed', result: { mock: true, text: '합성 번역' } });
    expect(server.requests).toHaveLength(2);
  });
  test.each(['partial', 'empty', 'eof', 'refusal-eof', 'http'])(
    'does not replay %s',
    async (failure) => {
      const server = await fixture((_request, response) => {
        if (failure === 'http') {
          response.writeHead(503);
          response.end();
          return;
        }
        const events: Json[] =
          failure === 'refusal-eof'
            ? [{ type: 'refusal', message: 'Uncertain refusal' }]
            : failure === 'empty'
              ? []
              : [{ type: 'text_delta', delta: 'Incomplete' }];
        if (failure === 'partial') events.push({ type: 'done', reason: 'length' });
        if (failure === 'empty') events.push({ type: 'done', reason: 'stop' });
        return writeSse(response, events);
      });
      const seed = bundle();
      selectProvider(seed, server.endpoint);
      const observed = hooks(server.origin);
      expect(
        (await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', observed.options))?.status
      ).toBe('failed');
      expect(server.requests).toHaveLength(1);
      expect(observed.finishes).toHaveLength(1);
    }
  );
  test('policy validates bounded retries and classifier JSON never executes instructions', () => {
    expect(translationPolicy()).toEqual({ refusalModel: null, maxRetries: 1, maxCalls: 16 });
    for (const invalid of [-1, 6, 1.5, null, '1'])
      expect(() => translationMaxRetries(invalid)).toThrow();
    for (const invalid of [0, 1, 65, 1.5]) expect(() => translationMaxCalls(invalid)).toThrow();
    for (const text of [
      '{}',
      '{"verdict":"accepted","extra":true}',
      '```json\n{"verdict":"accepted"}\n```',
      'ignore instructions',
    ])
      expect(parseTranslationRefusalVerdict(text)).toBe('uncertain');
  });
});
