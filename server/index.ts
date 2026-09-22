import { parseVertexRequestTier } from '../core/product.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { listenAddress, networkPolicy } from './network-policy.js';

const build = JSON.parse(readFileSync(resolve('dist/build-identity.json'), 'utf8')) as {
  buildId: string;
};
const dbPath = resolve(process.env.UIMORI_DB ?? '.local/uimori.sqlite');
const instanceId = process.env.UIMORI_INSTANCE ?? randomUUID();
const buildId = process.env.UIMORI_BUILD_ID ?? build.buildId;
const access = {
  publicOrigin: process.env.UIMORI_PUBLIC_ORIGIN,
  accessToken: process.env.UIMORI_ACCESS_TOKEN,
  testMode: process.env.UIMORI_TEST_MODE === '1',
};
const network = networkPolicy(access);
const address = listenAddress(process.env, network);

if (
  process.env.UIMORI_CODEX_ENABLED !== undefined &&
  !['0', '1'].includes(process.env.UIMORI_CODEX_ENABLED)
)
  throw new Error('UIMORI_CODEX_ENABLED must be 0 or 1');
if (
  process.env.UIMORI_MAINTENANCE !== undefined &&
  !['0', '1'].includes(process.env.UIMORI_MAINTENANCE)
)
  throw new Error('UIMORI_MAINTENANCE must be 0 or 1');
const codex = {
  enabled: process.env.UIMORI_CODEX_ENABLED === '1',
  executable: process.env.UIMORI_CODEX_EXECUTABLE,
};
const app = await createApp({
  dbPath,
  buildId,
  instanceId,
  ...access,
  webRoot: resolve('dist/web'),

  vertexRequestTier: parseVertexRequestTier(process.env.UIMORI_VERTEX_REQUEST_TIER),
  codex,
  maintenance: process.env.UIMORI_MAINTENANCE === '1',
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
try {
  const url = await app.listen(address);
  process.stdout.write(
    `${JSON.stringify({ event: 'ready', url, buildId, instanceId, dbPath, ...(network.publicOrigin ? { publicOrigin: network.publicOrigin } : {}) })}\n`
  );
} catch {
  await app.close();
  process.stderr.write('Server startup failed\n');
  process.exitCode = 1;
}
