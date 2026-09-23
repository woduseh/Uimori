import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { projectNativeRisuPackage } from '../dist/server/risu-native-projection.js';
import { Store } from '../dist/server/store.js';
import { readImage } from '../dist/server/image-storage.js';
import { transferPersonalV1 } from './transfer-personal-v1.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

test('one-time schema-24 copy preserves sources, notes, media and JEV key without modifying the original', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-v1-transfer-test-'));
  const source = join(directory, 'old.sqlite'),
    target = join(directory, 'new.sqlite');
  let legacy, restored;
  try {
    const card = { name: 'Original bot', description: 'Original content', creator_notes: '' };
    const pkg = projectNativeRisuPackage(
      {
        version: 2,
        id: 'bot',
        revision: 1,
        title: card.name,
        description: '',
        lore: [],
        nativeRisu: { version: 1, card, assets: [], sourceHash: hash(JSON.stringify(card)) },
      },
      'bot'
    ).pkg;
    const bot = {
      id: 'bot',
      revision: 1,
      kind: 'bot',
      title: card.name,
      description: '',
      text: card.description,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    };
    const image = await sharp({
      create: { width: 16, height: 10, channels: 3, background: '#228866' },
    })
      .png()
      .toBuffer();
    const body = 'Original message\n![picture](/api/assets/picture)';
    const at = new Date().toISOString();
    legacy = new DatabaseSync(source);
    legacy.exec(`CREATE TABLE versions(kind TEXT,id TEXT,revision INTEGER,body TEXT);
      CREATE TABLE chats(id TEXT,title TEXT,head_revision TEXT,settings TEXT);
      CREATE TABLE branches(id TEXT,chat_id TEXT,title TEXT,head_revision TEXT,is_default INTEGER);
      CREATE TABLE profiles(chat_id TEXT,body TEXT);
      CREATE TABLE runs(id TEXT,request TEXT);
      CREATE TABLE sources(id TEXT,chat_id TEXT,run_id TEXT,parent_revision TEXT,text TEXT,hash TEXT);
      CREATE TABLE assets(id TEXT,body TEXT,bytes BLOB);
      CREATE TABLE author_notes(id TEXT,chat_id TEXT,entry TEXT,retired_at TEXT,replaces_id TEXT);
      PRAGMA user_version=24;`);
    legacy
      .prepare('INSERT INTO versions VALUES(?,?,?,?)')
      .run('content', 'bot', 1, JSON.stringify(bot));
    legacy.prepare('INSERT INTO chats VALUES(?,?,?,?)').run(
      'chat',
      'Original story',
      'source',
      JSON.stringify({
        status: false,
        maxCalls: 8,
      })
    );
    legacy
      .prepare('INSERT INTO branches VALUES(?,?,?,?,?)')
      .run('main:chat', 'chat', 'Main', 'source', 1);
    legacy.prepare('INSERT INTO profiles VALUES(?,?)').run(
      'chat',
      JSON.stringify({
        packageAttachments: [{ id: 'bot', revision: 1, role: 'bot' }],
        image: false,
      })
    );
    legacy.prepare('INSERT INTO runs VALUES(?,?)').run('run', 'Request');
    legacy
      .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)')
      .run('source', 'chat', 'run', null, body, hash(body));
    legacy
      .prepare('INSERT INTO assets VALUES(?,?,?)')
      .run('picture', JSON.stringify({ mime: 'image/png' }), image);
    legacy.prepare('INSERT INTO author_notes VALUES(?,?,?,?,?)').run(
      'note',
      'chat',
      JSON.stringify({
        id: 'note',
        chatId: 'chat',
        atRevision: 'source',
        atHash: hash(body),
        kind: 'author-note',
        text: 'Remember this.',
        declaration: { author: 'user', text: 'Remember this.' },
      }),
      null,
      null
    );
    legacy.close();
    legacy = undefined;
    await mkdir(`${source}.jev-credentials`);
    await writeFile(
      `${source}.jev-credentials/connection.json`,
      JSON.stringify({ revision: 1, apiKey: 'synthetic-jev-copy-key', updatedAt: at })
    );
    const before = hash(await readFile(source));
    const result = await transferPersonalV1({ source, target });
    assert.equal(hash(await readFile(source)), before);
    assert.equal(result.resources, 1);
    assert.equal(result.chats, 1);
    restored = new Store(target);
    const chat = restored.chats()[0];
    assert.notEqual(chat.id, 'chat');
    const text = restored.history(chat.headRevision)[0].text;
    assert.match(text, /Original message/);
    const imageHash = /package-image-blobs\/([a-f0-9]{64})/.exec(text)?.[1];
    assert.ok(imageHash);
    assert.equal(readImage(restored.db, imageHash).mime, 'image/webp');
    assert.equal(restored.credentials.get('jev'), 'synthetic-jev-copy-key');
    assert.equal(
      restored.story.notes.entries(restored.story.notes.scope(chat.id, chat.headRevision))[0].text,
      'Remember this.'
    );
    assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
    restored.close();
    restored = undefined;
    await assert.rejects(transferPersonalV1({ source, target }), /NEW destination/);
    assert.equal(hash(await readFile(source)), before);
  } finally {
    restored?.close();
    legacy?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
