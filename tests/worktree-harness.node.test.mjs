import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request } from '@playwright/test';
import { prepareWorktreeChat, assertWorktreeDatabase } from '../scripts/verify-worktrees.mjs';
import { removeOwned } from '../scripts/lib.mjs';

// These checks exercise HTTP fixture setup and retained SQLite evidence without
// launching a browser. They do not establish two-checkout or browser UI success.
async function fixture(t, chatStatus = 200) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({ url: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/content') res.end(JSON.stringify({ id: 'synthetic-bot' }));
    else {
      res.statusCode = chatStatus;
      res.end(JSON.stringify({ id: 'synthetic-chat', title: body.title }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let api;
  t.after(async () => {
    await api?.dispose();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  api = await request.newContext({
    baseURL: `http://127.0.0.1:${server.address().port}`,
  });
  return { api, received };
}

test('worktree setup sends an explicit owning bot before its chat over loopback HTTP', async (t) => {
  const { api, received } = await fixture(t);
  const chat = await prepareWorktreeChat(api, 'Synthetic isolated chat');
  assert.deepEqual(chat, { id: 'synthetic-chat', title: 'Synthetic isolated chat' });
  assert.equal(received.length, 2);
  assert.equal(received[0].url, '/api/content');
  assert.equal(received[0].body.kind, 'bot');
  assert.equal(received[0].body.package.version, 1);
  assert.deepEqual(received[1], {
    url: '/api/chats',
    body: { title: 'Synthetic isolated chat', botId: 'synthetic-bot' },
  });
});

test('worktree setup rejects a failed chat admission before browser generation', async (t) => {
  const { api } = await fixture(t, 409);
  await assert.rejects(
    prepareWorktreeChat(api, 'Synthetic rejected chat'),
    /fixture chat HTTP 409/
  );
});

for (const scenario of ['expected', 'wrong-source', 'wrong-chat', 'missing']) {
  test(`retained worktree SQLite evidence detects ${scenario}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'uimori-worktree-harness-'));
    t.after(() => removeOwned(tmpdir(), directory));
    const file = path.join(directory, 'synthetic.sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE sources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL)');
      if (scenario !== 'missing')
        db.prepare('INSERT INTO sources VALUES (?, ?)').run(
          scenario === 'wrong-source' ? 'other-source' : 'source-a',
          scenario === 'wrong-chat' ? 'other-chat' : 'chat-a'
        );
    } finally {
      db.close();
    }
    const reopened = new DatabaseSync(file, { readOnly: true });
    try {
      const check = () =>
        assertWorktreeDatabase(reopened, { sourceId: 'source-a', chatId: 'chat-a' });
      if (scenario === 'expected') assert.equal(check(), 1);
      else assert.throws(check, /did not preserve the expected source and chat/);
    } finally {
      reopened.close();
    }
  });
}
