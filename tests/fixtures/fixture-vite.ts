import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

export type FixtureVite = { origin: string; close: () => Promise<void> };

async function transformGraph(server: ViteDevServer, url: string, seen: Set<string>) {
  if (seen.has(url)) return;
  seen.add(url);
  await server.transformRequest(url);
  const module = await server.moduleGraph.getModuleByUrl(url);
  await Promise.all(
    [...(module?.importedModules ?? [])].map((imported) =>
      transformGraph(server, imported.url, seen)
    )
  );
}

export async function startFixtureVite(
  include: string[],
  entries: string[] = []
): Promise<FixtureVite> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'uimori-fixture-vite-'));
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: 'custom',
    cacheDir,
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include },
    server: { host: '127.0.0.1', port: 0, watch: null },
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
  const seen = new Set<string>();
  for (const entry of entries) await transformGraph(server, entry, seen);
  return {
    origin: server.resolvedUrls!.local[0]!,
    close: async () => {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}
