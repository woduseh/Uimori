import { expect, test } from 'vitest';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createTestDirectory } from './fixtures/test-directory.js';
import {
  modelWorkspace,
  promptWorkspace,
  updateModelWorkspace,
} from '../server/prompt-workspace.js';

test('legacy workspaces read as JEV, and external choices round-trip without changing generation routes', () => {
  const directory = createTestDirectory('uimori-judgment-provider-');
  const store = new Store(join(directory.directory, 'data.sqlite'));
  try {
    const legacy = store.db
      .prepare("UPDATE prompt_workspace SET body=json_remove(body, '$.judgment') WHERE id=1")
      .run();
    expect(legacy.changes).toBe(1);
    const original = modelWorkspace(store);
    expect(original.judgment).toEqual({ provider: 'typesafe' });

    const connection = store.product.connection({
      title: 'Synthetic official OpenAI connection',
      protocol: 'openai-responses-v1',
      endpoint: 'https://api.openai.com/v1/',
      enabled: true,
    });
    const selection = {
      provider: 'openai',
      connectionId: connection.id,
      modelId: 'gpt-6-luna',
      images: false,
    };
    const patch = {
      expectedRevision: original.revision,
      routes: original.routes,
      translationPolicy: original.translationPolicy,
    };

    const accepted = updateModelWorkspace(store, { ...patch, judgment: selection });
    expect(modelWorkspace(store)).toEqual({
      ...original,
      revision: original.revision + 1,
      judgment: selection,
    });
    expect(promptWorkspace(store).judgment).toEqual(selection);
    expect(() =>
      updateModelWorkspace(store, { ...patch, judgment: { provider: 'typesafe' } })
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
    store.product.connection(
      {
        title: connection.title,
        endpoint: connection.endpoint,
        protocol: connection.protocol,
        enabled: false,
        expectedRevision: connection.revision,
      },
      connection.id
    );
    expect(
      updateModelWorkspace(store, {
        ...patch,
        expectedRevision: accepted.revision,
        judgment: selection,
        mainJudgmentEnabled: true,
      })
    ).toMatchObject({ judgment: selection, mainJudgmentEnabled: true });
    expect(
      updateModelWorkspace(store, { ...patch, expectedRevision: accepted.revision + 1 }).judgment
    ).toEqual(selection);
  } finally {
    store.close();
    directory.remove();
  }
});

test('official judgment selections reject the wrong destination, protocol, model, and disabled connections', () => {
  const directory = createTestDirectory('uimori-judgment-provider-');
  const store = new Store(join(directory.directory, 'data.sqlite'));
  try {
    const create = (endpoint: string, enabled = true) =>
      store.product.connection({
        title: endpoint,
        protocol: 'openai-chat-v1',
        endpoint,
        enabled,
      });
    const official = create('https://api.openai.com/v1');
    const gateway = create('https://openrouter.ai/api/v1');
    const disabled = create('https://api.openai.com/v1', false);
    const original = modelWorkspace(store);
    const patch = {
      expectedRevision: original.revision,
      routes: original.routes,
      translationPolicy: original.translationPolicy,
    };
    const selection = {
      provider: 'openai',
      connectionId: official.id,
      modelId: 'gpt-6-luna',
      images: false,
    };
    for (const invalid of [
      { ...selection, connectionId: gateway.id },
      { ...selection, connectionId: disabled.id },
      { ...selection, connectionId: 'unknown-connection' },
      { ...selection, provider: 'gemini', modelId: 'gemini-decision-1' },
    ])
      expect(() => updateModelWorkspace(store, { ...patch, judgment: invalid })).toThrow(
        'JUDGMENT_CONNECTION_INVALID'
      );
    expect(() =>
      updateModelWorkspace(store, { ...patch, judgment: { ...selection, modelId: 'other' } })
    ).toThrow('JUDGMENT_MODEL_INVALID');
    expect(modelWorkspace(store)).toEqual(original);
  } finally {
    store.close();
    directory.remove();
  }
});
