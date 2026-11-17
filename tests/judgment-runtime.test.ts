import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { judgmentRuntime } from '../server/judgment-runtime.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const within = relative(tmpdir(), directory);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-judgment-runtime-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selected connection supplies its own key and a captured runtime loses authority after disabling', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-judgment-runtime-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  const connection = store.product.connection({
    title: 'Decisions',
    protocol: 'openai-responses-v1',
    endpoint: 'https://api.openai.com/v1///',
    apiKey: 'selected-secret',
    enabled: true,
  });
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: current.routes,
    translationPolicy: current.translationPolicy,
    judgment: {
      provider: 'openai',
      connectionId: connection.id,
      modelId: 'gpt-6-luna',
      images: false,
    },
  });
  const runtime = judgmentRuntime(store, () => 'legacy-secret');
  expect(runtime.target).toMatchObject({
    provider: 'openai',
    connectionId: connection.id,
    endpoint: 'https://api.openai.com/v1/decisions',
  });
  expect(await runtime.credential?.()).toBe('selected-secret');
  store.product.connection(
    {
      title: connection.title,
      protocol: connection.protocol,
      endpoint: connection.endpoint,
      credentialRef: connection.credentialRef,
      enabled: false,
      expectedRevision: connection.revision,
    },
    connection.id
  );
  expect(() => runtime.credential?.()).toThrow('JUDGMENT_CONNECTION_UNAVAILABLE');
});

test('a selected connection without a key does not fall back to the legacy key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-judgment-runtime-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  const connection = store.product.connection({
    title: 'Gateway',
    protocol: 'openai-chat-v1',
    endpoint: 'https://example.test/v1',
    enabled: true,
  });
  const current = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: current.revision,
    routes: current.routes,
    translationPolicy: current.translationPolicy,
    judgment: {
      provider: 'openai-compatible',
      connectionId: connection.id,
      modelId: 'judge',
      images: false,
    },
  });
  const runtime = judgmentRuntime(store, () => 'legacy-secret');
  expect(runtime.target?.provider).toBe('openai-compatible');
  expect(await runtime.credential?.()).toBeUndefined();
});
