import { createServer } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import threads, { type WorkerOptions } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';

const [tree, mode] = process.argv.slice(2) as [string, string];
const token = process.env.REPLAY_TOKEN;
if (mode === 'import' && existsSync('replay.sqlite'))
  throw new Error('Chat import requires a fresh database');
if (!token || !process.permission || process.permission.has('child'))
  throw new Error('Replay requires restricted child and worker permissions');
const server = createServer((request, response) => {
  if (request.headers.authorization !== token || !app) {
    response.writeHead(403).end();
    return;
  }
  delete request.headers.authorization;
  app.routing(request, response);
});
let app: FastifyInstance | undefined;
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.permission.drop('net');
if (process.permission.has('net')) throw new Error('Network permission still enabled');
const guard = new URL('./guard.mjs', import.meta.url);
await import(guard.href);
const WorkerBase = threads.Worker;
threads.Worker = class ReplayWorker extends WorkerBase {
  constructor(filename: ConstructorParameters<typeof WorkerBase>[0], options: WorkerOptions = {}) {
    super(filename, {
      ...options,
      execArgv: [
        '--permission',
        '--allow-addons',
        ...process.execArgv.filter((arg) => arg.startsWith('--allow-fs-')),
        '--import=' + guard.href,
      ],
    });
  }
};
syncBuiltinESMExports();
const routes = new Set<string>();
channel('fastify.initialization').subscribe((message) => {
  const { fastify } = message as { fastify: FastifyInstance };
  fastify.addHook('onRoute', (route) => {
    if ([route.method].flat().includes('GET') && route.url.startsWith('/api/'))
      routes.add(route.url);
  });
});
const compiled = (path: string) => pathToFileURL(join(tree, 'dist', path)).href;
const { createApp }: typeof import('#dist/server/app.js') = await import(compiled('server/app.js'));
app = await createApp({
  dbPath: 'replay.sqlite',
  maintenance: mode !== 'import',
  buildId: 'replay',
  instanceId: 'replay',
});
const listening = new Promise<void>((resolve) => app!.addHook('onListen', async () => resolve()));
await app.ready();
const requireFromBuild = createRequire(join(tree, 'package.json'));
requireFromBuild('fastify/lib/hooks.js').onListenHookRunner(app);
await listening;
const registry = 'packages/contracts/src/endpoint-registry.js';
if (existsSync(join(tree, 'dist', registry))) {
  const { allEndpoints }: typeof import('#dist/packages/contracts/src/endpoint-registry.js') =
    await import(compiled(registry));
  for (const domain of Object.values(allEndpoints))
    for (const endpoint of Object.values(domain)) {
      if (endpoint.method === 'GET' && !routes.has('/api' + endpoint.path))
        throw new Error('Missing registered GET ' + endpoint.path);
    }
}
const address = server.address();
if (!address || typeof address === 'string' || !routes.size)
  throw new Error('Replay startup incomplete');
process.stdout.write(JSON.stringify({ port: address.port, routes: [...routes].sort() }) + '\n');
process.stdin.resume();
process.stdin.on('end', () => {
  server.closeAllConnections();
  server.close();
  void app?.close();
});
