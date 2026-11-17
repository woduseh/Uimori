import { describe, expect, it, vi } from 'vitest';
import type { WireRecord } from '../core/transport.js';
import {
  executeJudgment,
  buildJudgmentWire,
  readJudgmentRequest,
  targetFromJudgmentWire,
  judgmentLimits,
} from '../server/judgment.js';
import { settleWithin, stalledProviderBody } from './fixtures/stalled-provider-body.js';

const request = {
  state: 'A scene',
  questions: { relevant: { type: 'noul' as const, instructions: 'Relevant?' } },
};
const target = {
  provider: 'typesafe-compatible' as const,
  connectionId: 'gateway',
  modelId: 'judge',
  endpoint: 'https://example.test/v1/systemone',
};
const inputHash = 'a'.repeat(64);

describe('judgment transport', () => {
  it('records an attributable request without its credential and does not retry a failure', async () => {
    const send = vi.fn<typeof fetch>(async () => new Response('unavailable', { status: 503 }));
    const start = vi.fn<(wire: WireRecord) => string>(() => 'attempt');
    const finish = vi.fn();
    const hooks = {
      target,
      signal: new AbortController().signal,
      credential: () => 'secret',
      fetch: send,
      onAttemptStart: start,
      onAttemptFinish: finish,
    };
    await expect(executeJudgment(request, inputHash, null, hooks)).rejects.toMatchObject({
      code: 'JUDGMENT_HTTP_503',
      attempted: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(start.mock.calls)).not.toContain('secret');
    expect(finish).toHaveBeenCalledOnce();
    const [[wire]] = start.mock.calls;
    expect(send.mock.calls[0][1]?.body).toBe(JSON.stringify(wire.body));
    expect(readJudgmentRequest(wire)).toEqual(request);
    expect(targetFromJudgmentWire(wire)).toEqual(target);
  });

  it('rejects a forged official target and malformed stored request', () => {
    const wire = buildJudgmentWire(request, inputHash, {});
    expect(targetFromJudgmentWire({ ...wire, url: 'https://example.test' })).toBeNull();
    expect(
      readJudgmentRequest({
        ...wire,
        body: { model: 'jev-latest', state: '', questions: { broken: {} } },
      })
    ).toBeNull();
  });

  it.each(['cancel', 'timeout'] as const)(
    'records %s during an uncertain request without retry',
    async (mode) => {
      const stalled = stalledProviderBody();
      const controller = new AbortController();
      const send = vi.fn(async () => stalled.response);
      const finish = vi.fn();
      const work = executeJudgment(request, inputHash, null, {
        target,
        signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 30 : 1000,
        credential: () => 'secret',
        fetch: send,
        onAttemptStart: () => 'attempt',
        onAttemptFinish: finish,
      }).catch((error: unknown) => error);
      await stalled.pendingRead;
      if (mode === 'cancel') controller.abort();
      const error = await settleWithin(work);
      expect(error).toMatchObject({
        code: mode === 'cancel' ? 'JUDGMENT_CANCELLED' : 'JUDGMENT_TIMEOUT',
        attempted: true,
      });
      expect(send).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledOnce();
      stalled.release();
    }
  );

  it('requires full choice probabilities from a compatible System One provider', async () => {
    const choiceRequest = {
      state: '',
      questions: {
        image: { type: 'choice' as const, instructions: '', criteria: { one: null, none: null } },
      },
    };
    const response = new Response(
      JSON.stringify({
        model: 'judge',
        answers: { image: { type: 'choice', choice: 'one', probabilities: { one: 0.8 } } },
      })
    );
    await expect(
      executeJudgment(choiceRequest, inputHash, null, {
        target,
        kind: 'image-selection',
        signal: new AbortController().signal,
        credential: () => 'secret',
        fetch: async () => response,
        onAttemptStart: () => 'attempt',
        onAttemptFinish: () => {},
      })
    ).rejects.toMatchObject({ code: 'JUDGMENT_RESPONSE_INVALID', attempted: true });
  });

  it('limits OpenAI-compatible requests to 128 questions', () => {
    expect(judgmentLimits({ ...target, provider: 'openai-compatible' }).maxQuestions).toBe(128);
  });
});
