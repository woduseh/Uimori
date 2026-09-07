import { parseVertexRequestTier } from '../core/product.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { parseLiveBudgetLimits } from './provider-budget.js';

const build = JSON.parse(readFileSync(resolve('dist/build-identity.json'), 'utf8')) as { buildId: string };
const dbPath = resolve(process.env.NR_DB ?? '.local/narrative.sqlite');
const instanceId = process.env.NR_INSTANCE ?? randomUUID();
const buildId = process.env.NR_BUILD_ID ?? build.buildId;
const port = Number(process.env.NR_PORT ?? 4310);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid NR_PORT');
const approvedOrigins = (process.env.NR_PROVIDER_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const liveBudget = parseLiveBudgetLimits(process.env);
const app = await createApp({ dbPath, buildId, instanceId, testMode: process.env.NR_TEST_MODE === '1', webRoot: resolve('dist/web'),approvedOrigins,accessToken:process.env.NR_ACCESS_TOKEN,liveBudget,vertexRequestTier:parseVertexRequestTier(process.env.NR_VERTEX_REQUEST_TIER) });
let closing = false;
const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
try {
  const url = await app.listen({ host: '127.0.0.1', port });
  process.stdout.write(`${JSON.stringify({ event: 'ready', url, buildId, instanceId, dbPath })}\n`);
} catch {
  await app.close(); process.stderr.write('Server startup failed\n'); process.exitCode = 1;
}
