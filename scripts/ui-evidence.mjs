import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
const root = process.cwd(),
  mode = process.argv[2] || 'serve',
  stamp = new Date().toISOString().replaceAll(':', '-');
const output = path.resolve(
  process.env.NR_UI_EVIDENCE_DIR ||
    (mode !== 'serve' && process.argv[3]
      ? path.dirname(process.argv[3])
      : path.join('output', 'ui-redesign', stamp))
);
await mkdir(output, { recursive: true });
const english = (i) =>
  `The harbor kept its quiet promise on evening ${i}. Mira rested her hand on the rail and watched amber light travel across the water. She had carried the unopened letter all the way from the old observatory, but its answer belonged to another hour. Beyond the last pier, the bell rang once and the island slowly disappeared into the mist.`;
const korean = (_i) =>
  `항구는 이날 저녁에도 고요한 약속을 지켰다. 미라는 난간에 손을 얹고 물 위를 건너가는 호박빛을 바라보았다. 오래된 천문대에서 여기까지 가져온 편지는 아직 봉해져 있었다. 마지막 부두 너머에서 종이 한 번 울렸고, 섬은 서서히 안개 속으로 모습을 감췄다. 서두를 이유는 없었다. 지금의 침묵도 그들이 함께 쓸 이야기의 일부였으니까.`;
const sourceText = [
  '# The harbor at dusk',
  '> “Some promises arrive quietly,” Mira said.',
  'She kept **the unopened letter** beside the brass compass.',
  ...Array.from({ length: 32 }, (_, i) => english(i + 1)),
].join('\n\n');
const requests = [];
let provider, child, base, manifest;
async function fetchJson(url, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const value = await response.text();
  if (!response.ok) throw Error(`${response.status} ${url}: ${value}`);
  return JSON.parse(value);
}
if (mode === 'serve' || mode === 'resume') {
  const previous = mode === 'resume' ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null;
  provider = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ role: body.role, modelId: body.modelId, at: new Date().toISOString() });
      const packet = body.input.source;
      const requestedFault =
        body.role === 'main' && body.input.task?.match(/^UI_EVIDENCE_(REFUSED|PARTIAL)/)?.[1];
      if (requestedFault) {
        const events =
          requestedFault === 'REFUSED'
            ? [
                { type: 'refusal', message: '합성 공급자가 요청을 거절했어요.' },
                {
                  type: 'usage',
                  inputTokens: null,
                  outputTokens: null,
                  costUsd: null,
                  raw: { synthetic: true },
                  priceRevision: null,
                },
                { type: 'done', reason: 'refusal' },
              ]
            : [{ type: 'text_delta', delta: 'This is a preserved incomplete synthetic output.' }];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
        return;
      }
      const text =
        body.role === 'translation'
          ? JSON.stringify({
              sourceRevision: packet.sourceRevision,
              sourceHash: packet.sourceHash,
              chunkId: packet.chunkId,
              segments: packet.blocks.map((block, i) => ({
                anchors: [block.anchor],
                text: (block.text.match(/\[\[p_[^\]]+\]\]/g) || []).join(' ') + ' ' + korean(i + 1),
              })),
            })
          : sourceText;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          { type: 'text_delta', delta: text },
          {
            type: 'usage',
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            raw: { synthetic: true },
            priceRevision: null,
          },
          { type: 'done', reason: 'stop' },
        ]
          .map((event) => 'data: ' + JSON.stringify(event) + '\r\n\r\n')
          .join('')
      );
    } catch (error) {
      res.destroy(error);
    }
  });
  provider.listen(previous ? Number(new URL(previous.providerOrigin).port) : 0, '127.0.0.1');
  await once(provider, 'listening');
  const providerOrigin = 'http://127.0.0.1:' + provider.address().port,
    dbPath = path.join(output, 'evidence.sqlite');
  const build = JSON.parse(await readFile('dist/build-identity.json', 'utf8'));
  child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      NR_DB: dbPath,
      NR_PORT: previous ? new URL(previous.url).port : '0',
      NR_TEST_MODE: '1',
      NR_ACCESS_TOKEN: '',
      NR_PROVIDER_ORIGINS: providerOrigin,
      NR_INSTANCE: 'ui-evidence-' + stamp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  process.once('exit', () => child?.kill());
  base = await new Promise((resolve, reject) => {
    let value = '';
    child.stdout.on('data', (chunk) => {
      value += chunk;
      for (const line of value.split('\n')) {
        try {
          const ready = JSON.parse(line);
          if (ready.event === 'ready') resolve(ready.url);
        } catch {}
      }
    });
    child.once('exit', (code) => reject(Error('app exited ' + code)));
  });
  const api = (route, data, method) => fetchJson(base + '/api' + route, data, method);
  if (!previous) {
    const bot = await api('/content', {
      kind: 'bot',
      title: '미라 · 황혼의 항구',
      description: '편지와 등대, 느린 저녁을 함께 쓰는 합성 인물',
      text: 'Mira is a fictional lighthouse keeper in this synthetic test story.',
      loading: 'pinned',
      relatedIds: [],
    });
    const persona = await api('/content', {
      kind: 'persona',
      title: '섬을 찾은 여행자',
      description: '응답을 강요하지 않는 합성 여행자',
      text: 'A synthetic traveler who can choose their own next action.',
      loading: 'pinned',
      relatedIds: [],
    });
    const connection = await api('/connections', {
      title: '격리된 HTTP 합성 공급자',
      protocol: 'fixture-sse-v1',
      endpoint: providerOrigin + '/turn',
      enabled: true,
    });
    const main = await api('/model-presets', {
      title: '긴 영어 원고 · 합성',
      connectionId: connection.id,
      modelId: 'fixture-long-source',
      maxOutputTokens: 16000,
      temperature: null,
    });
    const translation = await api('/model-presets', {
      title: '한국어 번역 · 합성',
      connectionId: connection.id,
      modelId: 'fixture-korean-translation',
      maxOutputTokens: 16000,
      temperature: null,
    });
    const chat = await api('/chats', { title: '황혼의 항구에서 · 합성 긴 원고' });
    let detail = await api('/chats/' + chat.id);
    await api(
      '/chats/' + chat.id + '/profile',
      {
        expectedRevision: detail.profile.revision,
        attachments: [
          { id: bot.id, revision: 1 },
          { id: persona.id, revision: 1 },
        ],
        personaReference: detail.profile.personaReference,
        routes: {
          ...detail.profile.routes,
          main: { id: main.id },
          translation: { id: translation.id },
        },
        image: false,
      },
      'PUT'
    );
    for (let i = 0; i < 3; i++) {
      detail = await api('/chats/' + chat.id);
      const run = await api('/chats/' + chat.id + '/runs', {
        request: [
          '비가 그친 항구에서 미라가 편지를 기다리는 장면을 써줘.',
          '서두르지 말고, 종소리와 여행자의 침묵을 따라 이어줘.',
          '편지는 아직 열지 않은 채, 마지막 배가 도착하는 순간을 이어줘.',
        ][i],
        expectedRevision: detail.chat.headRevision,
        expectedSettingsRevision: detail.chat.settingsRevision,
        expectedProfileRevision: detail.profile.revision,
        idempotencyKey: 'ui-evidence-' + i,
      });
      let translationRequested = false;
      for (let tries = 0; tries < 200; tries++) {
        detail = await api('/chats/' + chat.id);
        const completed = detail.runs.find((item) => item.id === run.id);
        if (completed?.status === 'completed' && !translationRequested) {
          await api('/sources/' + completed.sourceRevision + '/translation', {});
          translationRequested = true;
          continue;
        }
        if (
          translationRequested &&
          detail.jobs.some(
            (job) => job.sourceRevision === completed?.sourceRevision && job.kind === 'translation'
          ) &&
          detail.jobs
            .filter((job) => job.sourceRevision === completed?.sourceRevision)
            .every((job) => !['queued', 'running'].includes(job.status))
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        !translationRequested ||
        !detail.jobs.some(
          (job) =>
            job.sourceRevision === detail.runs.find((item) => item.id === run.id)?.sourceRevision &&
            job.kind === 'translation'
        ) ||
        detail.jobs.some((job) => job.status !== 'completed')
      )
        throw Error(
          'jobs not completed ' +
            JSON.stringify(detail.jobs.map(({ kind, status, error }) => ({ kind, status, error })))
        );
    }

    manifest = {
      schema: 1,
      synthetic: true,
      root,
      output,
      url: base,
      dbPath,
      providerOrigin,
      providerPid: process.pid,
      appPid: child.pid,
      chatId: chat.id,
      botId: bot.id,
      personaId: persona.id,
      sourceCharacters: sourceText.length,
      sourceCount: detail.sources.length,
      build,
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } else {
    manifest = {
      ...previous,
      providerPid: process.pid,
      appPid: child.pid,
      afterBuild: build,
      resumedAt: new Date().toISOString(),
    };
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  process.stdout.write('UI_EVIDENCE_READY ' + JSON.stringify(manifest) + '\n');
  if (process.env.NR_UI_CAPTURE !== '0') {
    try {
      await capture(previous ? 'after' : 'before', manifest);
      process.stdout.write('UI_EVIDENCE_CAPTURED ' + output + '\n');
    } catch (error) {
      await writeFile(path.join(output, 'capture-error.txt'), String(error));
      process.stderr.write('UI_EVIDENCE_CAPTURE_FAILED ' + String(error) + '\n');
    }
  }
  const close = () => {
    child.kill();
    provider.closeAllConnections();
    provider.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} else {
  manifest = JSON.parse(await readFile(path.resolve(process.argv[3]), 'utf8'));
  base = manifest.url;
  if (mode === 'measure') await measure(manifest);
  else if (mode === 'errors') await errorEvidence(manifest);
  else await capture(mode, manifest);
}
async function capture(label, info) {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NR_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  const reading = async (page) => {
    const button = page.getByRole('button', { name: '읽기 설정', exact: true });
    if (await button.isVisible()) await button.click();
    else {
      await page.getByRole('button', { name: '이야기 설정', exact: true }).click();
      await page.getByRole('button', { name: '읽기 설정 열기', exact: true }).click();
    }
  };
  const navigate = async (page, name) => {
    const button = page.getByRole('button', { name, exact: true });
    if (!(await button.isVisible()))
      await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
    await button.click();
  };
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.goto(info.url + '/?chat=' + info.chatId);
      await page.getByTestId('source').first().waitFor();
      const prefix = path.join(info.output, label + '-' + viewport.width);
      await page.screenshot({ path: prefix + '-default.png' });
      if (label === 'before') {
        await page.getByTestId('source').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: prefix + '-source.png' });
        await page.getByRole('button', { name: '번역 보기', exact: true }).first().click();
        await page.screenshot({ path: prefix + '-translation.png' });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByTestId('library-panel').locator('summary').click();
        await page.screenshot({ path: prefix + '-library.png' });
        await page.getByTestId('library-panel').locator('summary').click();
        const settings = page
          .locator('details')
          .filter({ has: page.locator('summary', { hasText: '이야기 설정' }) })
          .first();
        await settings.locator('summary').click();
        await settings.scrollIntoViewIfNeeded();
        await page.screenshot({ path: prefix + '-settings.png' });
      } else {
        await page.getByRole('button', { name: '원문 보기', exact: true }).first().click();
        await page.screenshot({ path: prefix + '-source.png' });
        await page.getByRole('button', { name: '번역 보기', exact: true }).first().click();
        await page.screenshot({ path: prefix + '-translation.png' });
        await page.getByRole('button', { name: '이야기 설정', exact: true }).click();
        await page.screenshot({ path: prefix + '-settings.png' });
        await page.keyboard.press('Escape');
        await reading(page);
        await page.getByLabel('화면 테마', { exact: true }).selectOption('light');
        await page.keyboard.press('Escape');
        await page.screenshot({ path: prefix + '-light.png' });
        await reading(page);
        await page.getByLabel('화면 테마', { exact: true }).selectOption('dark');
        await page.keyboard.press('Escape');
        await page.screenshot({ path: prefix + '-dark.png' });
        await navigate(page, '서재');
        await page.getByTestId('library-panel').waitFor();
        await page.screenshot({ path: prefix + '-library.png' });
        await navigate(page, '설정');
        await page.getByTestId('connection-settings').locator('summary').click();
        await page.screenshot({ path: prefix + '-connections.png' });
        await page.keyboard.press('Escape');
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function measure(info) {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NR_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const records = [];
  const api = (route, data, method) => fetchJson(info.url + '/api' + route, data, method);
  try {
    for (const variant of ['existing-library', 'plus-100-bots-50-lore-20-assets']) {
      if (variant.startsWith('plus')) {
        for (let i = 0; i < 150; i++)
          await api('/content', {
            kind: i < 100 ? 'bot' : 'module',
            title: `UI14 합성 ${i < 100 ? '보관 봇' : '로어'} ${i}`,
            description: '화면 비용 측정 전용 합성 자료',
            text: 'Synthetic content for browser measurement. '.repeat(30),
            loading: 'discoverable',
            relatedIds: [],
          });
        const base64 =
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=';
        for (let i = 0; i < 20; i++)
          await api(`/chats/${info.chatId}/assets`, {
            title: `UI14 합성 이미지 ${i}`,
            mime: 'image/png',
            base64,
            description: 'Synthetic one-pixel measurement asset.',
            actor: 'synthetic',
            outfit: '',
            location: 'pier',
            allowedUse: 'inline',
          });
      }
      for (let trial = 0; trial < 3; trial++) {
        await page.goto(info.url + '/?chat=' + info.chatId);
        await page.getByTestId('source').first().waitFor();
        await page.evaluate(() => {
          globalThis.__measure = {
            input: [],
            mutations: 0,
            longTasks: [],
            count: document.querySelectorAll('*').length,
          };
          document.querySelector('#request').addEventListener('input', () => {
            const start = performance.now();
            requestAnimationFrame(() => globalThis.__measure.input.push(performance.now() - start));
          });
          const observer = new MutationObserver((records) => {
            globalThis.__measure.mutations += records.length;
          });
          observer.observe(document.querySelector('#root'), {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
          try {
            new PerformanceObserver((list) =>
              globalThis.__measure.longTasks.push(
                ...list.getEntries().map((item) => ({ duration: item.duration, name: item.name }))
              )
            ).observe({ type: 'longtask', buffered: false });
          } catch {}
        });
        const requests = [];
        const onRequest = (request) => {
          if (request.url().includes('/api/'))
            requests.push({ method: request.method(), url: request.url() });
        };
        page.on('request', onRequest);
        for (let index = 0; index < 20; index++)
          await page.getByLabel('다음 장면 요청').fill('UI14 합성 초안 ' + String(index));
        const scrolling = await page
          .locator('[data-reader-scrollport]')
          .evaluate(async (element) => {
            const samples = [];
            for (let index = 0; index < 30; index++) {
              const start = performance.now();
              element.scrollTop += 70;
              await new Promise(requestAnimationFrame);
              samples.push(performance.now() - start);
            }
            return samples;
          });
        page.off('request', onRequest);
        const measurements = await page.evaluate(() => globalThis.__measure);
        const detailRequest = [];
        for (let index = 0; index < 5; index++)
          detailRequest.push(
            await page.evaluate(async (id) => {
              const start = performance.now();
              const response = await fetch('/api/chats/' + id);
              const text = await response.text();
              const parsed = JSON.parse(text);
              return {
                durationMs: performance.now() - start,
                bytes: new TextEncoder().encode(text).length,
                sources: parsed.sources.length,
              };
            }, info.chatId)
          );
        const libraryButton = page.getByRole('button', { name: '서재', exact: true });
        if (!(await libraryButton.isVisible()))
          await page.getByRole('button', { name: '탐색 메뉴', exact: true }).click();
        await libraryButton.click();
        await page.getByLabel('서재 검색').waitFor();
        await page.evaluate(() => {
          globalThis.__librarySearch = [];
          document.querySelector('[aria-label="서재 검색"]').addEventListener('input', (event) => {
            const start = performance.now(),
              query = event.target.value;
            requestAnimationFrame(() =>
              globalThis.__librarySearch.push({
                query,
                inputToFrameMs: performance.now() - start,
                cards: document.querySelectorAll('.library-card').length,
              })
            );
          });
        });
        await page.getByLabel('서재 검색').fill('UI14 합성 보관 봇');
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.getByLabel('서재 검색').fill('UI14 no matching synthetic name');
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const librarySearch = await page.evaluate(() => globalThis.__librarySearch);
        const library = await api('/library');
        records.push({
          variant,
          trial,
          libraryContents: library.contents.length,
          assets: library.assets.length,
          ...measurements,
          librarySearch,
          scrollFrameMs: scrolling,
          apiDuringInputAndScroll: requests,
          detailRequest,
        });
      }
    }
    const result = {
      schema: 1,
      synthetic: true,
      measuredAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        browser: await browser.version(),
        viewport: { width: 1440, height: 1000 },
      },
      scope:
        'same active chat, three 10901 UTF-16 character source revisions; three trials per library variant; 20 input events, 30 scroll frames, five real detail GET+JSON parses each',
      units:
        'Input handler entry to next animation frame and scroll write to next animation frame in milliseconds; DOM mutation records are observed changes, not a React render count. Input text is characters, no tokenizer claim. Loopback fixture only.',
      records,
    };
    await writeFile(path.join(info.output, 'performance.json'), JSON.stringify(result, null, 2));
    process.stdout.write(
      'UI_PERFORMANCE_SAVED ' + path.join(info.output, 'performance.json') + '\n'
    );
  } finally {
    await browser.close();
  }
}

async function errorEvidence(info) {
  const api = (route, data, method) => fetchJson(info.url + '/api' + route, data, method);
  const template = await api('/chats/' + info.chatId);
  const chat = await api('/chats', { title: '합성 오류 검증 · 거절과 부분 출력' });
  const original = await api('/chats/' + chat.id);
  await api(
    '/chats/' + chat.id + '/profile',
    {
      expectedRevision: original.profile.revision,
      attachments: [],
      personaReference: original.profile.personaReference,
      routes: { ...original.profile.routes, main: template.profile.routes.main },
      image: false,
    },
    'PUT'
  );
  const observations = [];
  for (const fault of ['REFUSED', 'PARTIAL']) {
    const before = await api('/chats/' + chat.id);
    const run = await api('/chats/' + chat.id + '/runs', {
      request: 'UI_EVIDENCE_' + fault + ' · 합성 공급자 실패 상태를 확인해요.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile.revision,
      idempotencyKey: 'error-evidence-' + fault,
    });
    let detail;
    for (let tries = 0; tries < 100; tries++) {
      detail = await api('/chats/' + chat.id);
      if (!['queued', 'running'].includes(detail.runs.find((item) => item.id === run.id)?.status))
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = detail.runs.find((item) => item.id === run.id);
    if (result.status !== fault.toLowerCase() || detail.sources.length || detail.jobs.length)
      throw Error('Error evidence identity failed ' + JSON.stringify(result));
    observations.push({
      id: result.id,
      status: result.status,
      sourceCount: detail.sources.length,
      jobCount: detail.jobs.length,
      partialText: result.partialText,
      usage: result.usage,
      attempts: detail.attempts
        .filter((item) => item.runId === result.id)
        .map(({ status, costUsd }) => ({ status, costUsd })),
    });
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NR_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.goto(info.url + '/?chat=' + chat.id);
      await page.getByRole('button', { name: '작업 상세', exact: true }).first().waitFor();
      await page.screenshot({
        path: path.join(info.output, 'after-' + viewport.width + '-failure.png'),
      });
      await page.getByRole('button', { name: '작업 상세', exact: true }).last().click();
      await page.getByRole('dialog', { name: '작업 현황', exact: true }).waitFor();
      const partial = page
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: '보존된 부분 출력' }) });
      await partial.locator('summary').click();
      await page.screenshot({
        path: path.join(info.output, 'after-' + viewport.width + '-partial-details.png'),
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const result = {
    schema: 1,
    synthetic: true,
    url: info.url + '/?chat=' + chat.id,
    chatId: chat.id,
    measuredAt: new Date().toISOString(),
    observations,
  };
  await writeFile(path.join(info.output, 'errors.json'), JSON.stringify(result, null, 2));
  process.stdout.write('UI_ERROR_EVIDENCE ' + JSON.stringify(result) + '\n');
}
