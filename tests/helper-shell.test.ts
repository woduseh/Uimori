import { afterEach, expect, test, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { HelperShell } from '../server/helper-shell.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { editableResource, type ContentEditModel } from '../core/resource-editing.js';
import { readResource, saveResource } from '../server/resource-service.js';
import type { Content } from '../core/product.js';

const owned: { dir: string; store: Store; shell: HelperShell; child: ChildProcess }[] = [];
afterEach(() => {
  for (const { dir, store, shell, child } of owned.splice(0)) {
    shell.close();
    child.kill();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-shell-'));
  const root = join(dir, 'shared');
  vi.stubEnv('UIMORI_SHELL_ROOT', root);
  const child = spawn(process.execPath, [resolve('runner/runner.mjs')], {
    env: { ...process.env, UIMORI_SHELL_ROOT: root },
    stdio: 'ignore',
  });
  const store = new Store(join(dir, 'test.sqlite'));
  const workspace = new HelperWorkspace(store);
  const shell = new HelperShell(store, workspace);
  owned.push({ dir, store, shell, child });
  const resource = store.product.content(fixtureBotInput('Runner fixture', 'Original lore'));
  const connection = store.product.connection({
    title: 'Local test',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Local test',
    connectionId: connection.id,
    modelId: 'fixture-shell',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const conversation = workspace.open({ kind: 'library', workId: 'shell-fixture' });
  const task = workspace.enqueue(conversation.id, 'shell-task', 'Inspect and edit', {
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { helperCalls: 12, totalCalls: 24 },
  });
  workspace.start(task.id, 'shell-fixture');
  for (let i = 0; i < 80 && !existsSync(join(root, '.exec.sock')); i++) await delay(50);
  if (!existsSync(join(root, '.exec.sock'))) throw new Error('Runner socket not ready');
  return { store, workspace, shell, task: workspace.task(task.id), resource, root };
}

test('shell finds resources and applies canonical changes through existing saves', async () => {
  const f = await fixture();
  const file = `library/${f.resource.id}/resource.json`;
  const read = await f.shell.exec(
    f.task,
    'read',
    `grep -n 'Original lore' ${file} | head -2`,
    5000
  );
  expect(read.exitCode).toBe(0);
  expect(read.output).toContain('Original lore');
  expect(read.applied).toEqual([]);

  const script = `python3 - <<'PY'
import json
from pathlib import Path
p=Path('${file}')
data=json.loads(p.read_text())
data['package']['nativeRisu']['card']['creator_notes']='Updated by Linux'
p.write_text(json.dumps(data,ensure_ascii=False)+'\\n')
PY
node ${resolve('runner/uimori.mjs')} apply ${file}`;
  const updated = await f.shell.exec(f.task, 'write', script, 5000);
  expect(updated.exitCode).toBe(0);
  expect(updated.applied).toEqual([expect.objectContaining({ path: file, changed: true })]);
  expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
    'Updated by Linux'
  );
  expect(
    f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(f.task.id)?.n
  ).toBe(1);
  expect(
    JSON.parse(readFileSync(join(f.root, 'tasks', f.task.id, file), 'utf8')).package.nativeRisu.card
      .creator_notes
  ).toBe('Updated by Linux');
});

test('external revision change rejects stale shell edits instead of overwriting', async () => {
  const f = await fixture();
  const file = `library/${f.resource.id}/resource.json`;
  await f.shell.exec(f.task, 'read', 'cat INDEX.md | head -3', 5000);
  const latest = readResource(f.store, 'content', f.resource.id) as Content;
  const model = editableResource('content', latest) as ContentEditModel;
  model.package.nativeRisu.card.creator_notes = 'External change';
  saveResource(f.store, {
    kind: 'content',
    id: latest.id,
    expectedRevision: latest.revision,
    model,
  });
  const result = await f.shell.exec(
    f.task,
    'stale',
    `python3 -c "import json; p='${file}'; x=json.load(open(p)); x['package']['nativeRisu']['card']['creator_notes']='Stale'; open(p,'w').write(json.dumps(x))"; node ${resolve('runner/uimori.mjs')} apply ${file}`,
    5000
  );
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('변경');
  expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
    'External change'
  );
});

test('native Linux text edits apply to saved scenes and retain edit revisions', async () => {
  const f = await fixture();
  const chat = createFixtureChat(f.store, 'Shell scene');
  const source = completedSource(f.store, chat.id, 'Initial scene narrative');
  const file = `chats/${chat.id}/scenes/${source.id}.txt`;
  const command = `printf '%s' 'Edited scene narrative' > ${file}; node ${resolve('runner/uimori.mjs')} apply ${file}`;
  const result = await f.shell.exec(f.task, 'scene', command, 5000);
  expect(result.exitCode).toBe(0);
  expect(result.applied).toEqual([expect.objectContaining({ path: file, changed: true })]);
  const saved = f.store.source(source.id);
  expect(saved.text).toBe('Edited scene narrative');
  expect(saved.editRevision).toBe(1);
});
