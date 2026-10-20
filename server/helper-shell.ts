import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { join, relative, resolve, dirname } from 'node:path';
import type { HelperTask } from '../core/helper.js';
import {
  editableResource,
  type ContentEditModel,
  type ResourceKind,
  type ResourceModel,
} from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import { readResource } from './resource-service.js';
import { applyHelperResourceMutation } from './helper-resource-undo.js';
import { helperSceneSource } from './helper-scene-tools.js';
import { HttpError, record } from './request-validation.js';
import type { Store } from './store.js';
import type { HelperWorkspace } from './helper-workspace.js';

type FileTarget =
  | {
      kind: 'resource';
      id: string;
      resourceKind: ResourceKind;
      revision: number;
      hash: string;
      title: string;
    }
  | { kind: 'scene'; id: string; chatId: string; revision: number; hash: string };
type TaskFiles = { files: Map<string, FileTarget>; task: HelperTask };
export type HelperShellAppResult = {
  result: unknown;
  denied?: boolean;
  fatalError?: unknown;
  applied?: unknown[];
};
type AppInvoker = (
  name: string,
  args: Record<string, unknown>,
  operationId: string,
  signal: AbortSignal
) => Promise<HelperShellAppResult>;
type Execution = {
  invoke?: AppInvoker;
  controller: AbortController;
  sequence: number;
  fatalError?: unknown;
  pending: Set<Promise<HelperShellAppResult>>;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safeId = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/u.test(s);
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
function json(path: string, value: unknown) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}
/** A transport failure cannot undo saves whose receipts already committed. */
export class HelperShellExecutionError extends Error {
  constructor(
    message: string,
    readonly applied: unknown[]
  ) {
    super(message);
  }
}
class ShellRevisionConflict extends HttpError {
  readonly nextRead: { name: string; arguments: Record<string, unknown> };
  constructor(target: FileTarget, chatId?: string) {
    super(409, 'SHELL_REVISION_CONFLICT');
    this.nextRead = {
      name: 'app.call',
      arguments:
        target.kind === 'resource'
          ? { name: 'resource.read', arguments: { kind: target.resourceKind, id: target.id } }
          : { name: 'scene.read', arguments: { sourceId: target.id, target: 'original', chatId } },
    };
  }
}
/** Compact paths from actual saved values, never another copy of the manuscript. */
function changedPaths(before: unknown, after: unknown) {
  const paths: string[] = [];
  const visit = (a: unknown, b: unknown, path: string) => {
    if (paths.length > 20 || isDeepStrictEqual(a, b)) return;
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      Array.isArray(a) === Array.isArray(b)
    ) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        visit(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')
        );
        if (paths.length > 20) break;
      }
    } else paths.push(path || '/');
  };
  visit(before, after, '');
  return { paths: paths.slice(0, 20), truncated: paths.length > 20 };
}
function rpc(
  socketPath: string,
  path: string,
  payload: unknown,
  timeoutMs = 35000,
  signal?: AbortSignal
): Promise<any> {
  return new Promise((resolveResult, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      {
        socketPath,
        signal,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.setEncoding('utf8');
        let result = '';
        res.on('data', (chunk) => {
          result += chunk;
          if (result.length > 100_000) req.destroy(new Error('SHELL_RESULT_TOO_LARGE'));
        });
        res.once('error', reject);
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
  private readonly active = new Map<string, Execution>();
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
    files: Map<string, FileTarget>,
    file = `library/${id}/resource.json`
  ) {
    if (!safeId(id)) return;
    const resource = readResource(this.store, kind, id);
    const data = editableResource(kind, resource);
    const base = dirname(file);
    const content = JSON.stringify(data, null, 2) + '\n';
    write(join(this.taskDir(taskId), file), content);
    files.set(file, {
      kind: 'resource',
      id,
      resourceKind: kind,
      title: 'title' in resource ? resource.title : '',
      revision: resource.revision,
      hash: sha(content),
    });
    json(join(this.taskDir(taskId), base, 'manifest.json'), {
      id,
      kind,
      revision: resource.revision,
      title: 'title' in resource ? resource.title : '',
      editableFile: 'resource.json',
      ...(kind === 'content'
        ? {
            authoredContentPaths: ['/package/nativeRisu/card', '/package/nativeRisu/module'],
            derivedFields: ['title', 'description', 'text'],
            guidance:
              'Edit native content, not derived title/description/text. Other authored fields keep the existing resource save contract.',
          }
        : {}),
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

  private writeLibraryIndex(taskId: string, files: Map<string, FileTarget>) {
    const index = [...files].flatMap(([file, target]) =>
      target.kind === 'resource' && file === `library/${target.id}/resource.json`
        ? [
            JSON.stringify({
              id: target.id,
              kind: target.resourceKind,
              title: target.title,
              revision: target.revision,
              file,
            }),
          ]
        : []
    );
    write(join(this.taskDir(taskId), 'library/index.jsonl'), index.join('\n') + '\n');
  }

  private writeSceneIndex(taskId: string, file: string, files: Map<string, FileTarget>) {
    const chat = /^chats\/([^/]+)\/scenes\/[^/]+\.txt$/u.exec(file)?.[1];
    if (!chat) return;
    const prefix = `chats/${chat}/scenes/`;
    const scenes = [...files].flatMap(([path, target]) =>
      target.kind === 'scene' && path === `${prefix}${target.id}.txt`
        ? [{ sourceId: target.id, revision: target.revision, file: path }]
        : []
    );
    json(join(this.taskDir(taskId), `chats/${chat}/scenes.json`), scenes);
  }

  private exportTask(task: HelperTask) {
    const base = this.taskDir(task.id);
    if (this.tasks.has(task.id)) return;
    mkdirSync(join(base, 'scratch'), { recursive: true });
    const files = new Map<string, FileTarget>();
    const resources = this.store.db
      .prepare(
        "SELECT v.id, v.kind FROM versions v WHERE v.kind IN ('content','prompt-preset') AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY v.kind,v.id"
      )
      .all() as { id: string; kind: ResourceKind }[];
    for (const r of resources) {
      if (!safeId(r.id)) continue;
      this.exportResource(task.id, r.id, r.kind, files);
    }
    this.writeLibraryIndex(task.id, files);
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
          chatId: chat.id,
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
        'Use `uimori tools` for app operations and `uimori call <name> --input <file|->` for JSON arguments. `uimori --help` shows syntax.\n' +
        'library/index.jsonl lists saved resources; library/<id>/resource.json is editable.\n' +
        'library/<id>/lorebook.jsonl is a derived search index and cannot be applied.\n' +
        'chats/index.jsonl lists chats; chats/<id>/scenes/*.txt are editable originals.\n' +
        'editor/ and current/ are reserved task snapshots, not live editable resources.\n' +
        'Use `uimori apply library/<id>/resource.json` or `uimori apply chats/<id>/scenes/<source-id>.txt` to commit.\n' +
        'Content title/description/text are derived; edit /package/nativeRisu/card or module instead. See manifest.json.\n' +
        'Filter with jq/Python and print only needed fields; keep intermediate data in scratch/.\n' +
        'Use the returned saved paths/revision/hash as confirmation; do not reread whole files after a successful apply.\n' +
        'Use `uimori refresh <path>` for current saved data. Clean files refresh in place; dirty files stay intact and latestPath names a separate editable file. Reconcile into latestPath and apply it.\n' +
        'Do not mistake edited files for saved state before apply returns success.\n'
    );
    this.tasks.set(task.id, { files, task });
  }

  private execution(taskId: unknown, toolId: unknown) {
    if (typeof taskId !== 'string' || typeof toolId !== 'string')
      throw new HttpError(400, 'SHELL_INVALID_SESSION');
    const execution = this.active.get(`${taskId}:${toolId}`);
    if (!execution) throw new HttpError(409, 'SHELL_EXECUTION_NOT_ACTIVE');
    execution.controller.signal.throwIfAborted();
    this.workspace.assertRunning(taskId);
    if (execution.fatalError) throw new HttpError(409, 'SHELL_EXECUTION_STOPPED');
    return execution;
  }

  private async appCall(
    taskId: string,
    toolId: string,
    route: string,
    input: Record<string, unknown>
  ) {
    const execution = this.execution(taskId, toolId);
    if (!execution.invoke) throw new HttpError(400, 'SHELL_APP_UNAVAILABLE');
    const args = record(input.arguments ?? {});
    if (route === '/call' && (typeof input.name !== 'string' || !input.name.trim()))
      throw new HttpError(400, 'APP_OPERATION_NAME_REQUIRED');
    // Leave room for helper:<task UUID>: in existing 120-character save keys.
    const operationId = `shell:${toolId.slice(0, 48)}:app:${++execution.sequence}`;
    const pending = execution.invoke(
      route === '/tools' ? 'app.tools' : String(input.name),
      args,
      operationId,
      execution.controller.signal
    );
    execution.pending.add(pending);
    try {
      const response = await pending;
      const receipts = this.applied.get(`${taskId}:${toolId}`);
      for (const applied of response.applied ?? []) receipts?.push(applied);
      if (response.fatalError) execution.fatalError = response.fatalError;
      return response;
    } catch (error) {
      if (!(error instanceof HttpError && error.statusCode < 500)) execution.fatalError = error;
      throw error;
    } finally {
      execution.pending.delete(pending);
    }
  }

  private async startBridge() {
    if (this.bridge) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((done, fail) => {
      mkdirSync(this.root, { recursive: true });
      const socket = join(this.root, '.apply.sock');
      rmSync(socket, { force: true });
      const server = createServer((req, res) => {
        const route = req.url ?? '';
        if (!['/apply', '/refresh', '/tools', '/call'].includes(route) || req.method !== 'POST') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16_000_000) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'SHELL_INPUT_TOO_LARGE' }));
            req.destroy();
          } else chunks.push(chunk);
        });
        req.on('end', async () => {
          if (bytes > 16_000_000) return;
          try {
            const input = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            this.execution(input.taskId, input.toolId);
            const taskId = input.taskId as string;
            const toolId = input.toolId as string;
            const response =
              route === '/call' || route === '/tools'
                ? await this.appCall(taskId, toolId, route, input)
                : {
                    result:
                      route === '/refresh'
                        ? this.refresh(taskId, input.path)
                        : this.apply(taskId, toolId, input.path),
                  };
            res.writeHead(response.fatalError ? 500 : response.denied ? 400 : 200, {
              'content-type': 'application/json',
            });
            res.end(JSON.stringify(response.result ?? null));
          } catch (error) {
            res.writeHead(error instanceof HttpError ? error.statusCode : 500, {
              'content-type': 'application/json',
            });
            res.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'SHELL_REQUEST_FAILED',
                ...(error instanceof ShellRevisionConflict
                  ? {
                      outcome: 'unchanged',
                      nextRead: error.nextRead,
                      guidance:
                        'Local edits are preserved. Run uimori refresh on this file, reconcile into the returned latestPath, then apply latestPath. Alternatively use app.call with the returned nextRead and current guards.',
                    }
                  : {}),
              })
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

  private refresh(taskId: string, name: unknown) {
    if (typeof name !== 'string') throw new HttpError(400, 'SHELL_PATH_REQUIRED');
    const task = this.tasks.get(taskId)!;
    const base = this.taskDir(taskId);
    const path = resolve(base, name);
    const rel = relative(base, path).replaceAll('\\', '/');
    const target = task.files.get(rel);
    if (!target || !existsSync(path) || realpathSync(path) !== path)
      throw new HttpError(400, 'SHELL_FILE_NOT_EDITABLE');
    const dirty = sha(readFileSync(path, 'utf8')) !== target.hash;
    const latestPath = dirty
      ? `scratch/refresh-${randomUUID()}/${target.kind === 'resource' ? 'resource.json' : 'scene.txt'}`
      : rel;
    if (target.kind === 'resource') {
      this.exportResource(taskId, target.id, target.resourceKind, task.files, latestPath);
      this.writeLibraryIndex(taskId, task.files);
    } else {
      const current = helperSceneSource(this.store, target.chatId, target.id);
      write(join(base, latestPath), current.text);
      task.files.set(latestPath, {
        ...target,
        revision: current.editRevision ?? 0,
        hash: sha(current.text),
      });
      this.writeSceneIndex(taskId, latestPath, task.files);
    }
    const latest = task.files.get(latestPath)!;
    return {
      id: target.id,
      path: rel,
      latestPath,
      dirty,
      revision: latest.revision,
      contentHash: latest.hash,
      ...(dirty
        ? {
            guidance:
              'Local draft preserved at path. Reconcile into latestPath, then apply latestPath.',
          }
        : {}),
    };
  }

  private apply(taskId: unknown, toolId: unknown, name: unknown) {
    this.execution(taskId, toolId);
    if (typeof taskId !== 'string' || typeof toolId !== 'string' || typeof name !== 'string')
      throw new HttpError(400, 'SHELL_PATH_REQUIRED');
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
    const input = {
      kind: target.kind,
      id: target.id,
      revision: target.revision,
      digest: sha(content),
    };
    const prior = this.workspace.operationResult<{
      id: string;
      revision: number;
      receiptId: string;
    }>(taskId, operationId, input);
    let before: ResourceModel | undefined;
    let model: Record<string, unknown> | undefined;
    if (!prior && target.kind === 'resource') {
      const current = readResource(this.store, target.resourceKind, target.id);
      if (current.revision !== target.revision) throw new ShellRevisionConflict(target);
      before = editableResource(target.resourceKind, current);
      model = record(JSON.parse(content));
      if (isDeepStrictEqual(before, model)) {
        this.exportResource(taskId, target.id, target.resourceKind, task.files, rel);
        return { changed: false, id: target.id, revision: current.revision };
      }
    } else if (!prior && target.kind === 'scene') {
      const current = helperSceneSource(this.store, target.chatId, target.id);
      if ((current.editRevision ?? 0) !== target.revision)
        throw new ShellRevisionConflict(target, current.chatId);
    }

    const result =
      prior ??
      this.workspace.operation(taskId, operationId, input, () => {
        let savedResult: { id: string; revision: number } & Record<string, unknown>;
        if (target.kind === 'scene') {
          const saved = this.store.editSource(target.id, {
            text: content,
            expectedRevision: target.revision,
          });
          savedResult = {
            changed: true,
            id: target.id,
            revision: saved.editRevision ?? 0,
            contentHash: sha(saved.text),
            changedPaths: ['/text'],
            textLength: saved.text.length,
          };
        } else {
          applyHelperResourceMutation(
            this.store,
            this.workspace,
            task.task,
            operationId,
            'resource.save',
            { kind: target.resourceKind, id: target.id, expectedRevision: target.revision, model },
            { kind: target.resourceKind, id: target.id }
          );
          const saved = readResource(this.store, target.resourceKind, target.id);
          const after = editableResource(target.resourceKind, saved);
          // The package revision is assigned by the save, not an authored content change.
          const comparable =
            target.resourceKind === 'content'
              ? {
                  ...after,
                  package: {
                    ...(after as ContentEditModel).package,
                    revision: (before as ContentEditModel).package.revision,
                  },
                }
              : after;
          if (isDeepStrictEqual(before, comparable))
            throw new HttpError(
              400,
              'SHELL_NO_AUTHORED_CHANGE: The submitted edits do not change saved data. Content title/description/text are derived; edit the native card/module paths in manifest.json. Your local file is preserved.'
            );
          const changed = changedPaths(before, comparable);
          const normalized = changedPaths(model, comparable);
          savedResult = {
            changed: true,
            id: target.id,
            revision: saved.revision,
            contentHash: sha(JSON.stringify(after, null, 2) + '\n'),
            changedPaths: changed.paths,
            changesTruncated: changed.truncated,
            ...(normalized.paths.length
              ? { normalizedPaths: normalized.paths, normalizationTruncated: normalized.truncated }
              : {}),
          };
        }
        this.workspace.event(task.task.conversationId, taskId, 'shell.applied', {
          file: rel,
          revision: savedResult.revision,
        });
        return { ...savedResult, receiptId: operationId };
      });
    // Record commit before fallible filesystem refresh or post-commit notifications.
    const applied: Record<string, unknown> = { path: rel, ...result };
    const receipts = this.applied.get(`${taskId}:${toolId}`);
    if (!receipts?.some((item) => (item as { receiptId?: string }).receiptId === operationId))
      receipts?.push(applied);
    try {
      if (target.kind === 'resource') {
        this.exportResource(taskId, target.id, target.resourceKind, task.files, rel);
        this.refreshAfterMutation(
          taskId,
          'resource.save',
          { kind: target.resourceKind, id: target.id },
          result,
          rel
        );
        this.writeLibraryIndex(taskId, task.files);
      } else {
        const latest = this.store.source(target.id);
        write(path, latest.text);
        task.files.set(rel, {
          ...target,
          revision: latest.editRevision ?? 0,
          hash: sha(latest.text),
        });
        this.refreshAfterMutation(taskId, 'scene.patch', { sourceId: target.id }, result, rel);
        this.writeSceneIndex(taskId, rel, task.files);
      }
    } catch {
      applied.warning =
        'SHELL_PROJECTION_REFRESH_FAILED: Saved successfully; the local file may be stale. Inspect the saved data through app.call before further edits.';
    }
    if (target.kind === 'scene') {
      try {
        this.sceneUpdated?.(target.id);
      } catch {
        applied.notificationWarning = 'Saved successfully; reader notification failed.';
      }
    }
    return applied;
  }

  /** Keep the local projection current after an independent app.call save. */
  refreshAfterMutation(
    taskId: string,
    name: string,
    args: Record<string, any>,
    result: unknown,
    refreshedPath?: string
  ) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const payload = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    const resources =
      name === 'resource.patchMany' && Array.isArray(args.items)
        ? args.items
        : name === 'resource.clone' || (name === 'resource.save' && !args.id)
          ? [{ kind: args.kind, id: payload.id }]
          : name.startsWith('resource.') || name === 'image.update-metadata'
            ? [args]
            : [];
    let libraryChanged = false;
    for (const item of resources) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id ?? item.contentId ?? '');
      const kind = item.kind as ResourceKind;
      const target = task.files.get(`library/${id}/resource.json`);
      const resourceKind =
        name === 'image.update-metadata' && target?.kind === 'resource'
          ? target.resourceKind
          : kind;
      if (!safeId(id) || (resourceKind !== 'content' && resourceKind !== 'prompt-preset')) continue;
      const targets: [string, FileTarget | undefined][] = [...task.files].filter(
        ([, value]) => value.kind === 'resource' && value.id === id
      );
      if (name === 'resource.delete') {
        for (const [file] of targets) task.files.delete(file);
        libraryChanged = true;
        continue;
      }
      if (!targets.length) targets.push([`library/${id}/resource.json`, undefined]);
      for (const [file, existing] of targets) {
        if (file === refreshedPath) continue;
        const path = join(this.taskDir(taskId), file);
        // Keep dirty drafts and their original revision until explicitly reconciled.
        if (existing && existsSync(path) && sha(readFileSync(path, 'utf8')) !== existing.hash)
          continue;
        if (!existing && existsSync(path)) continue;
        this.exportResource(taskId, id, resourceKind, task.files, file);
        libraryChanged = true;
      }
    }
    if (libraryChanged) this.writeLibraryIndex(taskId, task.files);
    if (!name.startsWith('scene.')) return;
    const ids = [
      args.sourceId,
      ...(Array.isArray(args.items) ? args.items.map((item: any) => item.sourceId) : []),
      ...(Array.isArray(payload.sourceIds) ? payload.sourceIds : []),
    ];
    for (const id of new Set(ids)) {
      if (typeof id !== 'string') continue;
      for (const [path, target] of task.files) {
        if (target.kind !== 'scene' || target.id !== id || path === refreshedPath) continue;
        const filename = join(this.taskDir(taskId), path);
        if (existsSync(filename) && sha(readFileSync(filename, 'utf8')) !== target.hash) continue;
        const source = this.store.source(id);
        write(filename, source.text);
        task.files.set(path, {
          ...target,
          revision: source.editRevision ?? 0,
          hash: sha(source.text),
        });
        this.writeSceneIndex(taskId, path, task.files);
      }
    }
  }

  async exec(
    task: HelperTask,
    toolId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    invoke?: AppInvoker
  ) {
    signal?.throwIfAborted();
    if (!process.env.UIMORI_SHELL_ROOT) throw new HttpError(400, 'SHELL_RUNNER_NOT_CONFIGURED');
    this.exportTask(task);
    await this.startBridge();
    const key = `${task.id}:${toolId}`;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const execution: Execution = { invoke, controller, sequence: 0, pending: new Set() };
    this.active.set(key, execution);
    this.applied.set(key, []);
    try {
      let result: any;
      let failure: unknown;
      try {
        signal?.throwIfAborted();
        result = await rpc(
          join(this.root, '.exec.sock'),
          '/exec',
          { taskId: task.id, toolId, command, timeoutMs },
          Math.min(30000, Math.max(1000, timeoutMs)) + 5000,
          signal
        );
      } catch (error) {
        failure = error;
      } finally {
        // A completed, timed out, or disconnected shell owns no further app work.
        controller.abort();
        await Promise.allSettled([...execution.pending]);
      }
      if (execution.fatalError) throw execution.fatalError;
      if (failure) throw failure;
      signal?.throwIfAborted();
      return { ...result, applied: this.applied.get(key) ?? [] };
    } catch (error) {
      if (
        !execution.fatalError &&
        !this.applied.get(key)?.length &&
        ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
      )
        throw new HttpError(
          400,
          'SHELL_RUNNER_UNAVAILABLE: start the shell-runner Compose service'
        );
      throw new HelperShellExecutionError(
        error instanceof Error ? error.message : 'SHELL_EXECUTION_FAILED',
        this.applied.get(key) ?? []
      );
    } finally {
      signal?.removeEventListener('abort', abort);
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
