import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { HelperShell, HelperShellExecutionError } from '../server/helper-shell.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { updateSceneContext } from '../server/scene-context.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { editableResource, type ContentEditModel } from '../core/resource-editing.js';
import { readResource, saveResource } from '../server/resource-service.js';
import { retryRun } from '../server/run-retry.js';
import {
  applyHelperResourceMutation,
  lastHelperResourceEdit,
  undoHelperResourceEdit,
} from '../server/helper-resource-undo.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import type { Content } from '../core/product.js';

// Linux runner uses Unix sockets, which the Windows CI worker cannot create.
const linuxTest = process.platform === 'win32' ? test.skip : test;

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

function workspaceFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-shell-'));
  const root = join(dir, 'shared');
  vi.stubEnv('UIMORI_SHELL_ROOT', root);
  const store = new Store(join(dir, 'test.sqlite'));
  const workspace = new HelperWorkspace(store);
  const shell = new HelperShell(store, workspace);
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
  return { dir, store, workspace, shell, task: workspace.task(task.id), resource, root };
}

async function fixture() {
  const f = workspaceFixture();
  const child = spawn(process.execPath, [resolve('runner/runner.mjs')], {
    env: { ...process.env, UIMORI_SHELL_ROOT: f.root },
    stdio: 'ignore',
  });
  owned.push({ dir: f.dir, store: f.store, shell: f.shell, child });
  for (let i = 0; i < 80 && !existsSync(join(f.root, '.exec.sock')); i++) await delay(50);
  if (!existsSync(join(f.root, '.exec.sock'))) throw new Error('Runner socket not ready');
  return { ...f, child };
}

function exportData(shell: HelperShell, taskId: string, scope: 'library' | 'chats', id?: string) {
  return (
    shell as unknown as {
      exportData: (
        taskId: string,
        args: Record<string, unknown>
      ) => {
        exported: string[];
        reused: string[];
        count: number;
      };
    }
  ).exportData(taskId, { scope, ...(id ? { id } : { all: true }) });
}

async function prepareFiles(
  f: Awaited<ReturnType<typeof fixture>>,
  scope: 'library' | 'chats',
  id: string
) {
  const command = `node ${resolve('runner/uimori.mjs')} export '${JSON.stringify({ scope, id })}'`;
  const result = await f.shell.exec(f.task, `prepare-${scope}`, command, 5000);
  expect(result.exitCode).toBe(0);
}

test('an unavailable runner still exports current saved scene revisions and the frozen snapshot', async () => {
  const f = workspaceFixture();
  try {
    const chat = createFixtureChat(f.store, 'Exported story');
    const first = completedSource(f.store, chat.id, '첫 원문🙂');
    const second = completedSource(f.store, chat.id, '숨긴 장면');
    const third = completedSource(f.store, chat.id, '마지막 장면');
    updateSceneContext(f.store, second.id, { expectedRevision: 0, sceneEnabled: false });
    const conversation = f.workspace.open({ kind: 'chat', chatId: chat.id });
    const task = f.workspace.enqueue(conversation.id, 'export-snapshot', 'Review scenes', {
      ...f.task.snapshot,
      scope: conversation.scope,
      writing: helperWritingSnapshot(f.store, chat.id),
    });
    f.workspace.start(task.id, 'shell-fixture');
    f.store.editSource(first.id, { text: '중간 수정', expectedRevision: 0 });
    f.store.editSource(first.id, { text: '최신 원문🙂\n다음 줄', expectedRevision: 1 });
    await expect(f.shell.exec(f.workspace.task(task.id), 'export', 'true', 1000)).rejects.toThrow();
    exportData(f.shell, task.id, 'chats', chat.id);

    const base = join(f.root, 'tasks', task.id);
    const saved = JSON.parse(readFileSync(join(base, `chats/${chat.id}/scenes.json`), 'utf8'));
    expect(saved).toEqual([
      expect.objectContaining({
        sourceId: first.id,
        revision: 2,
        sceneNumber: 1,
        sceneEnabled: true,
      }),
      expect.objectContaining({
        sourceId: second.id,
        revision: 0,
        sceneNumber: null,
        sceneEnabled: false,
      }),
      expect.objectContaining({
        sourceId: third.id,
        revision: 0,
        sceneNumber: 2,
        sceneEnabled: true,
      }),
    ]);
    expect(readFileSync(join(base, saved[0].file), 'utf8')).toBe('최신 원문🙂\n다음 줄');
    expect(saved[0]).toMatchObject({
      charCount: '최신 원문🙂\n다음 줄'.length,
      byteCount: Buffer.byteLength('최신 원문🙂\n다음 줄'),
      preview: '최신 원문🙂 다음 줄',
    });
    expect(readFileSync(join(base, `current/scenes/${first.id}.txt`), 'utf8')).toBe('첫 원문🙂');
    expect(
      f.store.editSource(first.id, {
        text: '내보낸 revision으로 저장',
        expectedRevision: saved[0].revision,
      }).editRevision
    ).toBe(3);
    expect(() =>
      f.store.editSource(first.id, {
        text: '오래된 원문',
        expectedRevision: saved[0].revision,
      })
    ).toThrow('Source revision conflict');
  } finally {
    f.shell.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('batch scene projection refresh preserves drafts and writes each affected index once', async () => {
  const f = workspaceFixture();
  try {
    const chats = [
      createFixtureChat(f.store, 'First batch'),
      createFixtureChat(f.store, 'Second batch'),
    ];
    const groups = chats.map((chat) =>
      Array.from({ length: 8 }, (_, index) =>
        completedSource(f.store, chat.id, `${chat.title} original ${index}`)
      )
    );
    updateSceneContext(f.store, groups[0][1].id, { expectedRevision: 0, sceneEnabled: false });
    const conversation = f.workspace.open({ kind: 'chat', chatId: chats[0].id });
    const task = f.workspace.enqueue(conversation.id, 'batch-projection', 'Edit scenes', {
      ...f.task.snapshot,
      scope: conversation.scope,
      writing: helperWritingSnapshot(f.store, chats[0].id),
    });
    f.workspace.start(task.id, 'shell-fixture');
    await expect(f.shell.exec(f.workspace.task(task.id), 'export', 'true', 1000)).rejects.toThrow();
    exportData(f.shell, task.id, 'chats');

    const base = join(f.root, 'tasks', task.id);
    const file = (group: number, index: number) =>
      join(base, 'chats', chats[group].id, 'scenes', `${groups[group][index].id}.txt`);
    const index = (group: number) =>
      JSON.parse(readFileSync(join(base, 'chats', chats[group].id, 'scenes.json'), 'utf8')) as {
        sourceId: string;
        revision: number;
        sceneNumber: number | null;
        preview: string;
      }[];
    const internals = f.shell as unknown as {
      refresh: (taskId: string, path: string) => { latestPath: string };
      writeSceneIndex: (taskId: string, chatId: string, files: Map<string, unknown>) => void;
    };

    writeFileSync(file(0, 0), 'First local draft');
    writeFileSync(file(1, 1), 'Second local draft');
    f.store.editSource(groups[0][0].id, { text: 'First external revision', expectedRevision: 0 });
    const latest = internals.refresh(task.id, `chats/${chats[0].id}/scenes/${groups[0][0].id}.txt`);
    expect(latest.latestPath).toMatch(/^scratch\/refresh-.*\/scene\.txt$/u);

    for (const [group, sources] of groups.entries())
      for (const [position, source] of sources.entries())
        f.store.editSource(source.id, {
          text: `Saved ${group}:${position}`,
          expectedRevision: group === 0 && position === 0 ? 1 : 0,
        });

    const ids = groups.flat().map((source) => source.id);
    const indexWrites = vi.spyOn(internals, 'writeSceneIndex');
    f.shell.refreshAfterMutation(
      task.id,
      'scene.patchMany',
      { items: ids.map((sourceId) => ({ sourceId })) },
      { sourceIds: ids }
    );
    expect(indexWrites).toHaveBeenCalledTimes(2);
    expect(indexWrites.mock.calls.map((call) => call[1])).toEqual(chats.map((chat) => chat.id));
    expect(readFileSync(file(0, 0), 'utf8')).toBe('First local draft');
    expect(readFileSync(file(1, 1), 'utf8')).toBe('Second local draft');
    expect(readFileSync(join(base, latest.latestPath), 'utf8')).toBe('Saved 0:0');
    expect(readFileSync(file(0, 1), 'utf8')).toBe('Saved 0:1');
    expect(index(0)[0]).toMatchObject({ revision: 0, preview: 'First batch original 0' });
    expect(index(0)[1]).toMatchObject({ revision: 1, preview: 'Saved 0:1', sceneNumber: null });
    expect(index(1)[1]).toMatchObject({ revision: 0, preview: 'Second batch original 1' });
    expect(index(1)[2]).toMatchObject({ revision: 1, preview: 'Saved 1:2' });
    expect(readFileSync(join(base, 'current', 'scenes', `${groups[0][1].id}.txt`), 'utf8')).toBe(
      'First batch original 1'
    );

    const first = groups[0][2].id;
    const fails = groups[1][2].id;
    f.store.editSource(first, { text: 'Saved before projection error', expectedRevision: 1 });
    f.store.editSource(fails, { text: 'Saved but not projected', expectedRevision: 1 });
    const source = f.store.source.bind(f.store);
    const sourceRead = vi.spyOn(f.store, 'source').mockImplementation((id) => {
      if (id === fails) throw new Error('Projection source failed');
      return source(id);
    });
    expect(() =>
      f.shell.refreshAfterMutation(
        task.id,
        'scene.patchMany',
        { items: [{ sourceId: first }, { sourceId: fails }] },
        { sourceIds: [first, fails] }
      )
    ).toThrow('Projection source failed');
    sourceRead.mockRestore();
    expect(readFileSync(file(0, 2), 'utf8')).toBe('Saved before projection error');
    expect(index(0)[2]).toMatchObject({ revision: 2, preview: 'Saved before projection error' });
    expect(readFileSync(file(1, 2), 'utf8')).toBe('Saved 1:2');
    expect(index(1)[2]).toMatchObject({ revision: 1, preview: 'Saved 1:2' });
    expect(f.store.source(fails).text).toBe('Saved but not projected');

    f.store.editSource(first, { text: 'Saved before index error', expectedRevision: 2 });
    const firstIndex = join(base, 'chats', chats[0].id, 'scenes.json');
    rmSync(firstIndex);
    mkdirSync(firstIndex);
    expect(() =>
      f.shell.refreshAfterMutation(
        task.id,
        'scene.patchMany',
        { items: [{ sourceId: first }, { sourceId: fails }] },
        { sourceIds: [first, fails] }
      )
    ).toThrow();
    expect(readFileSync(file(0, 2), 'utf8')).toBe('Saved before index error');
    expect(readFileSync(file(1, 2), 'utf8')).toBe('Saved but not projected');
    expect(index(1)[2]).toMatchObject({ revision: 2, preview: 'Saved but not projected' });
  } finally {
    f.shell.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('portable apply retains its content-bound receipt and does not save twice', async () => {
  const f = workspaceFixture();
  try {
    await expect(f.shell.exec(f.task, 'export', 'true', 1000)).rejects.toThrow();
    exportData(f.shell, f.task.id, 'library', f.resource.id);
    const relative = `library/${f.resource.id}/resource.json`;
    const filename = join(f.root, 'tasks', f.task.id, relative);
    const model = JSON.parse(readFileSync(filename, 'utf8')) as ContentEditModel;
    model.package.nativeRisu.card.creator_notes = 'Saved once 🙂';
    const content = JSON.stringify(model);
    writeFileSync(filename, content);

    const toolId = 'portable-apply';
    const session = `${f.task.id}:${toolId}`;
    const internals = f.shell as unknown as {
      active: Map<string, unknown>;
      applied: Map<string, unknown[]>;
      apply: (
        taskId: string,
        toolId: string,
        path: string
      ) => {
        changed: boolean;
        receiptId?: string;
      };
    };
    internals.active.set(session, {
      controller: new AbortController(),
      sequence: 0,
      pending: new Set(),
    });
    internals.applied.set(session, []);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const expectedReceipt = `${f.task.id}:shell:${toolId}:${digest(relative)}:${f.resource.revision}:${digest(content)}`;
    const result = internals.apply(f.task.id, toolId, relative);
    expect(result).toMatchObject({ changed: true, receiptId: expectedReceipt });
    expect(internals.apply(f.task.id, toolId, relative)).toMatchObject({ changed: false });
    expect(internals.applied.get(session)).toHaveLength(1);
    expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
      'Saved once 🙂'
    );
    expect(
      f.store.db
        .prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?')
        .get(f.task.id)?.n
    ).toBe(1);
  } finally {
    f.shell.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('on-demand exports keep complete catalogs, live bases, frozen snapshots and drafts', async () => {
  const f = workspaceFixture();
  try {
    const other = f.store.product.content(fixtureBotInput('Unprepared', 'Other body'));
    const chats = [
      createFixtureChat(f.store, 'Selected chat'),
      createFixtureChat(f.store, 'Other chat'),
    ];
    const first = completedSource(f.store, chats[0].id, 'Frozen scene');
    completedSource(f.store, chats[1].id, 'Other story');
    const conversation = f.workspace.open({ kind: 'chat', chatId: chats[0].id });
    const task = f.workspace.enqueue(conversation.id, 'lazy-export', 'Inspect', {
      ...f.task.snapshot,
      scope: conversation.scope,
      writing: helperWritingSnapshot(f.store, chats[0].id),
    });
    f.workspace.start(task.id, 'shell-fixture');
    await expect(f.shell.exec(f.workspace.task(task.id), 'export', 'true', 1000)).rejects.toThrow();
    const base = join(f.root, 'tasks', task.id);
    const library = () =>
      readFileSync(join(base, 'library/index.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const chatIndex = () =>
      readFileSync(join(base, 'chats/index.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const resourceFile = join(base, 'library', f.resource.id, 'resource.json');
    const sceneFile = join(base, 'chats', chats[0].id, 'scenes', `${first.id}.txt`);
    expect(library()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.resource.id, materialized: false }),
        expect.objectContaining({ id: other.id, materialized: false }),
      ])
    );
    expect(chatIndex()).toEqual(
      expect.arrayContaining(
        chats.map((chat) => expect.objectContaining({ id: chat.id, materialized: false }))
      )
    );
    expect(existsSync(resourceFile)).toBe(false);
    expect(existsSync(sceneFile)).toBe(false);

    const current = readResource(f.store, 'content', f.resource.id);
    const edited = editableResource('content', current) as ContentEditModel;
    edited.package.nativeRisu.card.creator_notes = 'Saved before export';
    saveResource(f.store, {
      kind: 'content',
      id: f.resource.id,
      expectedRevision: current.revision,
      model: edited,
    });
    f.store.editSource(first.id, { text: 'Live before export', expectedRevision: 0 });
    expect(exportData(f.shell, task.id, 'library', f.resource.id).exported).toEqual([
      `library/${f.resource.id}/resource.json`,
    ]);
    expect(exportData(f.shell, task.id, 'chats', chats[0].id).exported).toEqual([
      `chats/${chats[0].id}/scenes.json`,
    ]);
    expect(
      JSON.parse(readFileSync(resourceFile, 'utf8')).package.nativeRisu.card.creator_notes
    ).toBe('Saved before export');
    expect(readFileSync(sceneFile, 'utf8')).toBe('Live before export');
    expect(readFileSync(join(base, 'current/scenes', `${first.id}.txt`), 'utf8')).toBe(
      'Frozen scene'
    );
    expect(existsSync(join(base, 'library', other.id, 'resource.json'))).toBe(false);
    expect(existsSync(join(base, 'chats', chats[1].id, 'scenes.json'))).toBe(false);

    const draft = 'local draft preserved';
    writeFileSync(resourceFile, draft);
    writeFileSync(sceneFile, 'local scene draft');
    const newer = readResource(f.store, 'content', f.resource.id);
    const newerModel = editableResource('content', newer) as ContentEditModel;
    newerModel.package.nativeRisu.card.creator_notes = 'Saved after export';
    saveResource(f.store, {
      kind: 'content',
      id: f.resource.id,
      expectedRevision: newer.revision,
      model: newerModel,
    });
    f.store.editSource(first.id, { text: 'Live after export', expectedRevision: 1 });
    expect(exportData(f.shell, task.id, 'library', f.resource.id).reused).toEqual([
      `library/${f.resource.id}/resource.json`,
    ]);
    expect(exportData(f.shell, task.id, 'chats', chats[0].id).reused).toEqual([
      `chats/${chats[0].id}/scenes.json`,
    ]);
    expect(readFileSync(resourceFile, 'utf8')).toBe(draft);
    expect(readFileSync(sceneFile, 'utf8')).toBe('local scene draft');
    expect(library()).toContainEqual(
      expect.objectContaining({
        id: f.resource.id,
        revision: newer.revision + 1,
        projectedRevision: newer.revision,
        materialized: true,
      })
    );
    expect(chatIndex()).toContainEqual(
      expect.objectContaining({
        id: chats[0].id,
        materialized: true,
        projectedHeadRevision: first.id,
      })
    );

    const clone = f.store.product.content(fixtureBotInput('New resource', 'Body'));
    f.shell.refreshAfterMutation(
      task.id,
      'resource.clone',
      { kind: 'content', sourceId: f.resource.id },
      { id: clone.id }
    );
    expect(library()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: clone.id, materialized: false }),
        expect.objectContaining({ id: other.id, materialized: false }),
      ])
    );
    expect(existsSync(join(base, 'library', clone.id, 'resource.json'))).toBe(false);
    f.store.db.prepare('INSERT INTO library_hidden(kind,id) VALUES(?,?)').run('content', clone.id);
    f.shell.refreshAfterMutation(task.id, 'resource.delete', { kind: 'content', id: clone.id }, {});
    expect(library().some((entry: { id: string }) => entry.id === clone.id)).toBe(false);
    expect(() => exportData(f.shell, task.id, 'library', clone.id)).toThrow(
      'SHELL_EXPORT_NOT_FOUND'
    );
    expect(() => exportData(f.shell, task.id, 'library', '../outside')).toThrow(
      'SHELL_EXPORT_ID_INVALID'
    );
    expect(exportData(f.shell, task.id, 'library')).toMatchObject({
      exported: expect.arrayContaining([`library/${other.id}/resource.json`]),
      reused: [`library/${f.resource.id}/resource.json`],
    });
    expect(exportData(f.shell, task.id, 'chats')).toMatchObject({
      exported: [`chats/${chats[1].id}/scenes.json`],
      reused: [`chats/${chats[0].id}/scenes.json`],
    });
    expect(readFileSync(resourceFile, 'utf8')).toBe(draft);
    expect(readFileSync(sceneFile, 'utf8')).toBe('local scene draft');
  } finally {
    f.shell.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('on-demand exports reject unregistered files without claiming them', async () => {
  const f = workspaceFixture();
  try {
    await expect(f.shell.exec(f.task, 'export', 'true', 1000)).rejects.toThrow();
    const base = join(f.root, 'tasks', f.task.id);
    const resourceDir = join(base, 'library', f.resource.id);
    mkdirSync(resourceDir);
    writeFileSync(join(resourceDir, 'manifest.json'), 'do not overwrite');
    expect(() => exportData(f.shell, f.task.id, 'library', f.resource.id)).toThrow(
      'SHELL_EXPORT_PATH_CONFLICT'
    );
    expect(readFileSync(join(resourceDir, 'manifest.json'), 'utf8')).toBe('do not overwrite');
    expect(existsSync(join(resourceDir, 'resource.json'))).toBe(false);
    const internal = f.shell as unknown as { tasks: Map<string, { files: Map<string, unknown> }> };
    expect(internal.tasks.get(f.task.id)!.files.has(`library/${f.resource.id}/resource.json`)).toBe(
      false
    );
  } finally {
    f.shell.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

linuxTest('on-demand exports reject symlinked directories', async () => {
  const f = workspaceFixture();
  try {
    const other = f.store.product.content(fixtureBotInput('Symlink fixture', 'Body'));
    await expect(f.shell.exec(f.task, 'export', 'true', 1000)).rejects.toThrow();
    const base = join(f.root, 'tasks', f.task.id);
    const outside = join(f.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'resource.json'), 'outside must survive');
    symlinkSync(outside, join(base, 'library', other.id), 'dir');
    expect(() => exportData(f.shell, f.task.id, 'library', other.id)).toThrow(
      'SHELL_EXPORT_PATH_CONFLICT'
    );
    expect(readFileSync(join(outside, 'resource.json'), 'utf8')).toBe('outside must survive');
    const internal = f.shell as unknown as { tasks: Map<string, { files: Map<string, unknown> }> };
    expect(internal.tasks.get(f.task.id)!.files.has(`library/${other.id}/resource.json`)).toBe(
      false
    );
  } finally {
    f.shell.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

linuxTest(
  'shell finds resources and applies canonical changes through existing saves',
  async () => {
    const f = await fixture();
    const file = `library/${f.resource.id}/resource.json`;
    await prepareFiles(f, 'library', f.resource.id);
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
    expect(updated.applied).toEqual([
      expect.objectContaining({
        path: file,
        changed: true,
        receiptId: expect.any(String),
        changedPaths: expect.arrayContaining(['/package/nativeRisu/card/creator_notes']),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
      'Updated by Linux'
    );
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(f.task.id)
        ?.n
    ).toBe(1);
    expect(
      JSON.parse(readFileSync(join(f.root, 'tasks', f.task.id, file), 'utf8')).package.nativeRisu
        .card.creator_notes
    ).toBe('Updated by Linux');
  }
);

linuxTest('external revision change rejects stale shell edits instead of overwriting', async () => {
  const f = await fixture();
  const file = `library/${f.resource.id}/resource.json`;
  await prepareFiles(f, 'library', f.resource.id);
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
  expect(result.output).toContain('SHELL_REVISION_CONFLICT');
  const conflict = JSON.parse(result.output);
  expect(conflict.nextRead).toEqual({
    name: 'app.call',
    arguments: { name: 'resource.read', arguments: { kind: 'content', id: f.resource.id } },
  });
  expect(conflict.guidance).toContain('app.call');
  expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
    'External change'
  );
});

linuxTest(
  'workspace guide and frozen current scene index distinguish live saved changes',
  async () => {
    const f = await fixture();
    const chat = createFixtureChat(f.store, 'Frozen story');
    const first = completedSource(f.store, chat.id, '시작🙂\n첫 장면');
    const second = completedSource(f.store, chat.id, '나'.repeat(175_000));
    const third = completedSource(f.store, chat.id, '끝 장면');
    updateSceneContext(f.store, second.id, { expectedRevision: 0, sceneEnabled: false });
    const conversation = f.workspace.open({ kind: 'chat', chatId: chat.id });
    const fixed = helperWritingSnapshot(f.store, chat.id);
    const task = f.workspace.enqueue(conversation.id, 'frozen-scene-index', 'Review scenes', {
      scope: conversation.scope,
      model: f.task.snapshot.model,
      writing: fixed,
      history: [],
      persona: '',
      limits: { helperCalls: 12, totalCalls: 24 },
    });
    f.workspace.start(task.id, 'shell-fixture');
    f.store.editSource(first.id, { text: 'Changed after task admission', expectedRevision: 0 });
    const exported = await f.shell.exec(
      f.workspace.task(task.id),
      'export',
      `node ${resolve('runner/uimori.mjs')} export '${JSON.stringify({ scope: 'chats', id: chat.id })}' > scratch/export.json; cat INDEX.md | head -5`,
      5000
    );
    expect(exported.exitCode).toBe(0);
    expect(exported.output).toContain('GUIDE.md');
    const base = join(f.root, 'tasks', task.id);
    const guide = readFileSync(join(base, 'GUIDE.md'), 'utf8');
    expect(guide).toContain('source ancestry');
    expect(guide).toContain('not independent authored sources');
    expect(guide).toContain('uimori call context.read');

    const current = JSON.parse(readFileSync(join(base, 'current/scenes.json'), 'utf8'));
    const saved = JSON.parse(readFileSync(join(base, `chats/${chat.id}/scenes.json`), 'utf8'));
    expect(current.map((scene: { sceneNumber: number | null }) => scene.sceneNumber)).toEqual([
      1,
      null,
      2,
    ]);
    expect(saved.map((scene: { sceneNumber: number | null }) => scene.sceneNumber)).toEqual([
      1,
      null,
      2,
    ]);
    expect(current[0]).toMatchObject({
      sourceId: first.id,
      file: `current/scenes/${first.id}.txt`,
      sceneEnabled: true,
      charCount: '시작🙂\n첫 장면'.length,
      byteCount: Buffer.byteLength('시작🙂\n첫 장면'),
    });
    expect(current[0].contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(saved[0]).toMatchObject({
      sourceId: first.id,
      revision: 1,
      charCount: 'Changed after task admission'.length,
    });
    expect(readFileSync(join(base, `current/scenes/${first.id}.txt`), 'utf8')).toBe(
      '시작🙂\n첫 장면'
    );
    expect(readFileSync(join(base, `chats/${chat.id}/scenes/${first.id}.txt`), 'utf8')).toBe(
      'Changed after task admission'
    );
    expect(current[1]).toMatchObject({
      sourceId: second.id,
      sceneEnabled: false,
      sceneNumber: null,
      charCount: 175_000,
      byteCount: Buffer.byteLength('나'.repeat(175_000)),
    });
    expect([...current[1].preview]).toHaveLength(120);
    expect(current[2].sourceId).toBe(third.id);
  }
);

linuxTest('native Linux text edits apply to saved scenes and retain edit revisions', async () => {
  const f = await fixture();
  const chat = createFixtureChat(f.store, 'Shell scene');
  const source = completedSource(f.store, chat.id, 'Initial scene narrative');
  const file = `chats/${chat.id}/scenes/${source.id}.txt`;
  await prepareFiles(f, 'chats', chat.id);
  const command = `printf '%s' 'Edited scene narrative' > ${file}; node ${resolve('runner/uimori.mjs')} apply ${file}`;
  const result = await f.shell.exec(f.task, 'scene', command, 5000);
  expect(result.exitCode).toBe(0);
  expect(result.applied).toEqual([expect.objectContaining({ path: file, changed: true })]);
  const saved = f.store.source(source.id);
  expect(saved.text).toBe('Edited scene narrative');
  expect(saved.editRevision).toBe(1);
  expect(
    JSON.parse(
      readFileSync(join(f.root, 'tasks', f.task.id, `chats/${chat.id}/scenes.json`), 'utf8')
    )
  ).toContainEqual(
    expect.objectContaining({
      sourceId: source.id,
      revision: 1,
      file,
      charCount: 'Edited scene narrative'.length,
      byteCount: Buffer.byteLength('Edited scene narrative'),
      preview: 'Edited scene narrative',
    })
  );
});

function fileModel(f: Awaited<ReturnType<typeof fixture>>) {
  const filename = join(f.root, 'tasks', f.task.id, 'library', f.resource.id, 'resource.json');
  return { filename, model: JSON.parse(readFileSync(filename, 'utf8')) as ContentEditModel };
}
function appMutation(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  args: Record<string, unknown>,
  receipt: string
) {
  const operation = helperResourceOperation(name, args)!;
  if (operation.readOnly) throw new Error('Expected mutation');
  const result = f.workspace.operation(f.task.id, receipt, { name, args }, () =>
    applyHelperResourceMutation(
      f.store,
      f.workspace,
      f.task,
      receipt,
      name,
      args,
      operation.targets ?? operation.target
    )
  );
  f.shell.refreshAfterMutation(f.task.id, name, args, result);
  return result as { id: string; revision: number };
}
linuxTest(
  'JSON formatting is a no-op and derived-only edits preserve DB, undo and local input',
  async () => {
    const f = await fixture();
    await prepareFiles(f, 'library', f.resource.id);
    const { filename, model } = fileModel(f);
    const command = `node ${resolve('runner/uimori.mjs')} apply library/${f.resource.id}/resource.json`;
    writeFileSync(filename, JSON.stringify(model));
    const unchanged = await f.shell.exec(f.task, 'format-only', command, 5000);
    expect(unchanged.exitCode).toBe(0);
    expect(JSON.parse(unchanged.output).changed).toBe(false);
    model.title = 'Requested derived title';
    model.description = 'Requested derived description';
    model.text = 'Requested derived text';
    writeFileSync(filename, JSON.stringify(model));
    const rejected = await f.shell.exec(f.task, 'derived-only', command, 5000);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.output).toContain('SHELL_NO_AUTHORED_CHANGE');
    expect(readResource(f.store, 'content', f.resource.id).revision).toBe(f.resource.revision);
    expect(JSON.parse(readFileSync(filename, 'utf8')).title).toBe('Requested derived title');
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(f.task.id)
        ?.n
    ).toBe(0);
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM resource_undo WHERE id=?').get(f.resource.id)?.n
    ).toBe(0);
  }
);
linuxTest(
  'native apply uses existing helper undo and a repeated apply does not save twice',
  async () => {
    const f = await fixture();
    await prepareFiles(f, 'library', f.resource.id);
    const { filename, model } = fileModel(f);
    model.package.nativeRisu.card.creator_notes = 'Undo this native change';
    writeFileSync(filename, JSON.stringify(model));
    const command = `node ${resolve('runner/uimori.mjs')} apply library/${f.resource.id}/resource.json`;
    const applied = await f.shell.exec(f.task, 'save', command + '\n' + command, 5000);
    expect(applied.exitCode).toBe(0);
    expect(applied.applied).toHaveLength(1);
    expect(JSON.parse(applied.output.trim().split('\n').at(-1)!).changed).toBe(false);
    const task = f.workspace.task(f.task.id);
    f.workspace.finish(task.id, 'shell-fixture', task.generation, 'completed', 'Saved', null);
    const edit = lastHelperResourceEdit(f.store, f.workspace, task.conversationId)!;
    expect(edit.canUndo).toBe(true);
    expect(edit.id).toBe(f.resource.id);
    undoHelperResourceEdit(f.store, f.workspace, task.conversationId, edit.editSeq);
    expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
      f.resource.description
    );
  }
);
linuxTest(
  'app mutations refresh clean files and catalog clones without overwriting dirty files',
  async () => {
    const f = await fixture();
    await prepareFiles(f, 'library', f.resource.id);
    const patch = (value: string) =>
      appMutation(
        f,
        'resource.patch',
        {
          kind: 'content',
          id: f.resource.id,
          expectedRevision: readResource(f.store, 'content', f.resource.id).revision,
          changes: [{ op: 'set', path: '/package/nativeRisu/card/creator_notes', value }],
        },
        value
      );
    patch('Clean app change');
    const { filename, model } = fileModel(f);
    expect(model.package.nativeRisu.card.creator_notes).toBe('Clean app change');
    model.package.nativeRisu.card.creator_notes = 'Dirty local change';
    writeFileSync(filename, JSON.stringify(model));
    patch('Newer app change');
    expect(fileModel(f).model.package.nativeRisu.card.creator_notes).toBe('Dirty local change');
    const clone = appMutation(
      f,
      'resource.clone',
      {
        kind: 'content',
        sourceId: f.resource.id,
        expectedSourceRevision: readResource(f.store, 'content', f.resource.id).revision,
        title: 'Native editable clone',
      },
      'clone'
    );
    const relative = `library/${clone.id}/resource.json`;
    const clonedFile = join(f.root, 'tasks', f.task.id, relative);
    expect(existsSync(clonedFile)).toBe(false);
    await prepareFiles(f, 'library', clone.id);
    const clonedModel = JSON.parse(readFileSync(clonedFile, 'utf8'));
    clonedModel.package.nativeRisu.card.creator_notes = 'Edited clone';
    writeFileSync(clonedFile, JSON.stringify(clonedModel));
    const saved = await f.shell.exec(
      f.task,
      'save-clone',
      `node ${resolve('runner/uimori.mjs')} apply ${relative}`,
      5000
    );
    expect(saved.exitCode).toBe(0);
    expect((readResource(f.store, 'content', clone.id) as Content).description).toBe(
      'Edited clone'
    );
    const index = readFileSync(join(f.root, 'tasks', f.task.id, 'library/index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    expect(index).toContainEqual(
      expect.objectContaining({ id: clone.id, revision: clone.revision + 1, file: relative })
    );
    expect(fileModel(f).model.package.nativeRisu.card.creator_notes).toBe('Dirty local change');
  }
);

linuxTest(
  'committed apply remains successful when metadata refresh fails and retry is a no-op',
  async () => {
    const f = await fixture();
    await prepareFiles(f, 'library', f.resource.id);
    const { filename, model } = fileModel(f);
    model.package.nativeRisu.card.creator_notes = 'Saved despite refresh failure';
    writeFileSync(filename, JSON.stringify(model));
    const manifest = join(filename, '..', 'manifest.json');
    rmSync(manifest);
    mkdirSync(manifest);
    const command = `node ${resolve('runner/uimori.mjs')} apply library/${f.resource.id}/resource.json`;
    const result = await f.shell.exec(f.task, 'save', command + '\n' + command, 5000);
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual([
      expect.objectContaining({
        changed: true,
        revision: f.resource.revision + 1,
        warning: expect.stringContaining('SHELL_PROJECTION_REFRESH_FAILED'),
      }),
    ]);
    const responses = result.output
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    expect(responses[0]).toMatchObject({ changed: true, receiptId: expect.any(String) });
    expect(responses[1]).toMatchObject({ changed: false, revision: f.resource.revision + 1 });
    expect((readResource(f.store, 'content', f.resource.id) as Content).description).toBe(
      'Saved despite refresh failure'
    );
    expect(
      f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(f.task.id)
        ?.n
    ).toBe(1);
  }
);
linuxTest('task cancellation aborts the runner before delayed file edits and apply', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const file = `library/${f.resource.id}/resource.json`;
  await prepareFiles(f, 'library', f.resource.id);
  const pending = f.shell.exec(
    f.task,
    'cancel',
    `touch scratch/started; sleep 0.4; printf BAD > ${file}; node ${resolve('runner/uimori.mjs')} apply ${file}`,
    5000,
    controller.signal
  );
  const settled = pending.catch((error: unknown) => error);
  const taskDir = join(f.root, 'tasks', f.task.id);
  for (let i = 0; i < 100 && !existsSync(join(taskDir, 'scratch/started')); i++) await delay(20);
  expect(existsSync(join(taskDir, 'scratch/started'))).toBe(true);
  f.workspace.cancel(f.task.id);
  controller.abort();
  expect(await settled).toBeInstanceOf(Error);
  await delay(600);
  expect(JSON.parse(readFileSync(join(taskDir, file), 'utf8')).title).toBe(f.resource.title);
  expect(readResource(f.store, 'content', f.resource.id).revision).toBe(f.resource.revision);
  expect(
    f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(f.task.id)?.n
  ).toBe(0);
});

linuxTest(
  'CLI forwards JSON, files and stdin while retaining receipts outside stdout',
  async () => {
    const f = await fixture();
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    const calls: { name: string; args: Record<string, unknown>; operationId: string }[] = [];
    const result = await f.shell.exec(
      f.task,
      'bridge',
      `set -e
${cli} tools '{"names":["resource.read"]}' > scratch/tools.json
python3 -c 'import json; json.dump({"text":"한"*12000},open("scratch/input.json","w"))'
${cli} call resource.read --input scratch/input.json > scratch/file.json
printf '%s' '{"value":"piped"}' | ${cli} call settings.patch --input - > scratch/stdin.json
${cli} call denied '{}' > scratch/denied.json || test "$?" = 1
cat scratch/denied.json`,
      5000,
      undefined,
      async (name, args, operationId, signal) => {
        expect(signal.aborted).toBe(false);
        calls.push({ name, args, operationId });
        if (name === 'denied') return { result: { error: 'EXPECTED_DENIAL' }, denied: true };
        return {
          result: { name, args },
          ...(name === 'settings.patch'
            ? { applied: [{ operationId, outcome: 'succeeded' }] }
            : {}),
        };
      }
    );
    expect(result.exitCode).toBe(0);
    expect(calls.map(({ name, operationId }) => [name, operationId])).toEqual([
      ['app.tools', 'shell:bridge:app:1'],
      ['resource.read', 'shell:bridge:app:2'],
      ['settings.patch', 'shell:bridge:app:3'],
      ['denied', 'shell:bridge:app:4'],
    ]);
    expect(calls[0].args).toEqual({ names: ['resource.read'] });
    expect(calls[1].args.text).toBe('한'.repeat(12000));
    expect(calls[2].args).toEqual({ value: 'piped' });
    expect(JSON.parse(result.output)).toEqual({ error: 'EXPECTED_DENIAL' });
    expect(result.applied).toEqual([{ operationId: 'shell:bridge:app:3', outcome: 'succeeded' }]);
    const taskDir = join(f.root, 'tasks', f.task.id);
    expect(
      JSON.parse(readFileSync(join(taskDir, 'scratch/file.json'), 'utf8')).args.text
    ).toHaveLength(12000);
    const outside = promisify(execFile);
    await expect(
      outside(process.execPath, [resolve('runner/uimori.mjs'), 'call', 'resource.read'], {
        env: {
          ...process.env,
          UIMORI_TASK_ID: f.task.id,
          UIMORI_TOOL_ID: 'bridge',
          UIMORI_BRIDGE_SOCKET: join(f.root, '.apply.sock'),
        },
      })
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('SHELL_EXECUTION_NOT_ACTIVE'),
    });
  }
);

linuxTest(
  'CLI accepts standard flags and exact operation lookup without a schema round trip',
  async () => {
    const f = await fixture();
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const executed = await f.shell.exec(
      f.task,
      'cli-flags',
      `set -e
${cli} tools --query appearance --offset 3 > scratch/catalog.json
${cli} tools resource.patch > scratch/schema.json
${cli} tools --names resource.read,task.inspect > scratch/names.json
${cli} call resource.read --kind content --id some-id --limit 2 --include-bodies false > scratch/read.json
${cli} call task.inspect --kind helper --id task-1 --include-prompt true --effects-offset 2 > scratch/inspect.json
${cli} call chat.rename --title 123 --expected-revision 2 > scratch/rename.json
${cli} call image.list --content-id image-owner --limit 3 > scratch/image-list.json
${cli} call task.inspect --kind helper --id task-1 --include-prompt maybe > scratch/rejected.json && exit 5 || test "$?" = 1
${cli} call resource.read --missing-field value > scratch/invalid-option.json && exit 5 || test "$?" = 1
${cli} call resource.patch --changes value > scratch/json-required.json && exit 5 || test "$?" = 1
${cli} --help > scratch/help.txt
cat scratch/read.json`,
      5000,
      undefined,
      async (name, args) => {
        calls.push({ name, args });
        return { result: { name, args } };
      }
    );
    expect(executed.exitCode).toBe(0);
    expect(calls).toEqual([
      { name: 'app.tools', args: { query: 'appearance', offset: 3 } },
      { name: 'app.tools', args: { names: ['resource.patch'] } },
      { name: 'app.tools', args: { names: ['resource.read', 'task.inspect'] } },
      {
        name: 'resource.read',
        args: { kind: 'content', id: 'some-id', limit: 2, includeBodies: false },
      },
      {
        name: 'task.inspect',
        args: { kind: 'helper', id: 'task-1', includePrompt: true, effectsOffset: 2 },
      },
      { name: 'chat.rename', args: { title: '123', expectedRevision: 2 } },
      { name: 'image.list', args: { contentId: 'image-owner', limit: 3 } },
    ]);
    expect(executed.outputBytes).toBeGreaterThan(0);
    expect(executed.output).toContain('some-id');
    const taskDir = join(f.root, 'tasks', f.task.id);
    expect(readFileSync(join(taskDir, 'scratch/help.txt'), 'utf8')).toContain('uimori tools');
    expect(readFileSync(join(taskDir, 'scratch/rejected.json'), 'utf8')).toContain(
      'SHELL_INVALID_BOOLEAN:includePrompt'
    );
    expect(readFileSync(join(taskDir, 'scratch/invalid-option.json'), 'utf8')).toContain(
      'SHELL_INVALID_OPTION:missingField: resource.read has no --missing-field option. Check uimori tools resource.read.'
    );
    expect(readFileSync(join(taskDir, 'scratch/json-required.json'), 'utf8')).toContain(
      'SHELL_USE_JSON_INPUT:changes: changes is not a simple string, number or boolean. Pass all arguments as a JSON object or with --input <file|->.'
    );
  }
);

linuxTest(
  'unknown app outcome stops later bridge writes and survives redirected output',
  async () => {
    const f = await fixture();
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    const applied = { operationId: 'shell:unknown:app:1', outcome: 'succeeded' };
    await prepareFiles(f, 'library', f.resource.id);
    const invoke = vi.fn(async () => ({
      result: { error: 'STORAGE_RESPONSE_LOST', outcome: 'unknown' },
      fatalError: new Error('STORAGE_RESPONSE_LOST'),
      applied: [applied],
    }));
    const error = await f.shell
      .exec(
        f.task,
        'unknown',
        `${cli} call settings.patch '{}' > scratch/unknown.json
${cli} call settings.patch '{}' > scratch/blocked-call.json
printf BAD > library/${f.resource.id}/resource.json
${cli} apply library/${f.resource.id}/resource.json > scratch/blocked-apply.json
${cli} refresh library/${f.resource.id}/resource.json > scratch/blocked-refresh.json
true`,
        5000,
        undefined,
        invoke
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HelperShellExecutionError);
    expect(error).toMatchObject({ message: 'STORAGE_RESPONSE_LOST', applied: [applied] });
    expect(invoke).toHaveBeenCalledTimes(1);
    for (const name of ['blocked-call', 'blocked-apply', 'blocked-refresh']) {
      expect(
        readFileSync(join(f.root, 'tasks', f.task.id, 'scratch', name + '.json'), 'utf8')
      ).toContain('SHELL_EXECUTION_STOPPED');
    }
    expect(readResource(f.store, 'content', f.resource.id).revision).toBe(f.resource.revision);
  }
);

linuxTest('shell completion cancels in-flight app work and waits for its outcome', async () => {
  const f = await fixture();
  const taskDir = join(f.root, 'tasks', f.task.id);
  let cancelled = false;
  const result = await f.shell.exec(
    f.task,
    'pending',
    `node ${resolve('runner/uimori.mjs')} call slow '{}' > scratch/result.json &
while [ ! -f scratch/in-flight ]; do sleep 0.01; done`,
    5000,
    undefined,
    async (_name, _args, operationId, signal) => {
      writeFileSync(join(taskDir, 'scratch/in-flight'), '');
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            resolve();
          },
          { once: true }
        )
      );
      return { result: { cancelled: true }, applied: [{ operationId, outcome: 'succeeded' }] };
    }
  );
  expect(result.exitCode).toBe(0);
  expect(cancelled).toBe(true);
  expect(result.applied).toEqual([{ operationId: 'shell:pending:app:1', outcome: 'succeeded' }]);
});

linuxTest(
  'refresh updates clean resources and reconciles dirty drafts through a separate editable latest file',
  async () => {
    const f = await fixture();
    const file = `library/${f.resource.id}/resource.json`;
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    await prepareFiles(f, 'library', f.resource.id);
    const saveExternal = (name: string) => {
      const saved = readResource(f.store, 'content', f.resource.id);
      const model = editableResource('content', saved) as ContentEditModel;
      model.package.nativeRisu.card.name = name;
      return saveResource(f.store, {
        kind: 'content',
        id: f.resource.id,
        expectedRevision: saved.revision,
        model,
      });
    };
    saveExternal('First external title');
    const clean = await f.shell.exec(f.task, 'refresh-clean', `${cli} refresh ${file}`, 5000);
    expect(JSON.parse(clean.output)).toMatchObject({
      path: file,
      latestPath: file,
      dirty: false,
      revision: f.resource.revision + 1,
    });
    const { filename, model } = fileModel(f);
    expect(model.package.nativeRisu.card.name).toBe('First external title');
    model.package.nativeRisu.card.creator_notes = 'Preserved local draft';
    const draft = JSON.stringify(model);
    writeFileSync(filename, draft);
    saveExternal('Latest external title');
    const refreshed = await f.shell.exec(f.task, 'refresh-dirty', `${cli} refresh ${file}`, 5000);
    const latest = JSON.parse(refreshed.output);
    expect(latest).toMatchObject({ path: file, dirty: true, revision: f.resource.revision + 2 });
    expect(latest.latestPath).toMatch(/^scratch\/refresh-.*\/resource.json$/u);
    expect(readFileSync(filename, 'utf8')).toBe(draft);
    const latestFilename = join(f.root, 'tasks', f.task.id, latest.latestPath);
    const merged = JSON.parse(readFileSync(latestFilename, 'utf8'));
    expect(merged.package.nativeRisu.card.name).toBe('Latest external title');
    merged.package.nativeRisu.card.creator_notes = model.package.nativeRisu.card.creator_notes;
    writeFileSync(latestFilename, JSON.stringify(merged));
    const saved = await f.shell.exec(
      f.task,
      'apply-latest',
      `${cli} apply ${latest.latestPath}\n${cli} apply ${latest.latestPath}`,
      5000
    );
    expect(saved.exitCode).toBe(0);
    expect(saved.applied).toHaveLength(1);
    expect(saved.applied[0]).toMatchObject({
      path: latest.latestPath,
      revision: f.resource.revision + 3,
    });
    const resource = readResource(f.store, 'content', f.resource.id) as Content;
    expect(resource.title).toBe('Latest external title');
    expect(resource.description).toBe('Preserved local draft');
    expect(readFileSync(filename, 'utf8')).toBe(draft);
    expect(
      JSON.parse(readFileSync(join(latestFilename, '..', 'manifest.json'), 'utf8')).revision
    ).toBe(resource.revision);
    const index = readFileSync(join(f.root, 'tasks', f.task.id, 'library/index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(index.filter((entry) => entry.id === f.resource.id)).toEqual([
      expect.objectContaining({
        file,
        revision: f.resource.revision + 3,
        projectedRevision: f.resource.revision + 1,
      }),
    ]);
    const stale = await f.shell.exec(f.task, 'still-stale', `${cli} apply ${file}`, 5000);
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain('SHELL_REVISION_CONFLICT');
  }
);

linuxTest(
  'refresh preserves a dirty scene and applies the reconciled latest revision',
  async () => {
    const f = await fixture();
    const chat = createFixtureChat(f.store, 'Refresh scene');
    const source = completedSource(f.store, chat.id, 'Original scene');
    const file = `chats/${chat.id}/scenes/${source.id}.txt`;
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    await prepareFiles(f, 'chats', chat.id);
    const filename = join(f.root, 'tasks', f.task.id, file);
    const sceneIndex = () =>
      JSON.parse(
        readFileSync(join(f.root, 'tasks', f.task.id, `chats/${chat.id}/scenes.json`), 'utf8')
      );
    f.store.editSource(source.id, { text: 'External scene', expectedRevision: 0 });
    const clean = await f.shell.exec(f.task, 'clean', `${cli} refresh ${file}`, 5000);
    expect(JSON.parse(clean.output)).toMatchObject({ dirty: false, latestPath: file, revision: 1 });
    expect(sceneIndex()).toContainEqual(
      expect.objectContaining({
        sourceId: source.id,
        revision: 1,
        file,
        charCount: 'External scene'.length,
        preview: 'External scene',
      })
    );
    writeFileSync(filename, 'Local scene draft');
    f.store.editSource(source.id, { text: 'New external scene', expectedRevision: 1 });
    const refreshed = await f.shell.exec(f.task, 'dirty', `${cli} refresh ${file}`, 5000);
    const latest = JSON.parse(refreshed.output);
    expect(readFileSync(filename, 'utf8')).toBe('Local scene draft');
    expect(sceneIndex()).toContainEqual(
      expect.objectContaining({
        sourceId: source.id,
        revision: 1,
        file,
        charCount: 'External scene'.length,
        preview: 'External scene',
      })
    );
    expect(readFileSync(join(f.root, 'tasks', f.task.id, latest.latestPath), 'utf8')).toBe(
      'New external scene'
    );
    writeFileSync(
      join(f.root, 'tasks', f.task.id, latest.latestPath),
      'New external scene + local draft'
    );
    const result = await f.shell.exec(f.task, 'save', `${cli} apply ${latest.latestPath}`, 5000);
    expect(result.exitCode).toBe(0);
    expect(f.store.source(source.id)).toMatchObject({
      text: 'New external scene + local draft',
      editRevision: 3,
    });
    expect(readFileSync(filename, 'utf8')).toBe('Local scene draft');
    expect(sceneIndex()).toContainEqual(
      expect.objectContaining({ sourceId: source.id, revision: 1, file })
    );
  }
);

linuxTest('runner responses preserve UTF-8 characters split across HTTP chunks', async () => {
  const f = await fixture();
  const exited = once(f.child, 'exit');
  f.child.kill('SIGTERM');
  await exited;
  const socket = join(f.root, '.exec.sock');
  rmSync(socket, { force: true });
  const expected = '한글 응답 🙂';
  const body = Buffer.from(JSON.stringify({ exitCode: 0, output: expected, truncated: false }));
  const split = body.indexOf(Buffer.from('한')) + 1;
  const runner = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(body.subarray(0, split));
    setTimeout(() => res.end(body.subarray(split)), 10);
  });
  await new Promise<void>((done) => runner.listen(socket, done));
  try {
    const result = await f.shell.exec(f.task, 'unicode-response', 'printf unused', 5000);
    expect(result.output).toBe(expected);
  } finally {
    await new Promise<void>((done, reject) =>
      runner.close((error) => (error ? reject(error) : done()))
    );
  }
});

linuxTest(
  'replaced scenes reject stale files and refresh copies without changing history',
  async () => {
    const f = await fixture();
    const chat = createFixtureChat(f.store, 'Replaced scene');
    const source = completedSource(f.store, chat.id, 'Historical original');
    const file = `chats/${chat.id}/scenes/${source.id}.txt`;
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    await prepareFiles(f, 'chats', chat.id);
    const taskDir = join(f.root, 'tasks', f.task.id);
    writeFileSync(join(taskDir, file), 'Preserved local draft');
    const refreshed = await f.shell.exec(f.task, 'refresh', `${cli} refresh ${file}`, 5000);
    const latestPath = JSON.parse(refreshed.output).latestPath as string;
    expect(latestPath).not.toBe(file);
    writeFileSync(join(taskDir, latestPath), 'Preserved reconciled draft');

    const replacement = retryRun(f.store, source.runId, 'replace-scene', { mode: 'replace' }).run;
    f.store.startRun(replacement.id);
    const current = f.store.completeRun(replacement.id, 'New active original', {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    expect(
      f.store
        .history(f.store.chat(chat.id).headRevision)
        .some((item) => item.revision === source.id)
    ).toBe(false);

    for (const [index, path] of [file, latestPath].entries()) {
      for (const command of ['apply', 'refresh']) {
        const result = await f.shell.exec(
          f.task,
          `${command}-${index}`,
          `${cli} ${command} ${path}`,
          5000
        );
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('Scene is not in the current chat ancestry');
        expect(result.applied).toEqual([]);
      }
    }
    expect(f.store.source(source.id)).toMatchObject({
      text: 'Historical original',
      editRevision: 0,
    });
    expect(f.store.source(current.id).text).toBe('New active original');
    expect(readFileSync(join(taskDir, file), 'utf8')).toBe('Preserved local draft');
    expect(readFileSync(join(taskDir, latestPath), 'utf8')).toBe('Preserved reconciled draft');
    expect(
      f.store.db
        .prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?')
        .get(f.task.id)?.n
    ).toBe(0);
  }
);
