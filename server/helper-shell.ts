import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { join, relative, resolve, dirname } from 'node:path';
import type { HelperTask } from '../core/helper.js';
import { editableResource, type ResourceKind } from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import { readResource, saveResource } from './resource-service.js';
import type { Store } from './store.js';
import type { HelperWorkspace } from './helper-workspace.js';

type FileTarget =
  | { kind: 'resource'; id: string; resourceKind: ResourceKind; revision: number; hash: string }
  | { kind: 'scene'; id: string; revision: number; hash: string };
type TaskFiles = { files: Map<string, FileTarget>; task: HelperTask };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safeId = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/u.test(s);
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
function json(path: string, value: unknown) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}
function rpc(socketPath: string, path: string, payload: unknown, timeoutMs = 35000): Promise<any> {
  return new Promise((resolveResult, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let result = '';
        res.on('data', (chunk) => {
          result += chunk;
          if (result.length > 100_000) req.destroy();
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(result);
            if (res.statusCode !== 200) reject(new Error(data.error ?? 'SHELL_REQUEST_FAILED'));
            else resolveResult(data);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('SHELL_TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
}

/** The only bridge between an ordinary Linux workspace and Uimori's saved resources. */
export class HelperShell {
  private readonly root = resolve(process.env.UIMORI_SHELL_ROOT ?? '/helper-workspaces');
  private bridge?: Server;
  private starting?: Promise<void>;
  private readonly tasks = new Map<string, TaskFiles>();
  private readonly active = new Set<string>();
  private readonly applied = new Map<string, unknown[]>();
  constructor(
    readonly store: Store,
    readonly workspace: HelperWorkspace,
    readonly sceneUpdated?: (id: string) => void
  ) {}

  private taskDir(taskId: string) {
    return join(this.root, 'tasks', taskId);
  }

  private exportResource(
    taskId: string,
    id: string,
    kind: ResourceKind,
    files: Map<string, FileTarget>
  ) {
    if (!safeId(id)) return;
    const resource = readResource(this.store, kind, id);
    const data = editableResource(kind, resource);
    const base = `library/${id}`;
    const content = JSON.stringify(data, null, 2) + '\n';
    write(join(this.taskDir(taskId), base, 'resource.json'), content);
    json(join(this.taskDir(taskId), base, 'manifest.json'), {
      id,
      kind,
      revision: resource.revision,
      title: 'title' in resource ? resource.title : '',
      editableFile: 'resource.json',
    });
    files.set(`${base}/resource.json`, {
      kind: 'resource',
      id,
      resourceKind: kind,
      revision: resource.revision,
      hash: sha(content),
    });
    if (kind === 'content') {
      const native = (resource as Content).package.nativeRisu;
      const card = native.card as { character_book?: { entries?: unknown[] } };
      const lore = native.module?.lorebook ?? card.character_book?.entries ?? [];
      const lorePath =
        native.module?.lorebook != null
          ? '/package/nativeRisu/module/lorebook'
          : '/package/nativeRisu/card/character_book/entries';
      if (Array.isArray(lore)) {
        const lines = (lore as Record<string, any>[]).map((entry, index) =>
          JSON.stringify({
            index,
            name: entry.comment ?? entry.name ?? '',
            keys: entry.key ?? entry.keys ?? [],
            path: `${lorePath}/${index}`,
            content: entry.content ?? '',
          })
        );
        write(
          join(this.taskDir(taskId), base, 'lorebook.jsonl'),
          lines.join('\n') + (lines.length ? '\n' : '')
        );
      }
    }
  }

  private exportTask(task: HelperTask) {
    const base = this.taskDir(task.id);
    if (this.tasks.has(task.id)) return;
    mkdirSync(join(base, 'scratch'), { recursive: true });
    const files = new Map<string, FileTarget>();
    const index: unknown[] = [];
    const resources = this.store.db
      .prepare(
        "SELECT v.id, v.kind FROM versions v WHERE v.kind IN ('content','prompt-preset') AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY v.kind,v.id"
      )
      .all() as { id: string; kind: ResourceKind }[];
    for (const r of resources) {
      if (!safeId(r.id)) continue;
      const item = readResource(this.store, r.kind, r.id);
      index.push({
        id: r.id,
        kind: r.kind,
        title: 'title' in item ? item.title : '',
        revision: item.revision,
        file: `library/${r.id}/resource.json`,
      });
      this.exportResource(task.id, r.id, r.kind, files);
    }
    write(join(base, 'library/index.jsonl'), index.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const chats = this.store.chats();
    write(
      join(base, 'chats/index.jsonl'),
      chats
        .map(({ id, title, headRevision }) => JSON.stringify({ id, title, headRevision }))
        .join('\n') + '\n'
    );
    for (const chat of chats) {
      if (!safeId(chat.id)) continue;
      const dir = `chats/${chat.id}`;
      json(join(base, dir, 'metadata.json'), {
        id: chat.id,
        title: chat.title,
        headRevision: chat.headRevision,
      });
      const scenes: unknown[] = [];
      for (const history of this.store.history(chat.headRevision)) {
        const source = this.store.source(history.revision);
        if (!safeId(source.id)) continue;
        const file = `${dir}/scenes/${source.id}.txt`;
        write(join(base, file), source.text);
        files.set(file, {
          kind: 'scene',
          id: source.id,
          revision: source.editRevision ?? 0,
          hash: sha(source.text),
        });
        scenes.push({ sourceId: source.id, revision: source.editRevision, file });
      }
      json(join(base, dir, 'scenes.json'), scenes);
    }
    if (task.snapshot.editor?.model) {
      json(join(base, 'editor/input.json'), task.snapshot.editor.model);
      json(join(base, 'editor/metadata.json'), {
        id: task.snapshot.editor.targetId,
        revision: task.snapshot.editor.revision,
        source: task.snapshot.editor.source ?? 'unsaved',
      });
    }
    json(join(base, 'conversation/history.json'), task.snapshot.history);
    if (task.snapshot.writing) {
      const writing = task.snapshot.writing;
      json(join(base, 'current/metadata.json'), {
        chatId: writing.chatId,
        headRevision: writing.parentRevision,
        packages: writing.profile?.packageAttachments,
      });
      for (const item of writing.history) {
        if (safeId(item.revision))
          write(join(base, `current/scenes/${item.revision}.txt`), item.text);
      }
      for (const pkg of writing.profile?.packages ?? []) {
        if (safeId(pkg.id)) json(join(base, `current/packages/${pkg.id}.json`), pkg);
      }
    }
    const attempts = this.store.db
      .prepare(
        'SELECT id,role,model_id,status,input_tokens,output_tokens,cost_usd,started_at FROM attempts ORDER BY started_at DESC LIMIT 500'
      )
      .all();
    write(
      join(base, 'usage/recent.jsonl'),
      attempts.map((a) => JSON.stringify(a)).join('\n') + '\n'
    );
    write(
      join(base, 'INDEX.md'),
      '# Uimori workspace\n\n' +
        'Use rg, jq, grep, find, Python, or Bash freely.\n' +
        'library/index.jsonl lists saved resources; library/<id>/resource.json is editable.\n' +
        'library/<id>/lorebook.jsonl is a derived search index and cannot be applied.\n' +
        'chats/index.jsonl lists chats; chats/<id>/scenes/*.txt are editable originals.\n' +
        'editor/ and current/ are reserved task snapshots, not live editable resources.\n' +
        'Use `uimori apply library/<id>/resource.json` or `uimori apply chats/<id>/scenes/<source-id>.txt` to commit.\n' +
        'Do not mistake edited files for saved state before apply returns success.\n'
    );
    this.tasks.set(task.id, { files, task });
  }

  private async startBridge() {
    if (this.bridge) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((done, fail) => {
      mkdirSync(this.root, { recursive: true });
      const socket = join(this.root, '.apply.sock');
      rmSync(socket, { force: true });
      const server = createServer((req, res) => {
        if (req.url !== '/apply' || req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 8000) req.destroy();
        });
        req.on('end', () => {
          try {
            const input = JSON.parse(body);
            const result = this.apply(input.taskId, input.toolId, input.path);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (error) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : 'APPLY_FAILED' })
            );
          }
        });
      });
      server.once('error', fail);
      server.listen(socket, () => {
        this.bridge = server;
        done();
      });
    });
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private apply(taskId: unknown, toolId: unknown, name: unknown) {
    if (
      typeof taskId !== 'string' ||
      typeof toolId !== 'string' ||
      typeof name !== 'string' ||
      !this.active.has(`${taskId}:${toolId}`)
    )
      throw new Error('SHELL_APPLY_NOT_ACTIVE');
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('SHELL_WORKSPACE_MISSING');
    const base = this.taskDir(taskId);
    const path = resolve(base, name);
    const rel = relative(base, path).replaceAll('\\', '/');
    const target = task.files.get(rel);
    if (!target || !existsSync(path) || realpathSync(path) !== path)
      throw new Error('SHELL_FILE_NOT_EDITABLE');
    if (
      target.kind === 'resource' &&
      task.task.snapshot.editor?.targetId === target.id &&
      task.task.snapshot.editor.model &&
      task.task.snapshot.editor.source !== 'saved'
    )
      throw new Error('EDITOR_SAVE_REQUIRED');
    const content = readFileSync(path, 'utf8');
    if (Buffer.byteLength(content) > 16_000_000) throw new Error('SHELL_APPLY_TOO_LARGE');
    if (sha(content) === target.hash)
      return { changed: false, id: target.id, revision: target.revision };
    const operationId = `${taskId}:shell:${toolId}:${sha(rel)}:${target.revision}:${sha(content)}`;
    const result = this.workspace.operation(
      taskId,
      operationId,
      {
        kind: target.kind,
        id: target.id,
        revision: target.revision,
        digest: sha(content),
      },
      () => {
        if (target.kind === 'scene') {
          const saved = this.store.editSource(target.id, {
            text: content,
            expectedRevision: target.revision,
          });
          return { changed: true, id: target.id, revision: saved.editRevision ?? 0 };
        }
        const model = JSON.parse(content);
        const saved = saveResource(this.store, {
          kind: target.resourceKind,
          id: target.id,
          expectedRevision: target.revision,
          model,
        }).saved;
        return { changed: true, id: target.id, revision: saved.revision };
      }
    );
    if (target.kind === 'resource') {
      this.exportResource(taskId, target.id, target.resourceKind, task.files);
      this.workspace.event(task.task.conversationId, taskId, 'resource.updated');
    } else {
      const latest = this.store.source(target.id);
      write(path, latest.text);
      task.files.set(rel, {
        ...target,
        revision: latest.editRevision ?? 0,
        hash: sha(latest.text),
      });
      this.sceneUpdated?.(target.id);
    }
    this.workspace.event(task.task.conversationId, taskId, 'shell.applied', {
      file: rel,
      revision: result.revision,
    });
    this.applied.get(`${taskId}:${toolId}`)?.push({ path: rel, ...result });
    return result;
  }

  /** Keep the local projection current after an independent app.call save. */
  refreshAfterMutation(taskId: string, name: string, args: Record<string, any>, result: unknown) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const resources =
      name === 'resource.patchMany' && Array.isArray(args.items)
        ? args.items
        : name.startsWith('resource.') || name === 'image.update-metadata'
          ? [args]
          : [];
    for (const item of resources) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id ?? item.contentId ?? '');
      const kind = item.kind as ResourceKind;
      const target = task.files.get(`library/${id}/resource.json`);
      if (
        target?.kind === 'resource' &&
        (kind === target.resourceKind || name === 'image.update-metadata')
      ) {
        const path = join(this.taskDir(taskId), `library/${id}/resource.json`);
        if (existsSync(path) && sha(readFileSync(path, 'utf8')) !== target.hash) continue;
        this.exportResource(taskId, id, target.resourceKind, task.files);
      }
    }
    if (!name.startsWith('scene.')) return;
    const payload = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    const ids = [
      args.sourceId,
      ...(Array.isArray(args.items) ? args.items.map((item: any) => item.sourceId) : []),
      ...(Array.isArray(payload.sourceIds) ? payload.sourceIds : []),
    ];
    for (const id of new Set(ids)) {
      if (typeof id !== 'string') continue;
      for (const [path, target] of task.files) {
        if (target.kind !== 'scene' || target.id !== id) continue;
        const filename = join(this.taskDir(taskId), path);
        if (existsSync(filename) && sha(readFileSync(filename, 'utf8')) !== target.hash) continue;
        const source = this.store.source(id);
        write(filename, source.text);
        task.files.set(path, {
          kind: 'scene',
          id,
          revision: source.editRevision ?? 0,
          hash: sha(source.text),
        });
      }
    }
  }

  async exec(
    task: HelperTask,
    toolId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) {
    if (!process.env.UIMORI_SHELL_ROOT) throw new Error('SHELL_RUNNER_NOT_CONFIGURED');
    this.exportTask(task);
    await this.startBridge();
    const key = `${task.id}:${toolId}`;
    this.active.add(key);
    this.applied.set(key, []);
    try {
      if (signal?.aborted) throw new Error('CANCELLED');
      const result = await rpc(
        join(this.root, '.exec.sock'),
        '/exec',
        {
          taskId: task.id,
          toolId,
          command,
          timeoutMs,
        },
        Math.min(30000, Math.max(1000, timeoutMs)) + 5000
      );
      if (signal?.aborted) throw new Error('CANCELLED');
      return { ...result, applied: this.applied.get(key) ?? [] };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      )
        throw new Error('SHELL_RUNNER_UNAVAILABLE: start the shell-runner Compose service');
      throw error;
    } finally {
      this.active.delete(key);
      this.applied.delete(key);
    }
  }

  close() {
    this.bridge?.close();
    this.bridge = undefined;
  }

  cleanup(taskId: string) {
    this.tasks.delete(taskId);
    rmSync(this.taskDir(taskId), { recursive: true, force: true });
  }
}
