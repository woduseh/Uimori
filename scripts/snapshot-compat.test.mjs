import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
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
