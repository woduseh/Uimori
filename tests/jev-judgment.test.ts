import { estimateContextTokens } from '../core/context-budget.js';
import { describe, expect, it, vi } from 'vitest';
import { executeJevJudgment, JEV_ENDPOINT, type JevRequest } from '../server/jev-judgment.js';
import { prepareLoreSelection, loreSelectionAttemptInputHashes } from '../server/lore-selection.js';
import { defaultProfile } from '../core/product.js';
import { DEFAULT_LORE_CONTEXT, validateLoreContextPolicy } from '../core/lore-context.js';
import { DEFAULT_JEV_JUDGMENT } from '../core/judgment.js';
import type { RunSnapshot } from '../core/types.js';
import type { MainHooks } from '../server/model-runner.js';
import type { WireRecord } from '../core/transport.js';
import { executeTool, knowledgeReadResults } from '../core/provider.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';

const response = (answers: Record<string, number>) =>
  new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: Object.fromEntries(
        Object.entries(answers).map(([name, noul]) => [name, { type: 'noul', noul }])
      ),
      usage: { input_tokens: 100, output_tokens: 5 },
    }),
    { status: 200 }
  );
const request: JevRequest = {
  state: { message: 'Example' },
  questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
};
const hooks = () => ({
  signal: new AbortController().signal,
  credential: () => 'test-secret',
  onAttemptStart: vi.fn((_wire: WireRecord) => 'attempt-1'),
  onAttemptFinish: vi.fn(),
});
const snapshot = (): RunSnapshot => ({
  chatId: 'test',
  parentRevision: null,
  settingsRevision: 1,
  settings: { mode: 'research', preset: 'calm', translation: false, status: false, maxCalls: 4 },
  request: 'Visit the harbor',
  history: [],
  resources: [],
  profile: {
    ...defaultProfile('test'),
    models: {},
    loreContext: { ...DEFAULT_LORE_CONTEXT, judgment: { ...DEFAULT_JEV_JUDGMENT } },
    packageAttachments: [{ id: 'bot', revision: 1, role: 'bot' }],
    packages: [
      {
        version: 2,
        id: 'bot',
        revision: 1,
        title: 'Test',
        description: '',
        body: 'Body',
        loreActivation: { mode: 'model' },
        lore: [
          {
            id: 'harbor',
            title: 'Harbor',
            description: '',
            text: 'The harbor is open.',
            loading: 'discoverable',
          },
          {
            id: 'mountain',
            title: 'Mountain',
            description: '',
            text: 'The mountain is closed.',
            loading: 'discoverable',
          },
          {
            id: 'always',
            title: 'Always',
            description: '',
            text: 'Always required.',
            loading: 'pinned',
          },
        ],
        nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
      },
    ],
  },
});

describe('Jev typed judgment transport', () => {
  it('sends one official typed request and audits without secret material', async () => {
    const h = hooks(),
      send = vi.fn(async (_url: unknown, _init?: RequestInit) => response({ relevant: 0.9 }));
    const result = await executeJevJudgment(request, 'a'.repeat(64), 5000, { ...h, fetch: send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(JEV_ENDPOINT);
    expect(result.scores).toEqual({ relevant: 0.9 });
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 5, costUsd: null });
    expect(JSON.stringify(h.onAttemptStart.mock.calls)).not.toContain('test-secret');
    expect(h.onAttemptFinish).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ status: 'completed' })
    );
  });
  it('records uncertain transport failures once without retry', async () => {
    const h = hooks(),
      send = vi.fn(async () => {
        throw new Error('sensitive provider detail');
      });
    await expect(
      executeJevJudgment(request, 'b'.repeat(64), 5000, { ...h, fetch: send })
    ).rejects.toThrow('JEV_EXECUTION_FAILED');
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.onAttemptFinish).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: 'error',
        usage: expect.objectContaining({ inputTokens: null }),
      })
    );
    expect(JSON.stringify(h.onAttemptFinish.mock.calls)).not.toContain('sensitive');
  });
  it('does not start a paid attempt for missing credentials or a cancelled request', async () => {
    const h = hooks(),
      send = vi.fn();
    await expect(
      executeJevJudgment(request, 'c'.repeat(64), 5000, {
        ...h,
        credential: () => undefined,
        fetch: send,
      })
    ).rejects.toThrow('JEV_CREDENTIAL_REQUIRED');
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeJevJudgment(request, 'c'.repeat(64), 5000, {
        ...h,
        signal: controller.signal,
        fetch: send,
      })
    ).rejects.toThrow('JEV_CANCELLED');
    expect(send).not.toHaveBeenCalled();
    expect(h.onAttemptStart).not.toHaveBeenCalled();
  });
  it('refuses malformed typed answers instead of accepting a fabricated relevance value', async () => {
    const h = hooks();
    await expect(
      executeJevJudgment(request, 'd'.repeat(64), 5000, {
        ...h,
        fetch: async () => response({ relevant: 2 }),
      })
    ).rejects.toThrow('JEV_RESPONSE_INVALID');
    expect(h.onAttemptFinish).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: 'error',
        usage: expect.objectContaining({ inputTokens: 100 }),
      })
    );
  });
  it('settles cancellation after dispatch without using a late mocked response', async () => {
    const h = hooks(),
      controller = new AbortController();
    await expect(
      executeJevJudgment(request, 'e'.repeat(64), 5000, {
        ...h,
        signal: controller.signal,
        fetch: async () => {
          controller.abort();
          return response({ relevant: 0.95 });
        },
      })
    ).rejects.toThrow('JEV_CANCELLED');
    expect(h.onAttemptFinish).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: 'cancelled',
        usage: expect.objectContaining({ inputTokens: 100 }),
      })
    );
  });
});
describe('JEV-only lore judgment and batch supplemental reads', () => {
  it('shares one judgment across packages with colliding lore ids and one global selection budget', async () => {
    const value = snapshot();
    value.profile!.packages!.push({
      ...structuredClone(value.profile!.packages![0]),
      id: 'module',
      title: 'Module',
    });
    value.profile!.packageAttachments!.push({ id: 'module', revision: 1, role: 'module' });
    value.profile!.loreContext!.maxRetainedEntries = 1;
    const h = hooks();
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.state.entries).toHaveLength(4);
      expect(new Set(body.state.entries.map((entry: { id: string }) => entry.id)).size).toBe(4);
      return response({ entry_0: 0.8, entry_1: 0.1, entry_2: 0.95, entry_3: 0.2 });
    });
    const result = await prepareLoreSelection(
      value,
      {
        ...h,

        authorize: () => {
          throw new Error('unused');
        },
        onInput: () => {},
        onToolEvent: () => {},
      } as MainHooks,
      { reserveCalls: 1, jev: { fetch: send, credential: h.credential } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.usage.modelCalls).toBe(1);
    const receipt = result.snapshot.loreSelection!;
    expect(receipt.entries.map((entry) => entry.selected)).toEqual([[], ['harbor']]);
    expect(receipt.entries[0].omitted).toContainEqual({ id: 'harbor', reason: 'budget' });
    expect(receipt.entries.map((entry) => entry.judgment?.attemptId)).toEqual([
      'attempt-1',
      'attempt-1',
    ]);
    const wire = h.onAttemptStart.mock.calls[0][0];
    expect(loreSelectionAttemptInputHashes(value)).toContain(wire.judgment!.inputHash);
    expect(receipt.entries.map((entry) => entry.inputHash)).not.toContain(wire.judgment!.inputHash);
  });
  it('chooses optional lore in one typed call and never asks about always-on entries', async () => {
    const h = hooks(),
      send = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.state.entries.map((e: { id: string }) => e.id)).toEqual(['harbor', 'mountain']);
        return response({ entry_0: 0.9, entry_1: 0.1 });
      });
    const mainHooks = {
      ...h,

      authorize: () => {
        throw new Error('context model is separate');
      },
      onInput: () => {},
      onToolEvent: () => {},
    } as MainHooks;
    const result = await prepareLoreSelection(snapshot(), mainHooks, {
      reserveCalls: 1,
      jev: { fetch: send, credential: h.credential },
    });
    expect(result.usage.modelCalls).toBe(1);
    expect(result.snapshot.loreSelection?.entries[0]).toMatchObject({
      selected: ['harbor'],
      omitted: [{ id: 'mountain', reason: 'irrelevant' }],
      judgment: {
        scores: [
          { id: 'harbor', probability: 0.9 },
          { id: 'mountain', probability: 0.1 },
        ],
      },
    });
    const replay = await prepareLoreSelection(result.snapshot, mainHooks, {
      reserveCalls: 1,
      jev: { fetch: send, credential: h.credential },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(replay.usage.modelCalls).toBe(0);
  });
  it('applies the host token budget and preserves policy through normal validation', async () => {
    const value = snapshot();
    value.profile!.loreContext!.judgment!.maxSelectedTokens = 0;
    expect(validateLoreContextPolicy(value.profile!.loreContext).judgment?.maxSelectedTokens).toBe(
      0
    );
    const h = hooks(),
      mainHooks = {
        ...h,

        authorize: () => {
          throw new Error('unused');
        },
        onInput: () => {},
        onToolEvent: () => {},
      } as MainHooks;
    const result = await prepareLoreSelection(value, mainHooks, {
      reserveCalls: 1,
      jev: {
        credential: h.credential,
        fetch: async () => response({ entry_0: 0.9, entry_1: 0.8 }),
      },
    });
    expect(result.snapshot.loreSelection?.entries[0]).toMatchObject({
      selected: [],
      omitted: [
        { id: 'harbor', reason: 'budget' },
        { id: 'mountain', reason: 'budget' },
      ],
    });
  });
  it('excludes native lore whose explicit CBS condition rendered empty', async () => {
    const value = snapshot();
    value.profile!.packages![0].nativeRisu = {
      version: 1,
      card: {},
      assets: [],
      sourceHash: 'a'.repeat(64),
    };
    value.nativeRisuExecution = {
      version: 2,
      inputHash: 'b'.repeat(64),
      beforeVariableRevision: 0,
      variables: {},
      fields: { 'bot@1:bot': { 'lore:harbor': '', 'lore:mountain': 'Evaluated mountain.' } },
      request: 'Native edited request',
      messages: [],
      history: [
        { id: 'recent', role: 'assistant', text: 'OLD_PREFIX' + 'x'.repeat(1000) + 'SCENE_TAIL' },
      ],
      issues: [],
    };
    const h = hooks(),
      mainHooks = {
        ...h,

        authorize: () => {
          throw new Error('unused');
        },
        onInput: () => {},
        onToolEvent: () => {},
      } as MainHooks;
    const result = await prepareLoreSelection(value, mainHooks, {
      reserveCalls: 1,
      jev: {
        credential: h.credential,
        fetch: async (_url, init) => {
          const state = JSON.parse(String(init?.body)).state;
          expect(state.request).toBe('Native edited request');
          expect(state.conversation[0].text).toHaveLength(1000);
          expect(state.conversation[0].text).toContain('SCENE_TAIL');
          expect(state.conversation[0].text).not.toContain('OLD_PREFIX');
          expect(state.entries).toEqual([
            { id: 'mountain', title: 'Mountain', text: 'Evaluated mountain.' },
          ]);
          return response({ entry_0: 0.9 });
        },
      },
    });
    expect(result.snapshot.loreSelection!.entries[0].selected).toEqual(['mountain']);
  });
  it('fetches known ids together without search, scopes errors and returns independent provenance', () => {
    const value = snapshot();
    value.profile = undefined;
    value.resources = [
      {
        id: 'one',
        chatId: 'test',
        kind: 'lore',
        revision: 1,
        title: 'One',
        description: '',
        text: 'abcdefgh',
      },
      {
        id: 'private',
        chatId: 'other',
        kind: 'lore',
        revision: 1,
        title: 'Secret',
        description: '',
        text: 'SECRET',
      },
    ];
    const result = executeTool(value, {
      name: 'knowledge.read',
      callId: 'batch',
      args: { ids: ['one', 'private', 'missing'], limit: 3 },
    });
    expect(result.denied).toBe(false);
    expect(knowledgeReadResults(result)).toHaveLength(1);
    expect(knowledgeReadResults(result)[0]).toMatchObject({
      text: 'abc',
      range: { start: 0, end: 3 },
      source: { id: 'one' },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(
      MAIN_READ_TOOLS.find((tool) => tool.name === 'knowledge.read')?.inputSchema
    ).toHaveProperty('properties.ids');
    expect(
      executeTool(value, { name: 'knowledge.read', callId: 'bad', args: { ids: ['one', 'one'] } })
        .denied
    ).toBe(true);
  });
});

it.each([
  { error_type: 'max_tokens_exceeded' },
  { error: { error_type: 'max_tokens_exceeded' } },
  { detail: { error_type: 'max_tokens_exceeded' } },
])(
  'preserves an explicit provider input limit as JEV_INPUT_BUDGET without replay: %j',
  async (payload) => {
    const h = hooks();
    const send = vi.fn(async () => new Response(JSON.stringify(payload), { status: 400 }));
    await expect(
      executeJevJudgment(request, 'e'.repeat(64), null, { ...h, fetch: send })
    ).rejects.toThrow('JEV_INPUT_BUDGET');
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.onAttemptFinish).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: 'error',
        error: { code: 'JEV_INPUT_BUDGET' },
        usage: expect.objectContaining({ inputTokens: null }),
      })
    );
  }
);

describe('documented JEV input admission limits', () => {
  const sized = (count: number, copies = 1): JevRequest => ({
    state: { response: 'State' },
    questions: Object.fromEntries(
      Array.from({ length: copies }, (_, i) => [
        `question${i}`,
        { type: 'noul' as const, instructions: 'word '.repeat(count) },
      ])
    ),
  });
  const costs = (value: JevRequest) => {
    const state = estimateContextTokens(value.state);
    const questions = Object.values(value.questions).map(estimateContextTokens);
    return {
      longest: state + Math.max(...questions),
      total: state + questions.reduce((a, b) => a + b, 0),
    };
  };
  it.each(['longest', 'total'] as const)(
    'rejects the independent %s limit before credentials, attempts, or fetch',
    async (limit) => {
      const value = limit === 'longest' ? sized(30000) : sized(22000, 3);
      const cost = costs(value);
      expect(cost[limit]).toBeGreaterThan(limit === 'longest' ? 32000 : 64000);
      expect(cost[limit === 'longest' ? 'total' : 'longest']).toBeLessThan(
        limit === 'longest' ? 64000 : 32000
      );
      const h = hooks(),
        credential = vi.fn(() => 'test-key'),
        send = vi.fn();
      await expect(
        executeJevJudgment(value, 'f'.repeat(64), null, { ...h, credential, fetch: send })
      ).rejects.toThrow('JEV_INPUT_BUDGET');
      expect(credential).not.toHaveBeenCalled();
      expect(h.onAttemptStart).not.toHaveBeenCalled();
      expect(h.onAttemptFinish).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  );
  it('accepts the complete request just below the longest-question boundary and rejects its next increment', async () => {
    let low = 0,
      high = 32000;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (costs(sized(middle)).longest <= 32000) low = middle;
      else high = middle;
    }
    const value = sized(low);
    expect(costs(value).longest).toBeGreaterThanOrEqual(31998);
    const h = hooks(),
      send = vi.fn(async (_url: unknown, _init?: RequestInit) => response({ question0: 0.58 }));
    await expect(
      executeJevJudgment(value, 'f'.repeat(64), null, { ...h, fetch: send })
    ).resolves.toMatchObject({ scores: { question0: 0.58 } });
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject(value);
    const blocked = hooks(),
      blockedSend = vi.fn();
    await expect(
      executeJevJudgment(sized(high), 'f'.repeat(64), null, { ...blocked, fetch: blockedSend })
    ).rejects.toThrow('JEV_INPUT_BUDGET');
    expect(blockedSend).not.toHaveBeenCalled();
    expect(blocked.onAttemptStart).not.toHaveBeenCalled();
  });
  it('retains a narrower application input budget', async () => {
    const h = hooks(),
      send = vi.fn();
    await expect(
      executeJevJudgment(sized(1000), 'f'.repeat(64), 100, { ...h, fetch: send })
    ).rejects.toThrow('JEV_INPUT_BUDGET');
    expect(send).not.toHaveBeenCalled();
    expect(h.onAttemptStart).not.toHaveBeenCalled();
  });
});
