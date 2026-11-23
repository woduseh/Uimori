import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test, vi } from 'vitest';
import type { RunSnapshot } from '../core/types.js';
import {
  buildPackagePresentation,
  clearPackagePresentationRenderCache,
} from '../server/package-presentation.js';
import { recordNativeRisuEntropy } from '../server/risu-native-entropy.js';

const state = vi.hoisted(() => ({
  log: [] as string[],
  created: 0,
  closed: 0,
  native: true,
  failHook: '',
  failRender: '',
  context: { native: {}, messages: [], variables: {} } as Record<string, unknown>,
}));
vi.mock('../server/risu-native-context.js', () => ({
  nativeRisuContext: () => (state.native ? structuredClone(state.context) : undefined),
}));
vi.mock('../server/risu-native-runtime.js', () => ({
  executeRisuNative: async ({ text }: { text: string }) => {
    state.log.push(`hook:${text}`);
    if (state.failHook === text) throw new Error('hook failed');
    if (text.includes('random')) recordNativeRisuEntropy();
    return { text, variables: {}, warnings: [] };
  },
}));
vi.mock('../server/risu-native-worker.js', () => ({
  createNativeRisuWorkerSession: () => {
    state.created++;
    return {
      run: async ({ text }: { text: string }) => {
        state.log.push(`render:${text}`);
        if (state.failRender === text) throw new Error('render failed');
        return { html: `<p>${text}</p>`, css: '', issues: [] };
      },
      close: async () => {
        state.closed++;
      },
    };
  },
}));
afterEach(() => {
  clearPackagePresentationRenderCache();
  Object.assign(state, {
    log: [],
    created: 0,
    closed: 0,
    native: true,
    failHook: '',
    failRender: '',
    context: { native: {}, messages: [], variables: {} },
  });
});
function fixture() {
  const snapshot = {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { maxCalls: 8 },
    request: 'request',
    history: [],
    resources: [],
  } satisfies RunSnapshot;
  const hash = createHash('sha256').update('original').digest('hex');
  const source = {
    id: 'source',
    chatId: 'chat',
    text: 'original',
    hash,
    translation: { text: 'translated', sourceRevision: 'source', sourceHash: hash },
  };
  const options = {
    nativeMessages: [
      { text: 'original', index: 0, role: 'assistant' as const, primary: true },
      { text: 'extra', index: 1, role: 'user' as const, primary: false },
    ],
  };
  return { snapshot, source, options };
}

test('one presentation preserves hook/render order, extra messages and primary-only translation', async () => {
  const { snapshot, source, options } = fixture();
  const result = await buildPackagePresentation(snapshot, source, options);
  assert.deepEqual(state.log, [
    'hook:original',
    'render:original',
    'hook:extra',
    'render:extra',
    'hook:translated',
    'render:translated',
  ]);
  assert.equal(state.created, 1);
  assert.equal(state.closed, 1);
  assert.ok(result.format === 'risu-html');
  assert.ok(result.original.html!.includes('<p>extra</p>'));
  assert.ok(result.translation!.html!.includes('<p>extra</p>'));
  assert.ok(result.translation!.html!.includes('<p>translated</p>'));
});

test('both hook and renderer failures close their request-owned worker', async () => {
  const { snapshot, source, options } = fixture();
  state.failHook = 'extra';
  await assert.rejects(buildPackagePresentation(snapshot, source, options), /hook failed/u);
  assert.equal(state.created, 1);
  assert.equal(state.closed, 1);
  state.failHook = '';
  state.failRender = 'translated';
  await assert.rejects(buildPackagePresentation(snapshot, source, options), /render failed/u);
  assert.equal(state.created, 2);
  assert.equal(state.closed, 2);
});

test('plain text creates no worker and invalid source identity is still rejected', async () => {
  const { snapshot, source } = fixture();
  state.native = false;
  const result = await buildPackagePresentation(snapshot, source);
  assert.equal(result.format, 'plain-text');
  assert.equal(state.created, 0);
  await assert.rejects(
    buildPackagePresentation(snapshot, { ...source, hash: 'bad' }),
    /PACKAGE_PRESENTATION_SOURCE_MISMATCH/u
  );
});

test('native display replaces only primary story blocks while preserving the source and other HTML', async () => {
  const { snapshot } = fixture();
  const text =
    '<style>.panel{color:red}</style>\n<div class="panel">상태</div>\n\n```uimori-ui\ninvalid\n```\n\n끝';
  const hash = createHash('sha256').update(text).digest('hex');
  const source = { id: 'source', chatId: 'chat', text, hash };
  const result = await buildPackagePresentation(snapshot, source);
  assert.equal(result.sourceHash, hash);
  assert.equal(result.original.text, text);
  assert.equal(state.log[0], `hook:${text}`);
  assert.match(state.log[1]!, /<div data-uimori-story-ui=0><\/div>/u);
  assert.doesNotMatch(state.log[1]!, /```uimori-ui/u);
  assert.match(state.log[1]!, /<style>\.panel\{color:red\}<\/style>/u);
  assert.match(state.log[1]!, /<div class="panel">상태<\/div>/u);
});

test('a deterministic display is served from cache with identical output and no worker', async () => {
  const { snapshot, source, options } = fixture();
  const first = await buildPackagePresentation(snapshot, source, options);
  state.log = [];
  const second = await buildPackagePresentation(snapshot, source, options);
  assert.deepEqual(state.log, []);
  assert.equal(state.created, 1);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('a display that drew random numbers is recomputed every time', async () => {
  const { snapshot } = fixture();
  const text = 'random scene';
  const source = {
    id: 'source',
    chatId: 'chat',
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  await buildPackagePresentation(snapshot, source);
  await buildPackagePresentation(snapshot, source);
  assert.deepEqual(state.log, [`hook:${text}`, `render:${text}`, `hook:${text}`, `render:${text}`]);
});

test('translation, variables, card revision and viewport each miss the cache', async () => {
  const { snapshot, source, options } = fixture();
  await buildPackagePresentation(snapshot, source, options);
  const hooks = () => state.log.filter((entry) => entry.startsWith('hook:'));
  const misses = async (change: () => Promise<unknown>, expected: string[]) => {
    state.log = [];
    await change();
    assert.deepEqual(hooks(), expected);
  };
  await misses(
    () =>
      buildPackagePresentation(
        snapshot,
        { ...source, translation: { ...source.translation, text: 'retranslated' } },
        options
      ),
    ['hook:retranslated']
  );
  state.context = { native: {}, messages: [], variables: { mood: 'tense' } };
  await misses(
    () => buildPackagePresentation(snapshot, source, options),
    ['hook:original', 'hook:extra', 'hook:translated']
  );
  state.context = { native: { sourceHash: 'card-2' }, messages: [], variables: { mood: 'tense' } };
  await misses(
    () => buildPackagePresentation(snapshot, source, options),
    ['hook:original', 'hook:extra', 'hook:translated']
  );
  await misses(
    () =>
      buildPackagePresentation(snapshot, source, {
        ...options,
        viewport: { width: 390, height: 844 },
      }),
    ['hook:original', 'hook:extra', 'hook:translated']
  );
  await misses(() => buildPackagePresentation(snapshot, source, options), []);
});
