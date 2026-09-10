import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { Store } from '../dist/server/store.js';
import {
  artifactRoot,
  newId,
  json,
  assertBuild,
  createOwnership,
  localVerificationEnv,
  startServer,
  killOwned,
  browserPath,
} from './lib.mjs';

// Measures a source-matched dist build. No provider calls; all prose and PNGs are synthetic.
// Run npm run build separately, then node scripts/measure-loading.mjs --label baseline|improved.
const labelIndex = process.argv.indexOf('--label');
const label = labelIndex < 0 ? 'measurement' : process.argv[labelIndex + 1];
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid measurement label');
const runId = `loading-${label}-${newId()}`;
const directory = path.join(artifactRoot, runId);
const runtime = path.join(directory, 'runtime');
await mkdir(runtime, { recursive: true });
const dbPath = path.join(runtime, 'synthetic.sqlite');
const children = new Set();
const summary = {
  runId,
  status: 'FAIL',
  label,
  startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform },
  measurements: {},
  cleanup: { status: 'NOT_RUN', errors: [], livePids: [], measurementDbRetained: true },
  limitations: [
    'Local Windows desktop Chromium and SQLite only; not a mobile device or remote service measurement.',
    'No tokenizer used. Source sizes are UTF-16 code units and UTF-8 bytes; 8000-80000 characters are only a rough proxy for 2000-20000 tokens, not a token count.',
    'Selected chat snapshots include complete ancestry. Other nine chats have 100 sources each but empty snapshot history to bound fixture disk cost.',
    'Run snapshots omit profile/resource copies; prompt/tool/attempt/job history is not populated. This measures the source/history bottleneck, not every possible archive payload.',
    '1000 assets contain a tiny synthetic PNG each: metadata loading only, not full image decode/network stress.',
    'CDP encodedDataLength includes response headers; decodedBodyBytes is Resource Timing body size. SSE connections remain open and are excluded from completed transfer bytes.',
    'Timing is one run per phase, not a statistical latency guarantee. Heap readings are observed snapshots, not peak memory.',
  ],
};
const ownership = createOwnership(directory, summary.startedAt);
await json(path.join(directory, 'ownership.json'), ownership);
let browser, store;
try {
  summary.build = await assertBuild();
  store = new Store(dbPath);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const prose = (length) => {
    const paragraph =
      'Synthetic field journal: the traveler records a quiet river, a stone bridge, and a lantern. No private material is used. '.repeat(
        8
      ) + '\n\n';
    return paragraph.repeat(Math.ceil(length / paragraph.length)).slice(0, length);
  };
  const bots = Array.from({ length: 100 }, (_, index) =>
    store.product.content({
      kind: 'bot',
      title: `Synthetic bot ${index + 1}`,
      description: 'Public synthetic benchmark fixture',
      text: prose(8000),
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: `loading-bot-${index + 1}`,
        revision: 1,
        title: `Synthetic bot ${index + 1}`,
        description: 'Public synthetic benchmark fixture',
        body: prose(8000),
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
      },
    })
  );
  const lore = Array.from({ length: 4 }, (_, index) =>
    store.product.content({
      kind: 'module',
      title: `Synthetic lore ${index + 1}`,
      description: 'One part of 400000-character synthetic lore',
      text: prose(100000),
      loading: 'discoverable',
      relatedIds: [],
    })
  );
  const chats = Array.from({ length: 10 }, (_, index) =>
    store.createChat(`Synthetic conversation ${index + 1}`, 'calm', { botId: bots[index].id })
  );
  let sourceBytes = 0,
    sourceChars = 0,
    snapshotBytes = 0;
  const sizes = Array.from({ length: 100 }, (_, index) => 8000 + (index % 10) * 8000);
  const time = '2026-09-07T00:00:00.000Z';
  for (const chat of chats) {
    const {
      chatId: _chatId,
      revision,
      routes: _globalRoutes,
      ...profile
    } = store.product.profile(chat.id);
    // updateProfile owns its transaction; retain the chat's required owning bot.
    store.product.updateProfile(chat.id, {
      ...profile,
      attachments: [...profile.attachments, ...lore.map(({ id, revision }) => ({ id, revision }))],
      expectedRevision: revision,
    });
  }
  store.transaction(() => {
    for (const [chatIndex, chat] of chats.entries()) {
      let previous = null;
      const history = [];
      for (let index = 0; index < 100; index++) {
        const text = prose(sizes[index]);
        const id = `source-${chatIndex}-${String(index).padStart(3, '0')}`;
        const run = `run-${chatIndex}-${index}`;
        const snapshot = JSON.stringify({
          chatId: chat.id,
          parentRevision: previous,
          settingsRevision: 1,
          settings: chat.settings,
          request: `Synthetic scene ${index + 1}`,
          history: chatIndex === 0 ? history : [],
          resources: [],
          branchId: `main:${chat.id}`,
        });
        snapshotBytes += Buffer.byteLength(snapshot);
        sourceBytes += Buffer.byteLength(text);
        sourceChars += text.length;
        store.db
          .prepare(
            "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at,branch_id) VALUES(?,?,?,'completed',?,?,?,?,?,?,?,?)"
          )
          .run(
            run,
            chat.id,
            previous,
            `Synthetic scene ${index + 1}`,
            snapshot,
            run,
            '{}',
            id,
            time,
            time,
            `main:${chat.id}`
          );
        const contentHash = hash(text);
        store.db
          .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)')
          .run(id, chat.id, run, previous, text, contentHash, time);
        history.push({ revision: id, text, contentHash });
        previous = id;
      }
      store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(previous, chat.id);
      store.db
        .prepare('UPDATE branches SET head_revision=?,revision=101 WHERE chat_id=?')
        .run(previous, chat.id);
    }
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=',
      'base64'
    );
    for (let index = 0; index < 1000; index++) {
      const id = `synthetic-asset-${index}`;
      const chatId = chats[0].id;
      const body = {
        id,
        chatId,
        revision: 1,
        title: `Synthetic image ${index}`,
        description: prose(1000),
        mime: 'image/png',
        hash: hash(png),
        actor: '',
        outfit: '',
        location: '',
        allowedUse: 'both',
        url: `/api/assets/${id}`,
      };
      store.db
        .prepare('INSERT INTO assets VALUES(?,?,?,?)')
        .run(id, chatId, JSON.stringify(body), png);
    }
  });
  if (store.db.prepare('PRAGMA foreign_key_check').all().length)
    throw new Error('Synthetic fixture foreign key check failed');
  store.close();
  store = undefined;
  summary.fixture = {
    chats: 10,
    bots: 100,
    sourcesPerChat: 100,
    sourceCharacters: sourceChars,
    sourceUtf8Bytes: sourceBytes,
    perSourceCharacters: { min: 8000, max: 80000 },
    selectedChatCharacters: sizes.reduce((a, b) => a + b, 0),
    loreCharacters: 400000,
    loreEntries: 4,
    assets: 1000,
    snapshotUtf8Bytes: snapshotBytes,
    dbBytes: (await stat(dbPath)).size,
    chatId: chats[0].id,
  };
  await json(path.join(directory, 'summary.json'), summary);
  const env = localVerificationEnv({
    NR_DB: dbPath,
    NR_INSTANCE: runId,
    NR_BUILD_ID: summary.build.buildId,
    TEMP: runtime,
    TMP: runtime,
  });
  const server = await startServer(env, directory, children);
  summary.server = server.ready;
  ownership.children.push({ pid: server.child.pid, dbPath, url: server.ready.url });
  await json(path.join(directory, 'ownership.json'), ownership);
  browser = await chromium.launch({
    executablePath: browserPath(),
    headless: true,
    args: ['--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  const records = new Map();
  let phase = 'initial';
  cdp.on('Network.requestWillBeSent', (event) =>
    records.set(event.requestId, {
      phase,
      url: event.request.url,
      method: event.request.method,
      type: event.type,
    })
  );
  cdp.on('Network.responseReceived', (event) => {
    const row = records.get(event.requestId);
    if (row) row.status = event.response.status;
  });
  cdp.on('Network.loadingFinished', (event) => {
    const row = records.get(event.requestId);
    if (row) Object.assign(row, { complete: true, encodedBytes: event.encodedDataLength });
  });
  cdp.on('Network.loadingFailed', (event) => {
    const row = records.get(event.requestId);
    if (row) row.error = event.errorText;
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function measure(name, action) {
    phase = name;
    await page.evaluate(() => performance.clearResourceTimings()).catch(() => {});
    const started = performance.now();
    await action();
    await page.locator('[data-source-id]').first().waitFor();
    await page.waitForTimeout(1500);
    const timing = await page.evaluate(() => ({
      domNodes: document.querySelectorAll('*').length,
      sourceArticles: document.querySelectorAll('[data-source-id]').length,
      blocks: document.querySelectorAll('[data-block-anchor]').length,
      resources: performance.getEntriesByType('resource').map((item) => ({
        name: item.name,
        decodedBodyBytes: item.decodedBodySize,
        durationMs: item.duration,
      })),
      scrollTop: document.querySelector('[data-reader-scrollport]')?.scrollTop,
    }));
    const perf = await cdp.send('Performance.getMetrics');
    const phaseRequests = [...records.values()].filter((row) => row.phase === name);
    summary.measurements[name] = {
      elapsedIncluding1500msSettle: performance.now() - started,
      ...timing,
      httpRequests: phaseRequests.length,
      apiRequests: phaseRequests.filter((row) => row.url.includes('/api/')).length,
      encodedBytes: phaseRequests.reduce((sum, row) => sum + (row.encodedBytes || 0), 0),
      heapUsedBytes: perf.metrics.find((row) => row.name === 'JSHeapUsedSize')?.value,
      requests: phaseRequests,
    };
    await json(path.join(directory, 'summary.json'), summary);
  }
  await measure('initial', () =>
    page.goto(`${server.ready.url}/?chat=${chats[0].id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    })
  );
  await page.screenshot({ path: path.join(directory, 'initial.png') });
  await measure('sse-settings', async () => {
    const result = await fetch(`${server.ready.url}/api/chats/${chats[0].id}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedSettingsRevision: 1, ...chats[0].settings, preset: 'vivid' }),
    });
    if (!result.ok) throw new Error(`Settings update ${result.status}`);
    await page.waitForTimeout(1500);
  });
  await measure('reload', () => page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 }));
  phase = 'scroll';
  const scrollStarted = performance.now();
  await page.evaluate(async () => {
    const node = document.querySelector('[data-reader-scrollport]');
    for (let index = 0; index <= 30; index++) {
      node.scrollTop = ((node.scrollHeight - node.clientHeight) * index) / 30;
      await new Promise(requestAnimationFrame);
    }
  });
  summary.measurements.scroll = {
    elapsedMs: performance.now() - scrollStarted,
    steps: 31,
    finalPosition: await page.locator('[data-reader-scrollport]').evaluate((node) => ({
      top: node.scrollTop,
      height: node.scrollHeight,
      viewport: node.clientHeight,
    })),
  };
  await page.screenshot({ path: path.join(directory, 'bottom.png') });
  summary.browserErrors = errors;
  if (errors.length) throw new Error('Browser emitted page errors');
  if ((await assertBuild()).buildId !== summary.build.buildId)
    throw new Error('Build changed while measuring loading');
  summary.status = 'PASS';
} catch (error) {
  summary.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const close of [() => store?.close(), () => browser?.close()]) {
    try {
      await close();
    } catch (error) {
      summary.cleanup.errors.push(error.message);
    }
  }
  for (const child of children) {
    try {
      const result = await killOwned(child);
      if (!result.exited) summary.cleanup.livePids.push(child.pid);
    } catch (error) {
      summary.cleanup.errors.push(error.message);
      summary.cleanup.livePids.push(child.pid);
    }
  }
  summary.cleanup.status =
    summary.cleanup.errors.length || summary.cleanup.livePids.length ? 'FAIL' : 'PASS';
  if (summary.cleanup.status !== 'PASS') {
    summary.status = 'FAIL';
    process.exitCode = 1;
  }
  ownership.active = false;
  ownership.finishedAt = new Date().toISOString();
  await json(path.join(directory, 'ownership.json'), ownership);
  summary.finishedAt = new Date().toISOString();
  await json(path.join(directory, 'summary.json'), summary);
  console.log(JSON.stringify({ directory, status: summary.status, error: summary.error }));
}
