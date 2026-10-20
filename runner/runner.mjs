import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(process.env.UIMORI_SHELL_ROOT ?? '/workspace');
const socket = join(root, '.exec.sock');
mkdirSync(root, { recursive: true });
rmSync(socket, { force: true });

function reply(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}
function run(args) {
  return new Promise((done) => {
    const taskId = args.taskId;
    if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/u.test(taskId) ||
        typeof args.command !== 'string' || args.command.length > 50000 ||
        typeof args.toolId !== 'string' || args.toolId.length > 150) {
      done({ error: 'INVALID_EXEC_REQUEST' });
      return;
    }
    const cwd = join(root, 'tasks', taskId);
    try { if (!statSync(cwd).isDirectory()) throw Error('no directory'); }
    catch { done({ error: 'WORKSPACE_NOT_FOUND' }); return; }
    const scratch = join(cwd, 'scratch');
    mkdirSync(scratch, { recursive: true });
    const outputFile = join(scratch, `exec-${randomUUID()}.log`);
    const fd = openSync(outputFile, 'w');
    const timeoutMs = Math.min(30000, Math.max(1000, Number(args.timeoutMs) || 10000));
    const child = spawn('/bin/bash', ['-c', args.command], {
      cwd, detached: true, stdio: ['ignore', fd, fd],
      env: {
        PATH: '/runner/bin:/usr/local/bin:/usr/bin:/bin',
        HOME: scratch,
        TMPDIR: scratch,
        UIMORI_TASK_ID: taskId,
        UIMORI_TOOL_ID: args.toolId,
        UIMORI_BRIDGE_SOCKET: join(root, '.apply.sock'),
      },
    });
    closeSync(fd);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      done({ error: err.message });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const max = 16384;
      let content = '';
      let truncated = false;
      try {
        const size = statSync(outputFile).size;
        const log = openSync(outputFile, 'r');
        try {
          const bytes = Buffer.alloc(Math.min(max, size));
          const count = readSync(log, bytes, 0, bytes.length, 0);
          content = bytes.subarray(0, count).toString('utf8');
          truncated = size > count;
        } finally { closeSync(log); }
      } catch { /* failure is reported by status */ }
      done({
        exitCode: code,
        signal,
        timedOut,
        output: truncated ? content.slice(0, max) : content,
        truncated,
        ...(truncated ? { outputFile: 'scratch/' + outputFile.split('/').at(-1) } : {}),
      });
    });
  });
}
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/exec') return reply(res, 404, { error: 'NOT_FOUND' });
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 60000) req.destroy();
  });
  req.on('end', async () => {
    try { reply(res, 200, await run(JSON.parse(body))); }
    catch (error) { reply(res, 500, { error: String(error) }); }
  });
});
server.listen(socket);
process.on('SIGTERM', () => { server.close(); });
