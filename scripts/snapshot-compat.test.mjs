import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Agent } from 'undici';
import { compare, compareRead, portable, read } from './snapshot-compat/compare.mjs';
import { sendWithRetry } from './snapshot-compat/requests.mjs';
import { rulesForCommit } from './snapshot-compat/reviewed-changes.mjs';
import { commit } from './snapshot-compat/rules/v0.18.1.mjs';

test('a failed response body records its phase and URL and the next comparison still reports data loss', async () => {
  const routes = ['/api/chats', '/api/health'];
  let otherBodyFinished = false;
  const instance = (name) => ({
    name,
    routes,
    request: async (url) => {
      if (name === 'A' && url === '/api/chats')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('body deadline', 'TimeoutError'));
            },
          })
        );
      if (url === '/api/chats')
        return new Response(
          new ReadableStream({
            start(controller) {
              setImmediate(() => {
                otherBodyFinished = true;
                controller.close();
              });
            },
          })
        );
      assert.ok(otherBodyFinished, 'the previous pair still has a response in flight');
      return Response.json({ ready: name === 'A' });
    },
  });
  const report = {
    coverage: {},
    completed: {},
    ids: new Set(),
    rules: [],
    differences: [],
    errors: [],
    refusalOnly: [],
    comparisons: 0,
    bytes: 0,
  };
  await compare('old-new', instance('A'), instance('B'), report, '');
  assert.equal(report.errors.length, 1);
  assert.deepEqual(
    [
      report.errors[0].phase,
      report.errors[0].method,
      report.errors[0].url,
      report.errors[0].instance,
    ],
    ['old-new', 'GET', '/api/chats', 'A']
  );
  assert.match(report.errors[0].error, /TimeoutError/);
  assert.equal(report.comparisons, 1);
  assert.deepEqual(report.completed['old-new'], { '/api/chats': 0, '/api/health': 1 });
  assert.deepEqual(
    report.differences.map((d) => d.url),
    ['/api/health']
  );
});

test('only the reviewed scene-detail 404 pair absorbs both fields and its derived wire length', async () => {
  const path = '/api/attempts/:/scene-detail',
    url = '/api/attempts/fixture/scene-detail';
  const report = {
    rules: rulesForCommit(commit),
    derivedContentLengths: 0,
    comparisons: 0,
    bytes: 0,
    differences: [],
  };
  const refusal = (body) => {
    const text = JSON.stringify(body);
    return read(
      {
        request: () =>
          new Response(text, {
            status: 404,
            headers: {
              'content-length': String(Buffer.byteLength(text)),
              'content-type': 'application/json',
            },
          }),
      },
      path,
      url,
      report
    );
  };
  for (const code of ['LIBRARY_ITEM_DELETED', 'OTHER']) {
    await compareRead(
      'old-new',
      url,
      refusal({ error: 'Scene invocation not found' }),
      refusal({ code }),
      report,
      report.differences,
      path
    );
  }
  assert.equal(report.rules.find((r) => r.id === 'scene-detail-refusal').absorbed, 2);
  assert.equal(report.derivedContentLengths, 1);
  assert.deepEqual(report.differences.map((d) => d.path).sort(), [
    '$["body"]["code"]',
    '$["body"]["error"]',
    '$["headers"]["content-length"]',
  ]);
});

test('reviewed scene label removal still reports adjacent manuscript loss and every restore difference', async () => {
  const route = '/api/chats/:/manuscript',
    url = '/api/chats/chat/manuscript';
  const before = {
    status: 200,
    headers: {},
    body: { scenes: [{ label: 'scene', text: 'authored' }] },
  };
  const after = { status: 200, headers: {}, body: { scenes: [{}] } };
  const report = { rules: rulesForCommit(commit), comparisons: 0, differences: [] };
  for (const phase of ['old-new', 'old-restore', 'new-restore']) {
    await compareRead(phase, url, before, after, report, report.differences, route);
    assert.deepEqual(
      report.differences.splice(0).map((x) => x.path),
      phase === 'old-new'
        ? ['$["body"]["scenes"][0]["text"]']
        : ['$["body"]["scenes"][0]["label"]', '$["body"]["scenes"][0]["text"]']
    );
  }
  before.body.scenes = { 0: { label: 'author object key' } };
  after.body.scenes = { 0: {} };
  await compareRead('old-new', url, before, after, report, report.differences, route);
  assert.equal(report.differences.length, 1);
  assert.equal(report.rules.find((r) => r.id === 'manuscript-label').absorbed, 1);
});

test('the reviewed reader opening flag absorbs only an added true flag', async () => {
  const route = '/api/chats/:/reader',
    url = '/api/chats/chat/reader';
  const report = { rules: rulesForCommit(commit), comparisons: 0, differences: [] };
  const before = { status: 200, headers: {}, body: { runs: [{ id: 'a' }, { id: 'b' }] } };
  const after = {
    status: 200,
    headers: {},
    body: {
      runs: [
        { id: 'a', opening: true },
        { id: 'b', opening: false },
      ],
    },
  };
  await compareRead('old-new', url, before, after, report, report.differences, route);
  assert.deepEqual(
    report.differences.map((x) => x.path),
    ['$["body"]["runs"][1]["opening"]']
  );
  assert.equal(report.rules.find((r) => r.id === 'reader-opening-flag').absorbed, 1);
});

test('illustration links follow their imported resource while a switched image remains a finding', () => {
  function archive(id, image) {
    const role = 'bot',
      localProfile = 'lead';
    const profileId =
      'default:' + createHash('sha256').update([id, role, localProfile].join(':')).digest('hex');
    const reference = {
      id: profileId,
      name: 'Lead',
      appearance: 'Dark hair',
      referenceRef: 'package:' + id + ':bot:' + image,
    };
    return {
      manifest: {
        resources: {
          contents: [
            {
              key: 'content-1',
              source: {
                id,
                package: {
                  nativeRisu: {
                    card: {
                      extensions: { uimori: { illustrationProfiles: [{ id: localProfile }] } },
                    },
                  },
                },
              },
            },
          ],
          prompts: [],
        },
        backup: {
          chats: [
            {
              transcript: { packageAttachments: [{ id, role }] },
              state: {
                illustrationReferences: {
                  references: [],
                  images: [],
                  characterProfiles: [reference],
                },
              },
            },
          ],
        },
      },
    };
  }
  assert.deepEqual(portable(archive('old', 'portrait')), portable(archive('new', 'portrait')));
  assert.notDeepEqual(portable(archive('old', 'portrait')), portable(archive('new', 'landscape')));
});

test('chat import accepts the historical projected greeting label and detects a replaced custom title', () => {
  const archive = (title) => ({
    manifest: {
      resources: {
        prompts: [],
        contents: [
          {
            key: 'bot',
            modules: [],
            source: {
              id: 'bot',
              revision: 2,
              package: {
                id: 'bot',
                revision: 2,
                nativeRisu: { card: { first_mes: 'hello' } },
                starts: [{ id: 'start-0', title, text: 'hello', mode: 'authored' }],
              },
            },
          },
        ],
      },
      backup: { chats: [] },
    },
  });
  const imported = archive('기본 첫 메시지');
  Object.assign(imported.manifest.resources.contents[0].source, { revision: 1 });
  Object.assign(imported.manifest.resources.contents[0].source.package, {
    modules: [],
    revision: 1,
  });
  assert.deepEqual(portable(archive('기본 시작문'), true), portable(imported));
  assert.notDeepEqual(portable(archive('My opening'), true), imported);
});

const chatArchive = ({ entries, messages }) => ({
  manifest: {
    resources: { prompts: [], contents: [] },
    backup: { chats: [{ transcript: { entries, packageAttachments: [] }, state: { messages } }] },
  },
});
const defaultScene = { requestText: null, requestEnabled: true, sceneEnabled: true };

test('chat import absorbs exactly the default scene context and still reports any other value', () => {
  const imported = portable(chatArchive({ entries: [{ text: 'a' }], messages: [] }));
  const source = (sceneContext) =>
    portable(chatArchive({ entries: [{ text: 'a', sceneContext }], messages: [] }), true);
  assert.deepEqual(source(defaultScene), imported);
  for (const other of [
    { ...defaultScene, sceneEnabled: false },
    { ...defaultScene, requestEnabled: false },
    { ...defaultScene, requestText: '' },
    { ...defaultScene, requestText: 'rewritten' },
    { ...defaultScene, extra: true },
    { requestText: null, requestEnabled: true },
  ])
    assert.notDeepEqual(source(other), imported, JSON.stringify(other));
  assert.notDeepEqual(
    portable(chatArchive({ entries: [{ text: 'a' }], messages: [] }), true),
    portable(chatArchive({ entries: [{ text: 'a', sceneContext: defaultScene }], messages: [] }))
  );
});

test('the cache header of a deleted risu export refusal is absorbed only on the two export routes', async () => {
  const refusal = (headers, body = { error: 'Library item not found' }, status = 404) => ({
    status,
    headers,
    body,
  });
  const run = async (route, url, before, after) => {
    const report = {
      rules: rulesForCommit(commit),
      derivedContentLengths: 0,
      comparisons: 0,
      differences: [],
    };
    await compareRead('old-new', url, before, after, report, report.differences, route);
    return report.differences.map((d) => d.path);
  };
  const deleted = { code: 'LIBRARY_ITEM_DELETED' };
  for (const [route, url] of [
    ['/api/content/:/risu-export', '/api/content/x/risu-export'],
    ['/api/prompt-presets/:/risu-export', '/api/prompt-presets/x/risu-export'],
  ]) {
    assert.deepEqual(
      await run(route, url, refusal({}), refusal({ 'cache-control': 'no-store' }, deleted)),
      []
    );
    assert.deepEqual(
      await run(route, url, refusal({}), refusal({ 'cache-control': 'no-cache' }, deleted)),
      ['$["headers"]["cache-control"]']
    );
    assert.deepEqual(
      await run(
        route,
        url,
        refusal({}),
        refusal({ 'cache-control': 'no-store', 'x-other': '1' }, deleted)
      ),
      ['$["headers"]["x-other"]']
    );
    assert.deepEqual(
      await run(
        route,
        url,
        refusal({}, { error: 'Revision conflict' }, 409),
        refusal({ 'cache-control': 'no-store' }, { error: 'Revision conflict' }, 409)
      ),
      ['$["headers"]["cache-control"]']
    );
    assert.deepEqual(
      await run(
        route,
        url,
        refusal({}, { error: 'Other' }),
        refusal({ 'cache-control': 'no-store' }, deleted)
      ),
      ['$["headers"]["cache-control"]', '$["body"]["error"]', '$["body"]["code"]']
    );
  }
  assert.deepEqual(
    await run(
      '/api/content/:',
      '/api/content/x',
      refusal({}),
      refusal({ 'cache-control': 'no-store' }, deleted)
    ),
    ['$["headers"]["cache-control"]']
  );
});

async function dropServer(drops) {
  const hits = { count: 0 };
  const server = createServer((request, response) => {
    hits.count++;
    if (hits.count <= drops) request.socket.destroy();
    else response.writeHead(hits.status ?? 200).end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    hits,
    url: 'http://127.0.0.1:' + server.address().port + '/api/x',
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a dropped connection retries one idempotent GET and nothing else', async () => {
  const agent = new Agent();
  try {
    const attempt = async (drops, options, status) => {
      const server = await dropServer(drops);
      server.hits.status = status;
      const report = { retries: [] };
      try {
        const response = await sendWithRetry(
          () => fetch(server.url, { ...options, dispatcher: agent }),
          '/api/x',
          options,
          report,
          'A'
        ).then(
          (r) => r.status,
          (error) => error.message
        );
        return { response, retries: report.retries, hits: server.hits.count };
      } finally {
        await server.close();
      }
    };
    const once = await attempt(1, undefined);
    assert.deepEqual([once.response, once.hits, once.retries.length], [200, 2, 1]);
    assert.deepEqual([once.retries[0].url, once.retries[0].instance], ['/api/x', 'A']);
    const twice = await attempt(2, undefined);
    assert.deepEqual([twice.response, twice.hits, twice.retries.length], ['fetch failed', 2, 1]);
    const post = await attempt(1, { method: 'POST', body: 'x' });
    assert.deepEqual([post.response, post.hits, post.retries.length], ['fetch failed', 1, 0]);
    const refused = await attempt(0, undefined, 500);
    assert.deepEqual([refused.response, refused.hits, refused.retries.length], [500, 1, 0]);
  } finally {
    await agent.close();
  }
});

function openingDatabase(directory, name, firstSnapshot, secondRoot = false) {
  const file = join(directory, name + '.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE runs (id TEXT, chat_id TEXT, snapshot TEXT, created_at TEXT);
    CREATE TABLE sources (id TEXT, run_id TEXT, parent_revision TEXT);
    CREATE TABLE chats (id TEXT, head_revision TEXT)`);
  const run = db.prepare('INSERT INTO runs VALUES (?,?,?,?)');
  const source = db.prepare('INSERT INTO sources VALUES (?,?,?)');
  run.run('r0', 'chat', JSON.stringify(firstSnapshot), '2026-01-01');
  run.run('r1', 'chat', '{}', '2026-01-02');
  source.run('s0', 'r0', null);
  source.run('s1', 'r1', secondRoot ? null : 's0');
  db.prepare('INSERT INTO chats VALUES (?,?)').run('chat', 's1');
  db.close();
  return file;
}
const restoredSnapshot = { nativeRisuAuthored: { greeting: true } };

async function reviewedPaths(route, before, after, file) {
  const url = route.replace(':', 'chat');
  const report = { rules: rulesForCommit(commit), comparisons: 0, differences: [] };
  const left = { status: 200, headers: {}, body: before };
  const right = { status: 200, headers: {}, body: after };
  await compareRead('old-new', url, left, right, report, report.differences, route, file);
  return {
    paths: report.differences.map((d) => d.path),
    absorbed: Object.fromEntries(
      report.rules.filter((r) => r.absorbed).map((r) => [r.id, r.absorbed])
    ),
  };
}

test('removed evaluation tools are absorbed only as the removed field of a preset or library model', async () => {
  const tools = { contextMode: 'a', approvalReasoningMode: 'b', metadataProfile: 'c' };
  const preset = '/api/model-presets/:';
  assert.deepEqual(await reviewedPaths(preset, { id: 'm', evaluationTools: tools }, { id: 'm' }), {
    paths: [],
    absorbed: { 'model-preset-evaluation-tools': 1 },
  });
  assert.deepEqual(
    (
      await reviewedPaths(
        preset,
        { id: 'm', title: 'a', evaluationTools: tools },
        { id: 'm', title: 'b' }
      )
    ).paths,
    ['$["body"]["title"]']
  );
  assert.deepEqual(
    (
      await reviewedPaths(
        preset,
        { evaluationTools: tools },
        { evaluationTools: { ...tools, contextMode: 'x' } }
      )
    ).paths,
    ['$["body"]["evaluationTools"]["contextMode"]']
  );
  assert.deepEqual(
    (await reviewedPaths('/api/connections/:', { evaluationTools: tools }, {})).paths,
    ['$["body"]["evaluationTools"]']
  );
  const models = (...items) => ({ models: items });
  assert.deepEqual(
    await reviewedPaths(
      '/api/library',
      models({ id: 'a', evaluationTools: tools }, { id: 'b', title: 'x', evaluationTools: tools }),
      models({ id: 'a' }, { id: 'b', title: 'y' })
    ),
    { paths: ['$["body"]["models"][1]["title"]'], absorbed: { 'library-evaluation-tools': 2 } }
  );
  assert.deepEqual((await reviewedPaths('/api/library', { evaluationTools: tools }, {})).paths, [
    '$["body"]["evaluationTools"]',
  ]);
});

test('restored authored opening rules need the restored shape and absorb nothing beyond the opening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'restored-opening-'));
  try {
    const restored = openingDatabase(directory, 'restored', restoredSnapshot);
    const withStart = openingDatabase(directory, 'start', {
      ...restoredSnapshot,
      packageStart: { mode: 'default' },
    });
    const plain = openingDatabase(directory, 'plain', { nativeRisuAuthored: { greeting: false } });
    const detached = openingDatabase(directory, 'detached', restoredSnapshot, true);
    const scenes = (...numbers) => ({ scenes: numbers.map((number) => ({ number })) });

    const manuscript = '/api/chats/:/manuscript';
    assert.deepEqual(await reviewedPaths(manuscript, scenes(1, 2, 3), scenes(0, 1, 2), restored), {
      paths: [],
      absorbed: { 'restored-opening-manuscript': 3 },
    });
    for (const file of [withStart, plain, detached])
      assert.equal(
        (await reviewedPaths(manuscript, scenes(1, 2), scenes(0, 1), file)).paths.length,
        2
      );
    for (const after of [scenes(0, 1, 1), scenes(0, 2, 2), scenes(2, 3, 4), scenes(-1, 0, 1)])
      assert.notEqual(
        (await reviewedPaths(manuscript, scenes(1, 2, 3), after, restored)).paths.length,
        0
      );
    assert.deepEqual(
      (await reviewedPaths(manuscript, scenes(2, 3), scenes(1, 2), restored)).paths,
      ['$["body"]["scenes"][0]["number"]', '$["body"]["scenes"][1]["number"]']
    );

    const reader = '/api/chats/:/reader';
    const readerBody = (navigation, runs) => ({ reader: { navigation }, runs });
    const before = readerBody(
      [
        { id: 's0', number: 1, label: '[작성된 도입문] 첫' },
        { id: 's1', number: 2, label: 'next' },
      ],
      [
        { id: 'r0', modelTitle: 'Model' },
        { id: 'r1', modelTitle: 'Model' },
      ]
    );
    const after = readerBody(
      [
        { id: 's0', number: 0, label: '첫 메시지', opening: true },
        { id: 's1', number: 1, label: 'next' },
      ],
      [
        { id: 'r0', modelTitle: null, opening: true },
        { id: 'r1', modelTitle: 'Model' },
      ]
    );
    assert.deepEqual(await reviewedPaths(reader, before, after, restored), {
      paths: [],
      absorbed: { 'restored-opening-reader': 5, 'reader-opening-flag': 1 },
    });
    assert.equal((await reviewedPaths(reader, before, after, withStart)).paths.length, 5);
    const changed = async (edit) => {
      const copy = structuredClone(after);
      edit(copy);
      return (await reviewedPaths(reader, before, copy, restored)).paths;
    };
    const navigation = (i, key) => `$["body"]["reader"]["navigation"][${i}]["${key}"]`;
    assert.deepEqual(await changed((x) => (x.runs[1].modelTitle = null)), [
      navigation(0, 'number'),
      navigation(0, 'label'),
      navigation(0, 'opening'),
      navigation(1, 'number'),
      '$["body"]["runs"][0]["modelTitle"]',
      '$["body"]["runs"][1]["modelTitle"]',
    ]);
    assert.deepEqual(await changed((x) => (x.reader.navigation[1].label = '첫 메시지')), [
      navigation(1, 'label'),
    ]);
    assert.deepEqual(await changed((x) => (x.reader.navigation[1].opening = true)), [
      navigation(1, 'opening'),
    ]);
    assert.deepEqual(await changed((x) => (x.reader.navigation[0].label = 'other')), [
      navigation(0, 'label'),
    ]);
    assert.notEqual((await changed((x) => (x.reader.navigation[1].number = 0))).length, 0);
    assert.deepEqual(await changed((x) => delete x.reader.navigation[0].opening), [
      navigation(0, 'number'),
      navigation(0, 'label'),
      navigation(1, 'number'),
      '$["body"]["runs"][0]["modelTitle"]',
    ]);
    assert.deepEqual(await changed((x) => delete x.runs[0].opening), [
      navigation(0, 'number'),
      navigation(0, 'label'),
      navigation(0, 'opening'),
      navigation(1, 'number'),
      '$["body"]["runs"][0]["modelTitle"]',
    ]);
    assert.equal((await reviewedPaths(reader, before, after, detached)).paths.length, 5);

    const runs = '/api/chats/:/reader-runs';
    const titled = (...titles) =>
      titles.map((modelTitle, i) => ({
        id: 'r' + i,
        modelTitle,
        ...(i === 0 && { opening: true }),
      }));
    const plainRuns = (...titles) => titles.map((modelTitle, i) => ({ id: 'r' + i, modelTitle }));
    assert.deepEqual(
      await reviewedPaths(runs, plainRuns('Model', 'Model'), titled(null, 'Model'), restored),
      { paths: [], absorbed: { 'restored-opening-reader-runs': 1, 'reader-runs-opening-flag': 1 } }
    );
    assert.deepEqual(
      (await reviewedPaths(runs, plainRuns('Model', 'Model'), plainRuns(null, 'Model'), restored))
        .paths,
      ['$["body"][0]["modelTitle"]']
    );
    assert.deepEqual(
      (await reviewedPaths(runs, plainRuns('Model', 'Model'), titled('Model', null), restored))
        .paths,
      ['$["body"][1]["modelTitle"]']
    );
    assert.deepEqual((await reviewedPaths(runs, plainRuns('Model'), titled(null), plain)).paths, [
      '$["body"][0]["modelTitle"]',
    ]);

    const archiveRoute = '/api/chats/:/backup-archive';
    const authored = { version: 1, action: 'x', greeting: true, messages: [] };
    const archiveBody = (...messages) => ({
      manifest: { backup: { chats: [{ state: { messages } }] } },
    });
    const message = (i, key) =>
      `$["body"]["manifest"]["backup"]["chats"][0]["state"]["messages"][${i}]["${key}"]`;
    const original = archiveBody({ sourceId: 's0', authored }, { sourceId: 's1' });
    const opened = archiveBody({ sourceId: 's0', opening: true }, { sourceId: 's1' });
    assert.deepEqual(await reviewedPaths(archiveRoute, original, opened, restored), {
      paths: [],
      absorbed: { 'restored-opening-archive': 2 },
    });
    assert.deepEqual(
      (
        await reviewedPaths(
          archiveRoute,
          original,
          archiveBody({ sourceId: 's0' }, { sourceId: 's1' }),
          restored
        )
      ).paths,
      [message(0, 'authored')]
    );
    assert.deepEqual(
      (
        await reviewedPaths(
          archiveRoute,
          original,
          archiveBody({ sourceId: 's0', authored, opening: true }, { sourceId: 's1' }),
          restored
        )
      ).paths,
      [message(0, 'opening')]
    );
    assert.deepEqual(
      (
        await reviewedPaths(
          archiveRoute,
          archiveBody({ sourceId: 's0', authored }, { sourceId: 's1', authored }),
          archiveBody({ sourceId: 's0', opening: true }, { sourceId: 's1', opening: true }),
          restored
        )
      ).paths,
      [message(1, 'authored'), message(1, 'opening')]
    );
    assert.equal((await reviewedPaths(archiveRoute, original, opened, withStart)).paths.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
