import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test, vi } from 'vitest';
import type { RunSnapshot } from '../core/types.js';
import { buildPackagePresentation } from '../server/package-presentation.js';

const state = vi.hoisted(() => ({
  log: [] as string[],
  created: 0,
  closed: 0,
  native: true,
  failHook: '',
  failRender: '',
}));
vi.mock('../server/risu-native-context.js', () => ({
  nativeRisuContext: () => (state.native ? { native: {}, messages: [], variables: {} } : undefined),
}));
vi.mock('../server/risu-native-runtime.js', () => ({
  executeRisuNative: async ({ text }: { text: string }) => {
    state.log.push(`hook:${text}`);
    if (state.failHook === text) throw new Error('hook failed');
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
  Object.assign(state, {
    log: [],
    created: 0,
    closed: 0,
    native: true,
    failHook: '',
    failRender: '',
  });
});
function fixture() {
  const snapshot = {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 8 },
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
  const result = await buildPackagePresentation(snapshot, source, undefined, options);
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
  await assert.rejects(
    buildPackagePresentation(snapshot, source, undefined, options),
    /hook failed/u
  );
  assert.equal(state.created, 1);
  assert.equal(state.closed, 1);
  state.failHook = '';
  state.failRender = 'translated';
  await assert.rejects(
    buildPackagePresentation(snapshot, source, undefined, options),
    /render failed/u
  );
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
