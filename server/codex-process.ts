import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type CodexProcessErrorCode =
  | 'CODEX_START_FAILED'
  | 'CODEX_CLOSED'
  | 'CODEX_PROTOCOL_ERROR'
  | 'CODEX_REQUEST_FAILED'
  | 'CODEX_TIMEOUT'
  | 'CODEX_CANCELLED';
/** Never include provider errors, stderr, request parameters, or auth data. */
export class CodexProcessError extends Error {
  constructor(readonly code: CodexProcessErrorCode) {
    super(code);
    this.name = 'CodexProcessError';
  }
}
export interface CodexProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  experimentalApi?: boolean;
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 64;

/** One official app-server stdio session; never restarts or replays a request. */
export class CodexProcess {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = new Map<number, Pending>();
  private notifications = new Set<(method: string, params: unknown) => void>();
  private exits = new Set<() => void>();
  constructor(private readonly options: CodexProcessOptions) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new CodexProcessError('CODEX_CLOSED'));
    return (this.starting ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    try {
      this.child = spawn(this.options.command, this.options.args ?? ['app-server'], {
        cwd: this.options.cwd,
        env: this.options.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.on('error', () => this.fail('CODEX_START_FAILED'));
      this.child.on('exit', () => this.fail('CODEX_CLOSED'));
      this.child.on('close', () => this.fail('CODEX_CLOSED'));
      this.child.stdin.on('error', () => this.fail('CODEX_CLOSED'));
      this.child.stdout.on('error', () => this.fail('CODEX_PROTOCOL_ERROR'));
      this.child.stdout.on('data', (data: Buffer) => this.receive(data));
      this.child.stdout.on('end', () => {
        if (this.buffer.length) this.fail('CODEX_PROTOCOL_ERROR');
      });
      // Drain without retaining, logging, or forwarding potentially sensitive stderr.
      this.child.stderr.on('error', () => {});
      this.child.stderr.resume();
      await this.request('initialize', {
        clientInfo: { name: 'uimori', title: 'Uimori', version: '0.0.1' },
        capabilities: {
          experimentalApi: this.options.experimentalApi ?? false,
          requestAttestation: false,
        },
      });
      this.write({ method: 'initialized' });
    } catch (error) {
      this.fail(error instanceof CodexProcessError ? error.code : 'CODEX_START_FAILED');
      throw error instanceof CodexProcessError
        ? error
        : new CodexProcessError('CODEX_START_FAILED');
    }
  }

  request<T>(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new CodexProcessError('CODEX_CLOSED'));
    if (options.signal?.aborted) return Promise.reject(new CodexProcessError('CODEX_CANCELLED'));
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new CodexProcessError('CODEX_REQUEST_FAILED'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = (code: CodexProcessErrorCode) => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.cleanup();
        item.reject(new CodexProcessError(code));
      };
      const abort = () => finish('CODEX_CANCELLED');
      const timeout = setTimeout(
        () => finish('CODEX_TIMEOUT'),
        options.timeoutMs ?? this.options.timeoutMs ?? 30_000
      );
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup });
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        this.write({ id, method, params });
      } catch {
        finish('CODEX_CLOSED');
      }
    });
  }
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notifications.add(listener);
    return () => {
      this.notifications.delete(listener);
    };
  }
  onExit(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.exits.add(listener);
    return () => {
      this.exits.delete(listener);
    };
  }
  private write(value: unknown): void {
    if (this.closed || !this.child?.stdin.writable) throw new CodexProcessError('CODEX_CLOSED');
    let line: string;
    try {
      line = JSON.stringify(value) + '\n';
    } catch {
      throw new CodexProcessError('CODEX_REQUEST_FAILED');
    }
    if (
      Buffer.byteLength(line) > MAX_LINE_BYTES ||
      this.child.stdin.writableLength > MAX_LINE_BYTES
    ) {
      this.fail('CODEX_PROTOCOL_ERROR');
      throw new CodexProcessError('CODEX_PROTOCOL_ERROR');
    }
    this.child.stdin.write(line);
  }
  private receive(data: Buffer): void {
    if (this.closed) return;
    let start = 0;
    while (start < data.length && !this.closed) {
      const newline = data.indexOf(10, start);
      const end = newline < 0 ? data.length : newline;
      if (this.buffer.length + end - start > MAX_LINE_BYTES) {
        this.fail('CODEX_PROTOCOL_ERROR');
        return;
      }
      this.buffer = Buffer.concat([this.buffer, data.subarray(start, end)]);
      if (newline < 0) return;
      try {
        const line = this.decoder.decode(this.buffer);
        this.buffer = Buffer.alloc(0);
        this.dispatch(JSON.parse(line));
      } catch {
        this.fail('CODEX_PROTOCOL_ERROR');
        return;
      }
      start = newline + 1;
    }
  }
  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    const record = message as Record<string, unknown>;
    if ('method' in record) {
      if (typeof record.method !== 'string') throw new Error();
      if ('id' in record) {
        if (typeof record.id !== 'number' && typeof record.id !== 'string') throw new Error();
        // No approvals, shell, filesystem, credentials, or dynamic tools are granted here.
        this.write({
          id: record.id,
          error: { code: -32601, message: 'Client request not supported' },
        });
        for (const listener of this.notifications) {
          try {
            listener('uimori/unsupportedRequest', { method: record.method });
          } catch {}
        }
      } else
        for (const listener of this.notifications) {
          try {
            listener(record.method, record.params);
          } catch {
            /* Consumer failure is not provider data. */
          }
        }
      return;
    }
    if (typeof record.id !== 'number' || 'result' in record === 'error' in record)
      throw new Error();
    const item = this.pending.get(record.id);
    if (!item) return; // Timed-out/cancelled requests can still finish; never replay them.
    this.pending.delete(record.id);
    item.cleanup();
    if ('error' in record) item.reject(new CodexProcessError('CODEX_REQUEST_FAILED'));
    else item.resolve(record.result);
  }
  private fail(code: CodexProcessErrorCode): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(new CodexProcessError(code));
    }
    this.pending.clear();
    this.child?.stdin.destroy();
    this.child?.kill();
    for (const listener of this.exits) {
      try {
        listener();
      } catch {}
    }
    this.exits.clear();
    this.notifications.clear();
  }
  close(): Promise<void> {
    return (this.closing ??= new Promise<void>((resolve) => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        this.fail('CODEX_CLOSED');
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener('close', finish);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, 1000);
      child.once('close', finish);
      this.fail('CODEX_CLOSED');
    }));
  }
}
