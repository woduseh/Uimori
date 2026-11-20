import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

export type FixtureVite = { origin: string; close: () => Promise<void> };

export async function startFixtureVite(include: string[]): Promise<FixtureVite> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'uimori-fixture-vite-'));
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    cacheDir,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include },
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/output/**'] } },
  });
  server.middlewares.use(async (request, response, next) => {
    if (request.url !== '/') return next();
    response.setHeader('Content-Type', 'text/html');
    response.end(
      await server.transformIndexHtml(
        '/',
        '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="mount"></main></body></html>'
      )
    );
  });
  await server.listen();
  return {
    origin: server.resolvedUrls!.local[0]!,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}
