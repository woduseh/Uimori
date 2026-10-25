import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { defaultProfile } from '../core/product.js';
import type { RisuLoreProjection } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import { contextBudgetForModel, estimateContextTokens } from '../core/context-budget.js';
import { compiledPackages } from '../core/package-context.js';
import { countTextTokens } from '../core/text-tokens.js';
import {
  loreSelectionInputHash,
  loreSelectionTargets,
  prepareLoreSelection,
} from '../server/lore-selection.js';
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
function projectLore(input: RunSnapshot, catalogs: RisuLoreProjection[][]) {
  const attachment = input.profile!.packageAttachments![0];
  const pkg = input.profile!.packages![0];
  input.profile!.chatOverrides = {
    version: 1,
    revision: 1,
    roots: [],
    entries: [],
    headRevision: null,
    headHash: null,
    conflicts: [],
    projections: catalogs.map((entries, index) => ({
      scope: {
        id: 'root',
        role: index === 0 ? 'bot' : 'persona',
        modulePath: [pkg.id],
      },
      attachment,
      package: { ...pkg, lore: entries },
      overrideIds: [],
      conflicts: [],
    })),
  };
}
async function select(input: RunSnapshot, expectedCalls = 1) {
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
              noul: JSON.stringify(body.state.entries[index]).includes('청월인장') ? 0.95 : 0.1,
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
  expect(fetch).toHaveBeenCalledTimes(expectedCalls);
  const body = expectedCalls ? JSON.parse(String(fetch.mock.calls[0][1]?.body)) : undefined;
  if (body)
    expect(estimateContextTokens(body)).toBeLessThanOrEqual(
      input.profile!.loreContext!.judgment.maxInputTokens
    );
  expect(result.usage.modelCalls).toBe(expectedCalls);
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

test('shortlists lore named only in the derived summary when the catalog exceeds the JEV budget', async () => {
  const filler = 'Ordinary stores record flour, rain and deliveries. '.repeat(25);
  const entries = Array.from({ length: 1000 }, (_, index) => lore(`ordinary-${index}`, filler));
  entries.push(lore('zz-summary', `${filler}청월인장을 보관하는 탑의 기록.`));
  const input = snapshot([entries], '계속');
  input.contextPlan = {
    version: 1,
    status: 'ready',
    budget: contextBudgetForModel({ modelId: 'fixture' }),
    dependencyKey: '',
    estimatedInputTokens: 100,
    compacted: [],
    recentSourceRevisions: [],
    summary: '청월인장을 찾으러 북쪽 탑에 도착했다.',
    summaryCalls: 0,
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    error: null,
  };
  const result = await select(input);
  expect(result.snapshot.loreSelection!.entries[0].selected).toEqual(['zz-summary']);
  expect(result.body.state.entries[0].id).toBe('zz-summary');
  expect(result.body.state.summary.text).toBe(input.contextPlan.summary);
  expect(result.snapshot.loreSelection!.entries[0].partial).toBe('catalog');
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

test.each(['title', 'description'] as const)(
  'retrieves frozen chat-overridden %s within a narrow JEV budget',
  async (field) => {
    const filler = 'Ordinary weather, flour, rain and deliveries. '.repeat(50);
    const entries = [lore('first', filler), lore('target', filler)];
    const input = snapshot([entries], '청월인장');
    input.profile!.loreContext!.judgment.maxInputTokens = 1000;
    projectLore(input, [[entries[0], { ...entries[1], [field]: '청월인장' }]]);
    const before = structuredClone(input);
    const { snapshot: result, body } = await select(input);
    expect(body.state.entries.map((entry: { id: string }) => entry.id)).toEqual(['target']);
    expect(JSON.stringify(body.state.entries[0])).toContain('청월인장');
    expect(result.loreSelection!.entries[0].selected).toEqual(['target']);
    expect(result.loreSelection!.entries[0].coverage).toEqual({ total: 2, evaluated: 1 });
    expect(input).toEqual(before);
  }
);

test('searches and judges every scoped body sharing one selected lore id', async () => {
  const filler = 'Ordinary weather, flour, rain and deliveries. '.repeat(120);
  const ordinary = lore('ordinary', filler);
  const fact = lore('fact', filler);
  const input = snapshot([[ordinary, fact]], '청월인장');
  input.profile!.loreContext!.judgment.maxInputTokens = 1000;
  projectLore(input, [
    [ordinary, { ...fact, text: 'Ordinary weather.' }],
    [ordinary, { ...fact, text: 'Hidden 청월인장 is kept at the north tower.' }],
  ]);
  const { snapshot: result, body } = await select(input);
  expect(body.state.entries[0].id).toBe('fact');
  const sent = JSON.stringify(body.state.entries[0]);
  expect(sent).toContain('Ordinary weather.');
  expect(sent).toContain('Hidden 청월인장 is kept at the north tower.');
  expect(result.loreSelection!.entries[0].selected).toEqual(['fact']);
  expect(compiledPackages(result, 'main')[0].selectedLore.map((entry) => entry.text)).toEqual([
    'Ordinary weather.',
    'Hidden 청월인장 is kept at the north tower.',
  ]);
});

test('budgets all scoped admitted bodies before a paid judgment and records their actual token sum', async () => {
  const fact = lore('fact', 'Original record.');
  const input = snapshot([[fact]], '청월인장');
  projectLore(input, [
    [{ ...fact, text: '청월인장' }],
    [{ ...fact, text: '청월인장 '.repeat(1000) }],
  ]);
  input.profile!.loreContext!.maxRetainedTokens = 100;
  input.profile!.loreContext!.judgment.maxSelectedTokens = 100;
  const rejected = await select(input, 0);
  expect(rejected.snapshot.loreSelection!.entries[0]).toMatchObject({
    selected: [],
    omitted: [{ id: 'fact', reason: 'budget' }],
    coverage: { total: 1, evaluated: 0 },
  });
  input.profile!.loreContext!.maxRetainedTokens = 5000;
  input.profile!.loreContext!.judgment.maxSelectedTokens = 5000;
  const accepted = await select(input);
  const receipt = accepted.snapshot.loreSelection!.entries[0];
  const pinned = compiledPackages(accepted.snapshot, 'main')[0].selectedLore;
  expect(pinned).toHaveLength(2);
  const tokens = pinned.reduce((sum, entry) => sum + countTextTokens(entry.text), 0);
  expect(tokens).toBeGreaterThan(100);
  expect(receipt.selected).toEqual(['fact']);
  expect(receipt.judgment!.selectedTokens).toBe(tokens);
});

test('counts equal bodies twice when distinct scoped metadata makes both bodies admitted', async () => {
  const fact = lore('fact', '청월인장');
  const input = snapshot([[fact]], '청월인장');
  projectLore(input, [[{ ...fact, title: 'Bot record' }], [{ ...fact, title: 'Persona record' }]]);
  const singleBodyTokens = countTextTokens(fact.text);
  input.profile!.loreContext!.maxRetainedTokens = singleBodyTokens;
  input.profile!.loreContext!.judgment.maxSelectedTokens = singleBodyTokens;
  const rejected = await select(input, 0);
  expect(rejected.snapshot.loreSelection!.entries[0].selected).toEqual([]);
  input.profile!.loreContext!.maxRetainedTokens = singleBodyTokens * 2;
  input.profile!.loreContext!.judgment.maxSelectedTokens = singleBodyTokens * 2;
  const accepted = await select(input);
  const pinned = compiledPackages(accepted.snapshot, 'main')[0].selectedLore;
  expect(pinned.map((entry) => entry.text)).toEqual([fact.text, fact.text]);
  expect(accepted.snapshot.loreSelection!.entries[0].judgment!.selectedTokens).toBe(
    singleBodyTokens * 2
  );
});

test.each(['title', 'description', 'text'] as const)(
  'binds the selection input hash to a nonfirst scoped %s',
  (field) => {
    const fact = lore('fact', 'Original record.');
    const input = snapshot([[fact]], '청월인장');
    projectLore(input, [[{ ...fact, text: 'First connection.' }], [{ ...fact }]]);
    const before = loreSelectionInputHash(loreSelectionTargets(input)[0]);
    input.profile!.chatOverrides!.projections[1].package.lore[0][field] = 'Changed 청월인장';
    expect(loreSelectionInputHash(loreSelectionTargets(input)[0])).not.toBe(before);
  }
);

test('skips only fully retained identical scoped bodies and charges all retained bodies against new admission', async () => {
  const fact = lore('fact', '청월인장');
  const input = snapshot([[fact]], '청월인장');
  projectLore(input, [[{ ...fact, title: 'First scope' }], [{ ...fact, title: 'Second scope' }]]);
  const parts = compiledPackages(input, 'main')[0].resources;
  const entries = parts.map((part) => ({
    id: part.id,
    revision: part.revision,
    hash: createHash('sha256').update(part.text).digest('hex'),
    title: part.title,
    start: 0,
    end: part.text.length,
    text: part.text,
    retention: 'selection' as const,
    origin: {
      sourceRevision: 'old',
      sourceHash: 'a'.repeat(64),
      runId: 'old-run',
      callId: 'selection',
    },
    lastUsed: 'old',
  }));
  input.loreContext = {
    version: 1,
    policy: input.profile!.loreContext!,
    canonHash: '',
    dependencies: [],
    entries,
    stats: {
      retainedChars: 0,
      retainedTokens: 0,
      retainedEntries: entries.length,
      appendedChars: 0,
      droppedEntries: 0,
      reasons: [],
    },
  };
  const carried = await select(input, 0);
  expect(carried.snapshot.loreSelection!.entries[0].coverage).toEqual({ total: 0, evaluated: 0 });
  input.profile!.chatOverrides!.projections[1].package.lore[0].text = 'Changed 청월인장';
  const changed = await select(input);
  expect(changed.body.state.entries[0].text).toContain('Changed 청월인장');
  expect(changed.body.state.entries[0].text).toContain(fact.text);
  input.profile!.loreContext!.maxRetainedTokens = entries.reduce(
    (sum, entry) => sum + countTextTokens(entry.text),
    0
  );
  const full = await select(input, 0);
  expect(full.snapshot.loreSelection!.entries[0].omitted).toEqual([
    { id: 'fact', reason: 'budget' },
  ]);
});

test('reuses a frozen older selection receipt without another paid judgment', async () => {
  const input = snapshot([[lore('fact', '청월인장')]], '청월인장');
  input.loreSelection = {
    version: 1,
    entries: [
      {
        key: 'card-0@1:module',
        inputHash: 'b'.repeat(64),
        budget: 16000,
        selected: ['fact'],
        omitted: [],
        model: 'jev-latest',
      },
    ],
  };
  const before = structuredClone(input);
  const result = await select(input, 0);
  expect(result.snapshot).toEqual(before);
  expect(
    compiledPackages(result.snapshot, 'main')[0].selectedLore.map((entry) => entry.text)
  ).toEqual(['청월인장']);
});
