import { afterEach, expect, test } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateRawSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { applyRisuImport, prepareRisuImport, risuImportRoutes } from '../server/risu-import.js';
import { nativeTransferOriginal } from '../server/native-transfer.js';
import type { Content } from '../core/product.js';
import { applyPackageTransforms } from '../server/package-transforms.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-risu-import-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-risu-import-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ directory, store });
  return store;
}
const card = () => ({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'Synthetic Pilot',
    description: '{{char}} explores an imaginary planet.',
    first_mes: 'The pilot waits.',
    alternate_greetings: ['The ship lands.'],
    character_book: {
      entries: [
        { name: 'World', content: 'The sky is green.', constant: true, enabled: true },
        {
          name: 'History',
          content: '\nEarlier travel with {{user}}.\n',
          constant: true,
          enabled: true,
        },
      ],
    },
  },
});
const sourceOf = (value: unknown) => ({
  name: 'synthetic-card.json',
  base64: Buffer.from(JSON.stringify(value)).toString('base64'),
});

test('card display regex is imported through the shared package renderer', async () => {
  const store = database();
  const value = card();
  Object.assign(value.data, {
    extensions: {
      risuai: {
        customScripts: [
          {
            type: 'editdisplay',
            in: '<state>([\\s\\S]*?)</state>',
            out: '**상태**$n$1',
            ableFlag: true,
            flag: 'g',
          },
        ],
      },
    },
  });
  const source = sourceOf(value),
    preview = prepareRisuImport({ source });
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(false);
  expect(preview.findings).toContainEqual(expect.objectContaining({ code: 'display-regex' }));
  const saved = applyRisuImport(store, {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'display-regex',
  });
  const content = store.product.get<Content>('content', saved.receipt.items[0].id);
  expect(content.package!.transforms).toHaveLength(1);
  expect(
    (await applyPackageTransforms('<state>HP 3</state>', content.package!.transforms, 'source'))
      .text
  ).toBe('**상태**\nHP 3');
  expect(nativeTransferOriginal(store, saved.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
});

test('card routes import a usable bot and chat; memory separation is opt-in, exact and idempotent', async () => {
  const store = database(),
    app = Fastify();
  risuImportRoutes(app, store);
  try {
    const source = sourceOf(card());
    const preparation = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/prepare',
      payload: { source },
    });
    expect(preparation.statusCode).toBe(200);
    const preview = preparation.json();
    expect(preview.summary).toEqual({ lore: 2, starts: 2, images: 0 });
    expect(preview.lore.every((item: { memoryCandidate: boolean }) => !item.memoryCandidate)).toBe(
      true
    );
    expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
    const body = {
      source,
      digest: preview.digest,
      memoryIds: [],
      allowPartial: false,
      idempotencyKey: 'normal',
    };
    const normal = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/apply',
      payload: body,
    });
    expect(normal.statusCode).toBe(201);
    const result = normal.json();
    const bot = store.product.get<Content>('content', result.receipt.items[0].id);
    expect(bot.package!.lore).toHaveLength(2);
    expect(bot.package!.starts).toHaveLength(2);
    expect(bot.package!.body).toBe('Synthetic Pilot explores an imaginary planet.');
    expect(store.story.notes.revision(result.chat.id)).toBe(0);
    expect(JSON.stringify(bot)).not.toContain(source.base64);
    const selectedBody = { ...body, idempotencyKey: 'with-memory', memoryIds: ['lore-1'] };
    const selected = applyRisuImport(store, selectedBody);
    expect(
      store.product.get<Content>('content', selected.receipt.items[0].id).package!.lore
    ).toHaveLength(1);
    const notes = store.story.notes.entries(store.story.notes.scope(selected.chat!.id, null));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'imported-memory',
      text: '\nEarlier travel with {{user}}.\n',
      atRevision: null,
      atHash: null,
      origin: { entryId: 'lore-1', title: 'History' },
    });
    expect(
      store.db.prepare('SELECT count(*) AS n FROM sources WHERE chat_id=?').get(selected.chat!.id)!
        .n
    ).toBe(0);
    expect(nativeTransferOriginal(store, selected.receipt.id).sourceFiles![0].base64).toBe(
      source.base64
    );
    expect(applyRisuImport(store, selectedBody)).toMatchObject({
      receipt: { id: selected.receipt.id, created: false },
      chat: { id: selected.chat!.id },
    });
    expect(() => applyRisuImport(store, { ...selectedBody, memoryIds: [] })).toThrow(
      'NATIVE_TRANSFER_IMPORT_CONFLICT'
    );
  } finally {
    await app.close();
  }
});

// A compact standard ZIP fixture exercises the actual .charx reader, including deflate and CRC.
function zip(files: [string, Buffer][]) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const path = Buffer.from(name),
      compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(path.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(header, path, compressed);
    central.push(directory, path);
    offset += header.length + path.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('charx imports embedded images and requires consent for unsupported modules; corrupt files never register', () => {
  const store = database();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64'
  );
  const value = card();
  Object.assign(value.data, {
    assets: [{ name: 'main', uri: 'embeded://assets/main.png', type: 'icon', ext: 'png' }],
    first_mes: '{{image::main}}',
  });
  const bytes = zip([
    ['card.json', Buffer.from(JSON.stringify(value))],
    ['assets/main.png', png],
    ['module.risum', Buffer.from([111, 0, 0, 0, 0, 0, 0])],
  ]);
  const source = { name: 'synthetic.charx', base64: bytes.toString('base64') };
  const preview = prepareRisuImport({ source });
  expect(preview.summary.images).toBe(1);
  expect(preview.findings).toContainEqual(
    expect.objectContaining({ code: 'embedded-module', level: 'unsupported' })
  );
  const body = {
    source,
    digest: preview.digest,
    memoryIds: [],
    allowPartial: false,
    idempotencyKey: 'charx',
  };
  expect(() => applyRisuImport(store, body)).toThrow('RISU_IMPORT_PARTIAL_REQUIRED');
  expect(store.db.prepare('SELECT count(*) AS n FROM chats').get()!.n).toBe(0);
  const result = applyRisuImport(store, { ...body, allowPartial: true });
  const pkg = store.product.get<Content>('content', result.receipt.items[0].id).package!;
  expect(pkg.images).toHaveLength(1);
  expect(pkg.starts![0].text).toMatch(/^!\[main\]\(\/api\/package-image-blobs\//u);
  expect(() =>
    prepareRisuImport({
      source: { name: 'bad.charx', base64: bytes.subarray(0, -5).toString('base64') },
    })
  ).toThrow('RISU_IMPORT_INVALID_FILE');
  expect(() => prepareRisuImport({ source: { name: 'bad.json', base64: 'eA==' } })).toThrow(
    'RISU_IMPORT_INVALID_FILE'
  );
});
