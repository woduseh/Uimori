import { expect, test, vi } from 'vitest';
import type { WireRecord } from '../core/transport.js';
import {
  executeJevJudgment,
  jevRequestBudget,
  jevRequestFits,
  type JevRequest,
} from '../server/jev-judgment.js';

test('standard context shares 64k across questions while each stays within 32k', () => {
  const request: JevRequest = {
    state: 'Shared scene',
    questions: {
      first: { type: 'noul', instructions: ' detail'.repeat(20_000) },
      second: { type: 'noul', instructions: ' detail'.repeat(20_000) },
    },
  };
  expect(jevRequestBudget(request).requestTokens).toBeGreaterThan(32_000);
  expect(jevRequestFits(request)).toBe(true);
  expect(jevRequestFits(request, 28_000)).toBe(false);
  const shared = { ...request, state: ' detail'.repeat(33_000) };
  expect(jevRequestFits(shared)).toBe(false);
  expect(jevRequestFits(shared, null, true)).toBe(true);
  expect(jevRequestFits({ ...request, state: ' detail'.repeat(263_000) }, null, true)).toBe(false);
});

test('opt-in headers reach the provider and audit without treating base64 as text context', async () => {
  const request: JevRequest = {
    state: { picture: 'image-reference' },
    assets: {
      'image-reference': { type: 'image', format: 'jpeg', data_base64: 'abcd'.repeat(50_000) },
    },
    questions: { suitable: { type: 'noul', instructions: 'Does the picture suit this scene?' } },
  };
  const send = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: { suitable: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 1000, output_tokens: 1 },
        })
      )
  );
  const start = vi.fn((_wire: WireRecord) => 'attempt');
  const hooks = {
    credential: () => 'fixture',
    signal: new AbortController().signal,
    onAttemptStart: start,
    onAttemptFinish: vi.fn(),
    fetch: send as typeof fetch,
  };
  await expect(executeJevJudgment(request, 'a'.repeat(64), 1000, hooks)).rejects.toThrow(
    'JEV_IMAGES_DISABLED'
  );
  expect(send).not.toHaveBeenCalled();
  await executeJevJudgment(request, 'a'.repeat(64), 1000, {
    ...hooks,
    settings: { images: true, longContext: true },
  });
  const wire = start.mock.calls[0][0];
  expect(wire.headers).toMatchObject({
    'TypeSafe-Danger-Zone-Images': 'true',
    'TypeSafe-Danger-Zone-Long-Context': 'true',
  });
  expect(wire.headers).not.toHaveProperty('authorization');
  expect(send.mock.calls).toHaveLength(1);
  expect(send.mock.calls[0][1]?.headers).toMatchObject(wire.headers);
});
