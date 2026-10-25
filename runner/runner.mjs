import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const root = resolve(process.env.UIMORI_SHELL_ROOT ?? '/workspace');
const socket = join(root, '.exec.sock');
const maxCommandLength = 50000;
const maxToolIdLength = 150;
// A JSON-escaped UTF-16 code unit needs up to six bytes, plus envelope fields.
const maxRequestBytes = 6 * (maxCommandLength + maxToolIdLength) + 1024;
const active = new Set();
mkdirSync(root, { recursive: true });
rmSync(socket, { force: true });

function reply(res, code, data) {
  if (res.destroyed) return;
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readOutput(path, max) {
  const marker = '\n... [output truncated] ...\n';
  const size = statSync(path).size;
  const log = openSync(path, 'r');
  try {
    const read = (offset, length) => {
      const bytes = Buffer.alloc(length);
      return bytes.subarray(0, readSync(log, bytes, 0, length, offset));
    };
    const first = read(0, Math.min(max, size));
    const whole = first.toString('utf8');
    if (size <= max && Buffer.byteLength(whole) <= max) {
      return { output: whole, truncated: false };
    }
    const budget = Math.floor((max - Buffer.byteLength(marker)) / 2);
    const head = new StringDecoder('utf8').write(first.subarray(0, budget));
    let tail = read(Math.max(0, size - budget), Math.min(budget, size));
    // Do not show replacement characters just because a preview split a UTF-8 character.
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    tail = Buffer.from(tail.subarray(start).toString('utf8'));
    start = Math.max(0, tail.length - budget);
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    // Invalid/binary output can expand during decoding; the displayed preview stays bounded.
    const boundedHead = new StringDecoder('utf8').write(Buffer.from(head).subarray(0, budget));
    return {
      output: boundedHead + marker + tail.subarray(start).toString('utf8'),
      truncated: true,
    };
  } finally {
    closeSync(log);
  }
}

function run(args, signal) {
  return new Promise((done) => {
    const taskId = args?.taskId;
    if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/u.test(taskId) ||
        typeof args.command !== 'string' || args.command.length > maxCommandLength ||
        typeof args.toolId !== 'string' || args.toolId.length > maxToolIdLength) {
      done({ error: 'INVALID_EXEC_REQUEST' });
      return;
    }
    if (signal.aborted) { done({ error: 'EXEC_CANCELLED' }); return; }
    const cwd = join(root, 'tasks', taskId);
    try { if (!statSync(cwd).isDirectory()) throw Error('no directory'); }
    catch { done({ error: 'WORKSPACE_NOT_FOUND' }); return; }
    const scratch = join(cwd, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const outputFile = join(scratch, `exec-${randomUUID()}.log`);
    const fd = openSync(outputFile, 'w');
    const timeoutMs = Math.min(300000, Math.max(1000, Number(args.timeoutMs) || 10000));
    const maxOutputBytes = Math.min(65536, Math.max(256, Math.floor(Number(args.maxOutputBytes) || 16384)));
    let child;
    try {
      child = spawn('/bin/bash', ['-c', args.command], {
        cwd, detached: true, stdio: ['ignore', fd, fd],
        env: {
          PATH: '/runner/bin:/usr/local/bin:/usr/bin:/bin',
          HOME: scratch,
          TMPDIR: scratch,
          UIMORI_TASK_ID: taskId,
          UIMORI_TOOL_ID: args.toolId,
          UIMORI_BRIDGE_SOCKET: args.workspaceKind === 'main' ? join(cwd, '.read.sock') : join(root, '.apply.sock'),
        },
      });
    } finally {
      closeSync(fd);
    }
    const terminate = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    };
    active.add(terminate);
    signal.addEventListener('abort', terminate, { once: true });
    let timedOut = false;
    let spawnError;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', terminate);
      active.delete(terminate);
      // data.exec is synchronous: a finished shell must not leave background writers.
      terminate();
      if (spawnError) { done({ error: spawnError.message }); return; }
      let output;
      try { output = readOutput(outputFile, maxOutputBytes); }
      catch (error) { output = { output: '', truncated: false, outputError: String(error) }; }
      done({
        exitCode: code,
        signal: exitSignal,
        timedOut,
        ...output,
        outputFile: 'scratch/' + outputFile.split('/').at(-1),
      });
    });
  });
}
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/exec') return reply(res, 404, { error: 'NOT_FOUND' });
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  res.once('close', disconnect);
  const chunks = [];
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    try {
      const result = await run(JSON.parse(Buffer.concat(chunks).toString('utf8')), controller.signal);
      reply(res, 200, result);
    } catch (error) {
      reply(res, 500, { error: String(error) });
    } finally {
      res.removeListener('close', disconnect);
    }
  });
});
server.listen(socket);
process.on('SIGTERM', () => {
  server.close();
  for (const terminate of active) terminate();
});
