import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';

const socketPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\uimori-cli-${randomUUID()}`
    : join(tmpdir(), `uimori-cli-${randomUUID()}.sock`);
const server = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: request.url, payload: JSON.parse(body) }));
  });
});

beforeAll(() => new Promise<void>((done) => server.listen(socketPath, done)));
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const runCli = (...args: string[]) =>
  promisify(execFile)(process.execPath, [resolve('runner/uimori.mjs'), ...args], {
    env: {
      ...process.env,
      UIMORI_TASK_ID: 'cli-test-task',
      UIMORI_TOOL_ID: 'cli-test-tool',
      UIMORI_BRIDGE_SOCKET: socketPath,
    },
  });

test('CLI accepts schema camelCase flags alongside kebab-case aliases', async () => {
  const images = await runCli(
    'call',
    'image.list',
    '--contentId',
    '0731ff7a-75c4-4875-abad-4aba23f213be',
    '--limit',
    '3'
  );
  expect(JSON.parse(images.stdout).payload).toMatchObject({
    name: 'image.list',
    flagArguments: { contentId: '0731ff7a-75c4-4875-abad-4aba23f213be', limit: '3' },
  });

  const rename = await runCli('call', 'chat.rename', '--title', '123', '--expectedRevision', '2');
  expect(JSON.parse(rename.stdout).payload).toMatchObject({
    name: 'chat.rename',
    flagArguments: { title: '123', expectedRevision: '2' },
  });
});

test('CLI rejects unsupported flag syntax and repeated aliases before calling the bridge', async () => {
  for (const flag of ['--__proto__', '--content.id', '--content[id]', '--content_id']) {
    await expect(runCli('call', 'image.list', flag, 'value')).rejects.toMatchObject({
      code: 2,
      stdout: '',
      stderr: expect.stringContaining('Expected --key value pairs'),
    });
  }
  await expect(
    runCli('call', 'image.list', '--content-id', 'first', '--contentId', 'second')
  ).rejects.toMatchObject({
    code: 2,
    stdout: '',
    stderr: expect.stringContaining('Repeated option --contentId'),
  });
});

test('CLI passes a help-looking flag value to the bridge as data', async () => {
  const { stdout } = await runCli(
    'call',
    'chat.rename',
    '--title',
    '--help',
    '--expected-revision',
    '3'
  );
  expect(JSON.parse(stdout)).toEqual({
    path: '/call',
    payload: {
      taskId: 'cli-test-task',
      toolId: 'cli-test-tool',
      name: 'chat.rename',
      flagArguments: { title: '--help', expectedRevision: '3' },
    },
  });
});

test('CLI accepts whitespace before JSON while preserving authored string values', async () => {
  const call = await runCli(
    'call',
    'chat.rename',
    ' \n {"title":"  --help  ","expectedRevision":3}'
  );
  expect(JSON.parse(call.stdout)).toMatchObject({
    path: '/call',
    payload: {
      name: 'chat.rename',
      arguments: { title: '  --help  ', expectedRevision: 3 },
    },
  });

  const tools = await runCli('tools', ' \t{"names":["chat.read"]}');
  expect(JSON.parse(tools.stdout)).toMatchObject({
    path: '/tools',
    payload: { arguments: { names: ['chat.read'] } },
  });

  const patch = await runCli(
    'call',
    'resource.patch',
    JSON.stringify({
      kind: 'content',
      id: 'resource-1',
      expectedRevision: 3,
      changes: [{ path: '/card/description', op: 'set', value: { enabled: false, count: 2 } }],
    })
  );
  expect(JSON.parse(patch.stdout).payload).toMatchObject({
    name: 'resource.patch',
    arguments: {
      kind: 'content',
      id: 'resource-1',
      expectedRevision: 3,
      changes: [{ path: '/card/description', op: 'set', value: { enabled: false, count: 2 } }],
    },
  });
});

test('CLI still displays help in command positions', async () => {
  for (const args of [
    ['--help'],
    ['help'],
    ['tools', '--help'],
    ['call', 'chat.rename', '--help'],
  ]) {
    const { stdout } = await runCli(...args);
    expect(stdout).toContain('Usage:');
  }
});

test('CLI forwards a selected export to the active bridge', async () => {
  const { stdout } = await runCli('export', '{"scope":"library","id":"resource-1"}');
  expect(JSON.parse(stdout)).toEqual({
    path: '/export',
    payload: {
      taskId: 'cli-test-task',
      toolId: 'cli-test-tool',
      arguments: { scope: 'library', id: 'resource-1' },
    },
  });
});
