import { expect, test, vi } from 'vitest';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { defaultProfile } from '../core/product.js';
import type { RisuLoreProjection } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import { estimateContextTokens } from '../core/context-budget.js';
import { prepareLoreSelection } from '../server/lore-selection.js';
import type { MainHooks } from '../server/model-runner.js';

const lore = (id: string, text: string, title = 'Archive'): RisuLoreProjection => ({
  id,
  title,
  text,
  description: '',
  loading: 'discoverable',
  folderId: 'records',
});
function snapshot(catalogs: RisuLoreProjection[][], request: string): RunSnapshot {
  return {
    chatId: 'retrieval',
    parentRevision: null,
    settingsRevision: 1,
    settings: { maxCalls: 2 },
    request,
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('retrieval'),
      models: {},
      loreContext: { ...DEFAULT_LORE_CONTEXT, judgment: { ...DEFAULT_LORE_CONTEXT.judgment } },
      packageAttachments: catalogs.map((_, index) => ({
        id: `card-${index}`,
        revision: 1,
        role: 'module',
      })),
      packages: catalogs.map((entries, index) => ({
        version: 2,
        id: `card-${index}`,
        revision: 1,
        title: 'Records',
        description: '',
        nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
        loreActivation: { mode: 'model' },
        loreFolders: [{ id: 'records', name: 'Records' }],
        lore: entries,
      })),
    },
  };
}
async function select(input: RunSnapshot) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: 'jev-latest',
        usage: { input_tokens: 100, output_tokens: 5 },
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key, index) => [
            key,
            {
              type: 'noul',
              noul: body.state.entries[index].text.includes('청월인장') ? 0.95 : 0.1,
            },
          ])
        ),
      })
    );
  });
  const hooks: MainHooks = {
    signal: new AbortController().signal,
    authorize: () => {
      throw new Error('No writing model in retrieval test');
    },
    onInput: vi.fn(),
    onToolEvent: vi.fn(),
    onAttemptStart: vi.fn(() => 'retrieval-attempt'),
    onAttemptFinish: vi.fn(),
  };
  const result = await prepareLoreSelection(input, hooks, {
    reserveCalls: 1,
    jev: { credential: () => 'synthetic-key', fetch },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
  expect(estimateContextTokens(body)).toBeLessThanOrEqual(
    input.profile!.loreContext!.judgment.maxInputTokens
  );
  expect(result.usage.modelCalls).toBe(1);
  return { ...result, body };
}

test('finds the last folder lore by a short Korean name and late body fact without changing frozen input', async () => {
  const filler = 'The archives list ordinary weather and supplies. '.repeat(25);
  const entries = Array.from({ length: 1000 }, (_, index) => lore(`ordinary-${index}`, filler));
  entries.push(lore('late', `${filler}미카에게 맡긴 청월인장은 북쪽 탑에 숨겨져 있다.`));
  const input = snapshot([entries], '미카가 청월인장을 찾는다.');
  const before = structuredClone(input);
  const result = await select(input);
  expect(input).toEqual(before);
  expect(result.body.state.entries[0]).toMatchObject({ id: 'late', text: entries[1000].text });
  const receipt = result.snapshot.loreSelection!.entries[0];
  expect(receipt.selected).toEqual(['late']);
  expect(receipt.coverage).toEqual({ total: 1001, evaluated: result.body.state.entries.length });
  expect(receipt.coverage!.evaluated).toBeLessThan(1001);
  expect(receipt.partial).toBe('catalog');
  const judged = new Set(receipt.judgment!.scores.map((score) => score.id));
  expect(
    receipt.omitted.every((entry) => entry.reason !== 'irrelevant' || judged.has(entry.id))
  ).toBe(true);
});

test('searches later attached packages beyond the combined provider question limit', async () => {
  const filler = 'Ordinary stores record flour, rain and deliveries. '.repeat(25);
  const catalogs = [0, 1].map(() =>
    Array.from({ length: 1001 }, (_, index) => lore(`item-${index}`, filler))
  );
  catalogs[1][1000] = lore('late', `${filler}청월인장을 보관하는 탑의 기록.`);
  const input = snapshot(catalogs, '청월인장의 봉인을 조사한다.');
  const { snapshot: result, body } = await select(input);
  expect(body.state.entries[0].text).toContain('청월인장');
  expect(result.loreSelection!.entries.map((entry) => entry.selected)).toEqual([[], ['late']]);
  expect(result.loreSelection!.entries.map((entry) => entry.coverage!.total)).toEqual([1001, 1001]);
  expect(
    result.loreSelection!.entries.reduce((sum, entry) => sum + entry.coverage!.evaluated, 0)
  ).toBe(body.state.entries.length);
  expect(Object.keys(body.questions).length).toBeLessThanOrEqual(2000);
});

test('skips a relevant entry too large for the judgment request and still evaluates the next one', async () => {
  const input = snapshot(
    [
      [
        lore('large', '청월인장에 대한 기록. '.repeat(450), '청월인장'),
        lore('small', '청월인장은 탑에 숨겨져 있다.'),
      ],
    ],
    '청월인장을 찾아요.'
  );
  input.profile!.loreContext!.judgment.maxInputTokens = 1000;
  const { snapshot: result, body } = await select(input);
  expect(body.state.entries.map((entry: { id: string }) => entry.id)).toEqual(['small']);
  expect(result.loreSelection!.entries[0].selected).toEqual(['small']);
});
