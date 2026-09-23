import { expect, test, vi } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import type { MainHooks } from '../server/model-runner.js';
import { prepareLoreSelection } from '../server/lore-selection.js';
import { projectLoreSelectionReceipt } from '../core/lore-selection.js';
const snapshot = (): RunSnapshot => ({
  chatId: 'lore-test',
  parentRevision: null,
  settingsRevision: 1,
  settings: { status: false, maxCalls: 2 },
  request: 'Visit the harbor',
  history: [],
  resources: [],
  profile: {
    ...defaultProfile('lore-test'),
    models: {},
    packageAttachments: [{ id: 'card', revision: 1, role: 'bot' }],
    packages: [
      {
        version: 2,
        id: 'card',
        revision: 1,
        title: 'Card',
        description: '',
        nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
        loreActivation: { mode: 'model' },
        lore: [
          {
            id: 'harbor',
            title: 'Harbor',
            description: '',
            text: 'The harbor is open.',
            loading: 'discoverable',
          },
        ],
      },
    ],
  },
});
const hooks = (): MainHooks => ({
  signal: new AbortController().signal,

  authorize: vi.fn(() => {
    throw new Error('Generative fallback forbidden');
  }),
  onInput: vi.fn(),
  onToolEvent: vi.fn(),
  onAttemptStart: vi.fn(() => 'attempt'),
  onAttemptFinish: vi.fn(),
});
test('reserves the writer call and never substitutes the context model', async () => {
  const input = snapshot();
  input.settings.maxCalls = 1;
  const h = hooks(),
    fetch = vi.fn();
  const result = await prepareLoreSelection(input, h, {
    reserveCalls: 1,
    jev: { credential: () => 'key', fetch },
  });
  expect(result.usage.modelCalls).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(h.authorize).not.toHaveBeenCalled();
  expect(result.snapshot.loreSelection!.entries[0].error).toBe('LORE_SELECTION_CALL_LIMIT');
});
test('missing JEV credentials retain tool-discoverable lore with a failure receipt', async () => {
  const input = snapshot(),
    h = hooks(),
    fetch = vi.fn();
  const result = await prepareLoreSelection(input, h, {
    reserveCalls: 1,
    jev: { credential: () => undefined, fetch },
  });
  expect(result.snapshot.loreSelection!.entries[0]).toMatchObject({
    error: 'JEV_CREDENTIAL_REQUIRED',
    selected: [],
  });
  expect(projectLoreSelectionReceipt(result.snapshot.loreSelection!, 'card@1:bot')).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(h.authorize).not.toHaveBeenCalled();
  expect(result.usage.modelCalls).toBe(0);
});
test('an uncertain paid attempt is recorded once and replay never repeats it', async () => {
  const h = hooks(),
    fetch = vi.fn(async () => {
      throw new Error('connection lost');
    });
  const options = { reserveCalls: 1, jev: { credential: () => 'key', fetch } };
  const first = await prepareLoreSelection(snapshot(), h, options);
  expect(first.usage.modelCalls).toBe(1);
  expect(first.usage.inputTokens).toBeNull();
  expect(first.snapshot.loreSelection!.entries[0].error).toBe('JEV_EXECUTION_FAILED');
  const replay = await prepareLoreSelection(first.snapshot, h, options);
  expect(replay.snapshot).toEqual(first.snapshot);
  expect(replay.usage.modelCalls).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(h.onAttemptFinish).toHaveBeenCalledTimes(1);
  expect(h.authorize).not.toHaveBeenCalled();
});
test('authored openings and tool-only lore never trigger relevance judgments', async () => {
  const input = snapshot();
  input.profile!.packages![0].loreActivation = { mode: 'discoverable' };
  const h = hooks(),
    fetch = vi.fn();
  const result = await prepareLoreSelection(input, h, {
    reserveCalls: 1,
    jev: { credential: () => 'key', fetch },
  });
  expect(result.snapshot.loreSelection).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
