import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  assertBuild,
  browserPath,
  json,
  killOwned,
  localVerificationEnv,
  newId,
  root,
  startServer,
} from './lib.mjs';
import { projectNativeRisuPackage } from '../dist/server/risu-native-projection.js';

const targetChars = Number(process.env.UIMORI_PROFILE_CHARS ?? 40_000);
const durationMs = Number(process.env.UIMORI_PROFILE_MS ?? 70_000);
const tickMs = 50;
const directory = path.resolve(
  process.argv[2] ?? path.join(root, 'output/benchmarks', `streaming-profile-${newId()}`)
);

function syntheticScene(length) {
  const sentences = [
    '비가 그친 골목에는 젖은 돌바닥 냄새가 남아 있었다.',
    '미라는 우산을 접고 낡은 서점의 문을 밀었다.',
    '"오늘도 늦었네." 주인은 안경 너머로 그녀를 보며 웃었다.',
    '"*정말* 잠깐만 있을게요." 미라가 대답했다.',
    '책장 사이로 스며든 불빛이 **먼지**를 금빛으로 물들였다.',
    '그녀는 오래된 지도책을 펼쳐 손끝으로 해안선을 따라갔다.',
    '창밖에서 버스가 지나가며 유리창이 가볍게 떨렸다.',
    '"그 섬에 가 본 적 있어요?" 주인이 물었다.',
  ];
  let text = '';
  for (let index = 0; text.length < length; index++) {
    text += sentences[index % sentences.length];
    text += index % 5 === 4 ? '\n\n' : ' ';
  }
  return text.slice(0, length);
}

async function api(base, method, url, data) {
  const response = await fetch(base + url, {
    method,
    headers: data ? { 'content-type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${text}`);
  return JSON.parse(text);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] * 10) / 10
  );
}

const identity = await assertBuild();
await mkdir(directory, { recursive: true });
const scene = syntheticScene(targetChars);
let release = () => {};
const started = new Promise((resolve) => {
  release = resolve;
});
let streamedAt = 0;
let streamFinishedAt = 0;
const provider = createServer(async (request, response) => {
  for await (const _chunk of request);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  await started;
  streamedAt = Date.now();
  const ticks = Math.ceil(durationMs / tickMs);
  const size = Math.ceil(scene.length / ticks);
  for (let offset = 0; offset < scene.length; offset += size) {
    const delta = scene.slice(offset, offset + size);
    response.write(`data: ${JSON.stringify({ type: 'text_delta', delta })}\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  streamFinishedAt = Date.now();
  response.write(
    `data: ${JSON.stringify({ type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: null })}\r\n\r\n`
  );
  response.end(`data: ${JSON.stringify({ type: 'done', reason: 'stop' })}\r\n\r\n`);
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const endpoint = `http://127.0.0.1:${provider.address().port}/turn`;

const children = new Set();
let browser;
try {
  const { ready } = await startServer(
    localVerificationEnv({
      UIMORI_DB: path.join(directory, 'app.sqlite'),
      UIMORI_BUILD_ID: identity.buildId,
      UIMORI_INSTANCE: `streaming-profile-${randomUUID()}`,
    }),
    directory,
    children
  );
  const base = ready.url;
  const connection = await api(base, 'POST', '/api/connections', {
    title: 'Streaming profile',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
  });
  const model = await api(base, 'POST', '/api/model-presets', {
    title: 'Streaming profile',
    connectionId: connection.id,
    modelId: 'streaming-profile',
    tokenizer: 'gemini-gemma4',
    inputTokenLimit: 262144,
    maxOutputTokens: 131072,
    timeoutMs: 600000,
    temperature: null,
  });
  const models = await api(base, 'GET', '/api/model-workspace');
  await api(base, 'PUT', '/api/model-workspace', {
    expectedRevision: models.revision,
    routes: { ...models.routes, main: { id: model.id } },
    titleModel: null,
    translationPolicy: models.translationPolicy,
  });
  const card = { name: 'Profile bot', creator_notes: 'Synthetic', description: '' };
  const bot = await api(base, 'POST', '/api/content', {
    kind: 'bot',
    title: 'Profile bot',
    description: 'Synthetic',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: projectNativeRisuPackage(
      {
        version: 2,
        id: 'streaming-profile',
        revision: 1,
        title: 'Profile bot',
        description: '',
        lore: [],
        nativeRisu: {
          version: 1,
          card,
          assets: [],
          sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
        },
      },
      'bot'
    ).pkg,
  });
  const chat = await api(base, 'POST', '/api/chats', { title: 'Streaming profile', botId: bot.id });

  browser = await chromium.launch({ executablePath: browserPath(), args: ['--no-proxy-server'] });
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const profile = { longTasks: [], frames: [], recording: false };
    window.__streamProfile = profile;
    new PerformanceObserver((list) => {
      if (!profile.recording) return;
      for (const entry of list.getEntries())
        profile.longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
          attribution: entry.attribution?.map((item) => item.containerType || item.name) ?? [],
        });
    }).observe({ type: 'longtask', buffered: false });
    let previous = 0;
    const frame = (time) => {
      if (profile.recording && previous) profile.frames.push(time - previous);
      previous = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  await cdp.send('Network.enable');
  let sseFrames = 0;
  let streamReads = 0;
  cdp.on('Network.eventSourceMessageReceived', () => {
    sseFrames++;
  });
  page.on('request', (item) => {
    if (item.url().includes('/api/response-streams/')) streamReads++;
  });

  const run = await api(base, 'POST', `/api/chats/${chat.id}/runs`, {
    request: '비 오는 서점 장면을 길게 써 주세요.',
    expectedRevision: chat.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    idempotencyKey: randomUUID(),
  });
  await page.goto(`/?chat=${chat.id}`);
  const pending = page.locator(`[data-testid="pending-run"][data-run-id="${run.id}"]`);
  await pending.waitFor({ timeout: 30_000 });
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send('Performance.getMetrics')).metrics.map((item) => [item.name, item.value])
    );
  await page.evaluate(() => {
    window.__streamProfile.recording = true;
  });
  const before = await metrics();
  sseFrames = 0;
  streamReads = 0;
  release();
  const text = pending.locator('.streaming-text');
  await text.waitFor({ timeout: 30_000 });
  for (;;) {
    const { status, error } = await api(base, 'GET', `/api/runs/${run.id}`);
    if (!['queued', 'running'].includes(status)) {
      assert.equal(status, 'completed', error);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const after = await metrics();
  const recorded = await page.evaluate(() => {
    window.__streamProfile.recording = false;
    return {
      ...window.__streamProfile,
      domNodes: document.getElementsByTagName('*').length,
    };
  });
  const finalSource = (await api(base, 'GET', `/api/chats/${chat.id}`)).sources.at(-1);
  const delta = (name) => Math.round((after[name] - before[name]) * 1000) / 1000;
  const longTaskDurations = recorded.longTasks.map((task) => task.duration);
  const report = {
    kind: 'uimori-streaming-profile-v1',
    measuredAt: new Date().toISOString(),
    build: identity.buildId,
    environment: { node: process.version, platform: process.platform, viewport: '1440x900' },
    stream: {
      chars: scene.length,
      plannedMs: durationMs,
      tickMs,
      streamedMs: streamFinishedAt - streamedAt,
      savedChars: finalSource?.text.length ?? null,
    },
    longTasks: {
      count: longTaskDurations.length,
      totalMs: Math.round(longTaskDurations.reduce((sum, value) => sum + value, 0)),
      maxMs: longTaskDurations.length ? Math.round(Math.max(...longTaskDurations)) : 0,
      entries: recorded.longTasks.slice(0, 50),
    },
    frames: {
      count: recorded.frames.length,
      p50Ms: percentile(recorded.frames, 0.5),
      p90Ms: percentile(recorded.frames, 0.9),
      p99Ms: percentile(recorded.frames, 0.99),
      maxMs: percentile(recorded.frames, 1),
      over50Ms: recorded.frames.filter((value) => value > 50).length,
    },
    cdp: {
      layoutCount: delta('LayoutCount'),
      layoutSeconds: delta('LayoutDuration'),
      recalcStyleCount: delta('RecalcStyleCount'),
      recalcStyleSeconds: delta('RecalcStyleDuration'),
      scriptSeconds: delta('ScriptDuration'),
      taskSeconds: delta('TaskDuration'),
      jsHeapUsedBytes: after.JSHeapUsedSize,
      nodes: after.Nodes,
    },
    domNodesAtEnd: recorded.domNodes,
    responseStreamRequests: streamReads,
    chatEventSourceFrames: sseFrames,
  };
  await json(path.join(directory, 'profile.json'), report);
  process.stdout.write(
    `${JSON.stringify({ ...report, longTasks: { ...report.longTasks, entries: undefined } }, null, 2)}\n`
  );
} finally {
  await browser?.close();
  for (const child of children) await killOwned(child).catch(() => {});
  provider.closeAllConnections();
  provider.close();
}
