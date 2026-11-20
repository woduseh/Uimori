import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { defaultEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { Connection, ModelPreset } from '../core/product.js';

const owned: { store?: Store; path: string }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const within = relative(tmpdir(), item.path);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-upgrade-'))
      throw new Error('Unsafe cleanup');
    rmSync(item.path, { recursive: true, force: true });
  }
});

test('retired evaluation controls are removed from stored model presets once', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-upgrade-'));
  const file = join(path, 'story.sqlite');
  const item: { store?: Store; path: string } = { store: new Store(file), path };
  owned.push(item);
  const connection = item.store!.product.connection({
    title: 'Synthetic',
    protocol: 'openai-responses-v1',
    endpoint: 'https://api.openai.com/v1',
    enabled: true,
    credentialRef: 'My_Gateway_Key',
  }) as Connection;
  const model = item.store!.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'synthetic-model',
    maxOutputTokens: 8192,
    temperature: null,
    evaluationTools: defaultEvaluationToolOptions(),
  }) as ModelPreset;
  const current = item.store!.product.model({
    title: 'Current',
    connectionId: connection.id,
    modelId: 'synthetic-model',
    maxOutputTokens: 8192,
    temperature: null,
    evaluationTools: defaultEvaluationToolOptions(),
  }) as ModelPreset;
  item.store!.db.prepare("UPDATE provider_settings SET body=? WHERE kind='model' AND id=?").run(
    JSON.stringify({
      ...model,
      evaluationTools: {
        ...model.evaluationTools,
        maximumToolRounds: 3,
        terminalLateCorrections: true,
        outputRecovery: false,
      },
    }),
    model.id
  );
  const rows = () =>
    item
      .store!.db.prepare(
        "SELECT id,revision,body FROM provider_settings WHERE kind='model' ORDER BY id"
      )
      .all()
      .map((row) => ({ id: row.id, revision: row.revision, body: JSON.parse(String(row.body)) }));
  const reopen = () => {
    item.store!.close();
    item.store = undefined;
    item.store = new Store(file);
  };

  reopen();
  const upgraded = rows();
  expect(upgraded).toEqual(
    [
      { id: model.id, revision: model.revision, body: model },
      { id: current.id, revision: current.revision, body: current },
    ].sort((a, b) => (a.id < b.id ? -1 : 1))
  );
  reopen();
  expect(rows()).toEqual(upgraded);
});
