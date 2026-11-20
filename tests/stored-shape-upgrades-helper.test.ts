import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';

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

test('helper input limits come from the task snapshot and stored limits drop artifacts once', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-upgrade-'));
  const file = join(path, 'story.sqlite');
  const item: { store?: Store; path: string } = { store: new Store(file), path };
  owned.push(item);
  const workspace = new HelperWorkspace(item.store!);
  const conversation = workspace.open({ kind: 'library', workId: 'upgrade' });
  const enqueue = (key: string, model: object) =>
    workspace.enqueue(conversation.id, key, 'request', {
      scope: conversation.scope,
      model: model as never,
      history: [],
      persona: '',
      limits: { totalCalls: 3, helperCalls: 2 },
    });
  const limited = enqueue('limited', { inputTokenLimit: 64_000 });
  const unlimited = enqueue('unlimited', {});
  const db = () => item.store!.db;
  db()
    .prepare(
      `UPDATE helper_tasks SET snapshot=json_set(snapshot,'$.limits',json('{"totalCalls":3,"helperCalls":2,"artifacts":1}')) WHERE id=?`
    )
    .run(limited.id);
  db()
    .prepare('UPDATE helper_conversations SET limits=? WHERE id=?')
    .run('{"totalCalls":24,"helperCalls":12,"artifacts":7}', conversation.id);
  workspace.event(conversation.id, limited.id, 'input.measured', { estimatedInputTokens: 1 });
  workspace.event(conversation.id, limited.id, 'input.measured', {
    estimatedInputTokens: 2,
    inputTokenLimit: 32_000,
  });
  workspace.event(conversation.id, unlimited.id, 'input.measured', { estimatedInputTokens: 3 });
  const rows = () => ({
    events: db()
      .prepare(
        "SELECT seq,task_id,json(data) AS data FROM helper_events WHERE kind='input.measured' ORDER BY seq"
      )
      .all(),
    conversation: db()
      .prepare('SELECT revision,json(limits) AS limits FROM helper_conversations WHERE id=?')
      .get(conversation.id),
    snapshot: db()
      .prepare("SELECT json_extract(snapshot,'$.limits') AS limits FROM helper_tasks WHERE id=?")
      .get(limited.id),
  });
  const before = rows();
  const reopen = () => {
    item.store!.close();
    item.store = undefined;
    item.store = new Store(file);
  };

  reopen();
  const upgraded = rows();
  expect(upgraded.events.map((row) => JSON.parse(String(row.data)))).toEqual([
    { estimatedInputTokens: 1, inputTokenLimit: 64_000 },
    { estimatedInputTokens: 2, inputTokenLimit: 32_000 },
    { estimatedInputTokens: 3 },
  ]);
  expect(upgraded.events.slice(1)).toEqual(before.events.slice(1));
  expect(upgraded.conversation).toEqual({
    revision: before.conversation!.revision,
    limits: '{"totalCalls":24,"helperCalls":12}',
  });
  expect(upgraded.snapshot).toEqual({ limits: '{"totalCalls":3,"helperCalls":2}' });
  reopen();
  expect(rows()).toEqual(upgraded);
});
