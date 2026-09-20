import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { validateTranslationJudgmentWire } from '../server/jev-attribution.js';
import { translationJudgmentInputHash } from '../server/translation-judgment.js';
import type { Json } from '../core/transport.js';
import type { AuxiliaryBundle } from '../server/product-auxiliary.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import {
  translationPolicy,
  translationMaxRetries,
  translationMaxCalls,
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
  seed.translationPolicy = translationPolicy();
}
function chat(response: ServerResponse, text: string, finish = 'stop', refusal?: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: { content: text, ...(refusal ? { refusal } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`
  );
  response.end('data: [DONE]\n\n');
}

describe('shared Jev translation refusal judgment', () => {
  const answer = (refusal: number) =>
    new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: {
          explicitRefusal: { type: 'noul', noul: refusal },
        },
        usage: { input_tokens: 40, output_tokens: 2 },
      }),
      { status: 200 }
    );
  test.each([
    [0.05, 0.9, 'completed', null],
    [0.58, 0.9, 'completed', null],
    [0.899, 0.9, 'completed', null],
    [0.9, 0.9, 'failed', 'TRANSLATION_REFUSAL_RETRIES_EXHAUSTED'],
    [0.58, 0.58, 'failed', 'TRANSLATION_REFUSAL_RETRIES_EXHAUSTED'],
  ] as const)(
    'preserves the candidate for refusal %s / threshold %s with outcome %s',
    async (refusal, threshold, status, error) => {
      const candidate = '번역 후보 원문 ' + '가😀'.repeat(4000) + 'PRIVATE_TAIL';
      const server = await fixture((_request, response) => chat(response, candidate));
      const seed = bundle('SOURCE_MUST_NOT_REACH_JUDGMENT');
      native(seed, server.endpoint);
      seed.translationPolicy = {
        judgment: { threshold },
        maxRetries: 0,
        maxCalls: 4,
      };
      const observed = hooks(server.origin),
        send = vi.fn(async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          expect(body.state).toEqual({ response: candidate });
          expect(Object.keys(body.questions)).toEqual(['explicitRefusal']);
          expect(String(init?.body)).not.toContain('SOURCE_MUST_NOT_REACH_JUDGMENT');
          return answer(refusal);
        });
      const result = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
        ...observed.options,
        jev: { credential: () => 'test-key', fetch: send },
      });
      expect(result).toMatchObject({ status, error, result: { text: candidate } });
      expect(server.requests).toHaveLength(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(observed.wire[1]).toMatchObject({
        role: 'translation',
        protocol: 'typesafe-systemone-v1',
        judgment: { kind: 'translation-refusal' },
      });
      const judgmentWire = observed.wire[1];
      expect(() =>
        validateTranslationJudgmentWire(seed.source.hash, { threshold }, judgmentWire)
      ).not.toThrow();
      expect(translationJudgmentInputHash(seed.source.hash, candidate, { threshold })).not.toBe(
        translationJudgmentInputHash(seed.source.hash, candidate + 'changed tail', { threshold })
      );
      for (const field of ['response', 'questions', 'bodyHash', 'questionsHash'] as const) {
        const changed = structuredClone(judgmentWire);
        const body = changed.body as {
          state: { response: string };
          questions: Record<string, unknown>;
        };
        if (field === 'response') body.state.response += 'changed tail';
        if (field === 'questions')
          body.questions.extra = { type: 'noul', instructions: 'Another question' };
        if (field === 'bodyHash') changed.bodySha256 = '0'.repeat(64);
        else
          changed.bodySha256 = createHash('sha256')
            .update(JSON.stringify(changed.body))
            .digest('hex');
        if (field === 'questionsHash') changed.stablePrefixSha256 = '0'.repeat(64);
        expect(() =>
          validateTranslationJudgmentWire(seed.source.hash, { threshold }, changed)
        ).toThrow('TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
      }
      expect(observed.finishes).toHaveLength(2);
      expect(JSON.stringify(observed.wire)).not.toContain('test-key');
    }
  );
  test.each([3, 4])(
    'only confirmed refusal retries within the shared call budget of %s',
    async (maxCalls) => {
      let translations = 0,
        judgments = 0;
      const server = await fixture((_request, response) =>
        chat(response, ++translations === 1 ? 'Cannot translate.' : '번역된 이야기.')
      );
      const seed = bundle();
      native(seed, server.endpoint);
      seed.translationPolicy = {
        judgment: { threshold: 0.9 },
        maxRetries: 1,
        maxCalls,
      };
      const observed = hooks(server.origin);
      const outcome = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
        ...observed.options,
        jev: {
          credential: () => 'test-key',
          fetch: async () => (++judgments === 1 ? answer(0.95) : answer(0.05)),
        },
      });
      expect(outcome).toMatchObject({
        status: maxCalls === 4 ? 'completed' : 'failed',
        result: { text: '번역된 이야기.' },
      });
      if (maxCalls === 3) expect(outcome?.error).toBe('AUXILIARY_CALL_BUDGET_EXHAUSTED');
      expect(translations).toBe(2);
      expect(judgments).toBe(maxCalls - 2);
      expect(observed.finishes).toHaveLength(maxCalls);
    }
  );
  test.each(['transport', 'format', 'budget'] as const)(
    '%s judgment failure keeps the candidate without replay',
    async (failure) => {
      const server = await fixture((_request, response) => chat(response, '보존할 후보'));
      const seed = bundle();
      native(seed, server.endpoint);
      seed.translationPolicy = {
        judgment: { threshold: 0.9 },
        maxRetries: 3,
        maxCalls: 8,
      };
      const observed = hooks(server.origin),
        send = vi.fn(async () => {
          if (failure === 'transport') throw new Error('Network uncertain');
          if (failure === 'budget')
            return new Response(JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }), {
              status: 400,
            });
          return answer(2);
        });
      const outcome = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
        ...observed.options,
        jev: { credential: () => 'test-key', fetch: send },
      });
      expect(outcome).toMatchObject({
        status: 'failed',
        result: { text: '보존할 후보' },
        diagnostic: {
          stage: 'translation-refusal',
          code: failure === 'budget' ? 'JEV_INPUT_BUDGET' : 'TRANSLATION_REFUSAL_CHECK_FAILED',
          attemptId: 'attempt-2',
        },
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
      expect(observed.finishes[1].result.usage.inputTokens).toBe(failure === 'format' ? 40 : null);
    }
  );
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
  test('policy validates bounded retries and rejects removed model/backend settings', () => {
    expect(translationPolicy()).toEqual({
      judgment: { threshold: 0.9 },
      maxRetries: 1,
      maxCalls: 16,
    });
    for (const invalid of [-1, 6, 1.5, null, '1'])
      expect(() => translationMaxRetries(invalid)).toThrow();
    for (const invalid of [0, 1, 65, 1.5]) expect(() => translationMaxCalls(invalid)).toThrow();
    expect(() =>
      translationPolicy({ ...translationPolicy(), refusalModel: null } as never)
    ).toThrow('TRANSLATION_POLICY_INVALID');
    expect(() =>
      translationPolicy({
        ...translationPolicy(),
        judgment: { backend: 'jev', threshold: 0.9 },
      } as never)
    ).toThrow('TRANSLATION_JUDGMENT_INVALID');
  });
});

test('preserves oversized translation when JEV preflight rejects it without retry or judgment attempt', async () => {
  const candidate = '가😀 '.repeat(20000);
  const server = await fixture((_request, response) => chat(response, candidate));
  const seed = bundle();
  native(seed, server.endpoint);
  seed.translationPolicy = { judgment: { threshold: 0.9 }, maxRetries: 3, maxCalls: 8 };
  const observed = hooks(server.origin);
  const send = vi.fn();
  const outcome = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
    ...observed.options,
    jev: { credential: () => 'test-key', fetch: send },
  });
  expect(outcome).toMatchObject({
    status: 'failed',
    error: 'JEV_INPUT_BUDGET',
    result: { text: candidate },
  });
  expect(send).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  expect(observed.wire).toHaveLength(1);
  expect(observed.finishes).toHaveLength(1);
});

test('disabled translation judgment accepts refusal text without consulting JEV or retrying', async () => {
  const candidate = 'I cannot translate this request.';
  const server = await fixture((_request, response) => chat(response, candidate));
  const seed = bundle();
  native(seed, server.endpoint);
  seed.translationPolicy = {
    judgment: { enabled: false, threshold: 0.9 },
    maxRetries: 3,
    maxCalls: 2,
  };
  const observed = hooks(server.origin),
    credential = vi.fn(() => undefined),
    send = vi.fn();
  const outcome = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
    ...observed.options,
    jev: { credential, fetch: send },
  });
  expect(outcome).toMatchObject({ status: 'completed', error: null, result: { text: candidate } });
  expect(credential).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
  expect(observed.wire).toHaveLength(1);
  expect(observed.wire[0].judgment).toBeUndefined();
  expect(observed.finishes).toHaveLength(1);
});

test.each(['length', 'empty', 'http', 'refusal'] as const)(
  'disabled translation judgment preserves generation failure: %s',
  async (failure) => {
    const server = await fixture((_request, response) => {
      if (failure === 'http') {
        response.writeHead(503);
        response.end();
        return;
      }
      if (failure === 'refusal') {
        chat(response, '', 'stop', 'Refused by provider');
        return;
      }
      chat(
        response,
        failure === 'empty' ? '' : 'Incomplete output',
        failure === 'length' ? 'length' : 'stop'
      );
    });
    const seed = bundle();
    native(seed, server.endpoint);
    seed.translationPolicy = {
      judgment: { enabled: false, threshold: 0.9 },
      maxRetries: 3,
      maxCalls: 2,
    };
    const observed = hooks(server.origin),
      credential = vi.fn(() => undefined),
      send = vi.fn();
    const outcome = await runAuxiliaryJob(bridge(seed).store, seed.job.id, 'owner', {
      ...observed.options,
      jev: { credential, fetch: send },
    });
    expect(outcome?.status).toBe('failed');
    expect(server.requests).toHaveLength(1);
    expect(credential).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }
);
