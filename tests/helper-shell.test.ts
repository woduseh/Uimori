import { afterEach, expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { HelperShell, HelperShellExecutionError } from '../server/helper-shell.js';
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
  return { store, workspace, shell, child, task: workspace.task(task.id), resource, root };
}

linuxTest(
  'shell finds resources and applies canonical changes through existing saves',
  async () => {
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

linuxTest('native Linux text edits apply to saved scenes and retain edit revisions', async () => {
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
  expect(
    JSON.parse(
      readFileSync(join(f.root, 'tasks', f.task.id, `chats/${chat.id}/scenes.json`), 'utf8')
    )
  ).toContainEqual({ sourceId: source.id, revision: 1, file });
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
    await f.shell.exec(f.task, 'export', 'true', 5000);
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
    await f.shell.exec(f.task, 'export', 'true', 5000);
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
  'app mutations refresh clean files and register clones without overwriting dirty files',
  async () => {
    const f = await fixture();
    await f.shell.exec(f.task, 'export', 'true', 5000);
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
    await f.shell.exec(f.task, 'export', 'true', 5000);
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
  'unknown app outcome stops later bridge writes and survives redirected output',
  async () => {
    const f = await fixture();
    const cli = `node ${resolve('runner/uimori.mjs')}`;
    const applied = { operationId: 'shell:unknown:app:1', outcome: 'succeeded' };
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
    await f.shell.exec(f.task, 'export', 'true', 5000);
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
      expect.objectContaining({ file, revision: f.resource.revision + 1 }),
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
    await f.shell.exec(f.task, 'export', 'true', 5000);
    const filename = join(f.root, 'tasks', f.task.id, file);
    const sceneIndex = () =>
      JSON.parse(
        readFileSync(join(f.root, 'tasks', f.task.id, `chats/${chat.id}/scenes.json`), 'utf8')
      );
    f.store.editSource(source.id, { text: 'External scene', expectedRevision: 0 });
    const clean = await f.shell.exec(f.task, 'clean', `${cli} refresh ${file}`, 5000);
    expect(JSON.parse(clean.output)).toMatchObject({ dirty: false, latestPath: file, revision: 1 });
    expect(sceneIndex()).toContainEqual({ sourceId: source.id, revision: 1, file });
    writeFileSync(filename, 'Local scene draft');
    f.store.editSource(source.id, { text: 'New external scene', expectedRevision: 1 });
    const refreshed = await f.shell.exec(f.task, 'dirty', `${cli} refresh ${file}`, 5000);
    const latest = JSON.parse(refreshed.output);
    expect(readFileSync(filename, 'utf8')).toBe('Local scene draft');
    expect(sceneIndex()).toContainEqual({ sourceId: source.id, revision: 1, file });
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
    expect(sceneIndex()).toContainEqual({ sourceId: source.id, revision: 1, file });
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
    await f.shell.exec(f.task, 'export', 'true', 5000);
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
