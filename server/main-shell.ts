import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { shellExecutionOptions } from '../core/main-shell.js';
import { roleResources } from '../core/provider.js';
import { conversationSummary } from '../core/context-projection.js';
import { editableResource, type ResourceKind } from '../core/resource-editing.js';
import type { RunSnapshot } from '../core/types.js';
import { readResource } from './resource-service.js';
import { shellRunnerRpc } from './shell-transport.js';
import type { Store } from './store.js';

const safeId = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(s);
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}
function json(path: string, value: unknown) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}
function jsonl(path: string, values: unknown[]) {
  write(
    path,
    values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '')
  );
}

/** Read-only app projection; commands may freely change their disposable workspace. */
export class MainShell {
  readonly root = resolve(process.env.UIMORI_SHELL_ROOT ?? '/helper-workspaces');
  readonly directory: string;
  private bridge?: Server;
  private starting?: Promise<void>;
  private readonly active = new Map<string, AbortSignal | undefined>();

  constructor(
    readonly store?: Store,
    readonly id: string = randomUUID()
  ) {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('SHELL_RUN_ID_INVALID');
    this.directory = join(this.root, 'tasks', id);
  }

  private prepare(snapshot: RunSnapshot) {
    const ready = join(this.directory, '.main-ready');
    // Batch/resumed runs retain scratch files and the original admitted snapshot.
    if (existsSync(ready)) return;
    mkdirSync(join(this.directory, 'scratch'), { recursive: true });
    const resources = roleResources(snapshot);
    jsonl(
      join(this.directory, 'current/resources.jsonl'),
      resources.map((resource, i) => {
        const file = `current/resources/${i}.txt`;
        write(join(this.directory, file), resource.text);
        const { text, ...metadata } = resource;
        return { ...metadata, file, charCount: text.length };
      })
    );
    json(
      join(this.directory, 'current/scenes.json'),
      snapshot.history.map((scene, i) => {
        const file = `current/scenes/${i}.txt`;
        write(join(this.directory, file), scene.text);
        const { text, ...metadata } = scene;
        return { ...metadata, file, charCount: text.length };
      })
    );
    json(join(this.directory, 'current/summary.json'), conversationSummary(snapshot) ?? null);
    write(join(this.directory, 'current/summary.txt'), conversationSummary(snapshot)?.text ?? '');
    json(join(this.directory, 'current/metadata.json'), {
      chatId: snapshot.chatId,
      parentRevision: snapshot.parentRevision,
      request: snapshot.nativeRisuExecution?.request ?? snapshot.request,
      notes: snapshot.story?.notes ?? [],
      outline: snapshot.outline ?? null,
    });
    write(
      join(this.directory, 'INDEX.md'),
      '# Writing workspace\n\n' +
        'Use Bash, rg, jq, Python and Node freely. Print useful excerpts or analysis; no special output format is required.\n' +
        'current/resources.jsonl indexes the frozen effective main-role references; current/resources/*.txt contains their bodies.\n' +
        'current/scenes.json and current/scenes/*.txt contain the full frozen ancestry, including scenes excluded from model context (sceneContext.sceneEnabled=false).\n' +
        'current/summary.txt and summary.json contain the existing derived summary, not new canon; metadata.json has the request, notes and outline.\n' +
        'Other saved data is available on demand: `uimori export \'{"scope":"library"}\'` or `uimori export \'{"scope":"chats"}\'` writes an index.\n' +
        'Add `"id":"..."` to export one full resource/chat, or `"all":true` to export all of that scope. Re-export to refresh live files.\n' +
        'library/ and chats/ are live reads and can differ from current/. Edits here never save into Uimori.\n' +
        'scratch/ holds temporary work and full execution logs. Filter an outputFile to inspect more without repeating work.\n'
    );
    write(ready, '1\n');
  }

  private exportData(args: Record<string, unknown>) {
    if (!this.store) throw new Error('SHELL_SAVED_DATA_UNAVAILABLE');
    if (args.id !== undefined && !safeId(args.id)) throw new Error('SHELL_EXPORT_ID_INVALID');
    if (args.scope === 'library') {
      const rows = this.store.db
        .prepare(
          "SELECT v.id,v.kind,v.revision,json_extract(v.body,'$.title') AS title FROM versions v WHERE v.kind IN ('content','prompt-preset') AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY v.kind,v.id"
        )
        .all() as { id: string; kind: ResourceKind; revision: number; title: string }[];
      const index = rows
        .filter((row) => safeId(row.id))
        .map((row) => ({
          ...row,
          file: `library/${row.id}/resource.json`,
        }));
      jsonl(join(this.directory, 'library/index.jsonl'), index);
      const selected = index.filter((row) => args.all === true || row.id === args.id);
      if (args.id && !selected.length) throw new Error('SHELL_EXPORT_NOT_FOUND');
      for (const row of selected)
        json(
          join(this.directory, row.file),
          editableResource(row.kind, readResource(this.store, row.kind, row.id))
        );
      return {
        index: 'library/index.jsonl',
        exported: selected.map((row) => row.file),
        count: index.length,
      };
    }
    if (args.scope === 'chats') {
      const chats = this.store.chats().filter((chat) => safeId(chat.id));
      jsonl(
        join(this.directory, 'chats/index.jsonl'),
        chats.map(({ id, title, headRevision }) => ({ id, title, headRevision }))
      );
      const selected = chats.filter((chat) => args.all === true || chat.id === args.id);
      if (args.id && !selected.length) throw new Error('SHELL_EXPORT_NOT_FOUND');
      for (const chat of selected) {
        const scenes = this.store.history(chat.headRevision).map((scene, i) => {
          const file = `chats/${chat.id}/scenes/${i}.txt`;
          write(join(this.directory, file), scene.text);
          const { text, ...metadata } = scene;
          return { ...metadata, file, charCount: text.length };
        });
        json(join(this.directory, `chats/${chat.id}/scenes.json`), scenes);
        json(join(this.directory, `chats/${chat.id}/metadata.json`), chat);
      }
      return {
        index: 'chats/index.jsonl',
        exported: selected.map((chat) => `chats/${chat.id}/scenes.json`),
        count: chats.length,
      };
    }
    throw new Error('SHELL_EXPORT_SCOPE_REQUIRED: use library or chats');
  }

  private async startBridge() {
    if (this.bridge) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((done, fail) => {
      const socket = join(this.directory, '.read.sock');
      rmSync(socket, { force: true });
      const server = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/export') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (input.taskId !== this.id || !this.active.has(input.toolId))
              throw new Error('SHELL_EXECUTION_NOT_ACTIVE');
            this.active.get(input.toolId)?.throwIfAborted();
            const args = input.arguments;
            if (!args || typeof args !== 'object' || Array.isArray(args))
              throw new Error('SHELL_EXPORT_ARGUMENTS_INVALID');
            const result = this.exportData(args);
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'SHELL_EXPORT_FAILED',
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

  async run(
    snapshot: RunSnapshot,
    callId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    const options = shellExecutionOptions(args);
    if (!process.env.UIMORI_SHELL_ROOT) throw new Error('SHELL_RUNNER_NOT_CONFIGURED');
    this.prepare(snapshot);
    await this.startBridge();
    signal?.throwIfAborted();
    this.active.set(callId, signal);
    try {
      return await shellRunnerRpc(
        join(this.root, '.exec.sock'),
        '/exec',
        {
          taskId: this.id,
          toolId: callId,
          workspaceKind: 'main',
          ...options,
        },
        options.timeoutMs + 5000,
        signal
      );
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw new Error('SHELL_RUNNER_UNAVAILABLE: start the shell-runner Compose service');
      throw error;
    } finally {
      this.active.delete(callId);
    }
  }

  close() {
    this.bridge?.close();
    this.bridge = undefined;
  }

  cleanup() {
    this.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
