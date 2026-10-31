import { afterEach, expect, test } from 'vitest';
import sharp from 'sharp';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { Store } from '../server/store.js';
import { storeImage, readImage } from '../server/image-storage.js';
import { listHelperImages, readHelperImage } from '../server/helper-image-tools.js';
import { nativeContent } from './fixtures/native-content.js';
import type { PackageImage } from '../core/package-images.js';
import { writeRisuZip } from '../server/risu-export-codec.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';

const fixtures: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    const directory = resolve(fixture.directory);
    const rel = relative(resolve(tmpdir()), directory);
    if (
      isAbsolute(rel) ||
      rel.startsWith('..') ||
      !basename(directory).startsWith('uimori-helper-image-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-helper-image-'));
  const store = new Store(join(directory, 'test.sqlite'));
  fixtures.push({ store, directory });
  return store;
}
function save(store: Store, bytes: Buffer, count = 1, mime: PackageImage['mime'] = 'image/png') {
  const hash = createHash('sha256').update(bytes).digest('hex');
  storeImage(store.db, { hash, mime, bytes });
  const images: PackageImage[] = Array.from({ length: count }, (_, index) => ({
    id: `image-${index}`,
    title: `Portrait ${index}`,
    description: index === 1 ? 'x'.repeat(2000) : 'A red portrait',
    blobHash: hash,
    mime,
    allowedUse: 'both',
  }));
  const pkg = nativeContent({ name: 'Synthetic character' }, { images });
  pkg.nativeRisu.assets = images.map((image, index) => ({
    name: `original-emotion-${index}`,
    uri: `embeded://assets/${index}.png`,
    imageId: image.id,
  }));
  return store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  });
}
const red = () =>
  sharp({ create: { width: 12, height: 8, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();

test('CHARX imports expose the original named image and supply its actual pixels', async () => {
  const store = fixture();
  const png = await red();
  const archive = writeRisuZip(
    new Map([
      [
        'card.json',
        Buffer.from(
          JSON.stringify({
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
              name: 'Synthetic CHARX',
              description: '',
              assets: [
                {
                  name: 'happy-face',
                  uri: 'embeded://assets/happy.png',
                  type: 'emotion',
                  ext: 'png',
                },
              ],
            },
          })
        ),
      ],
      ['assets/happy.png', png],
    ])
  );
  const source = { name: 'synthetic.charx', base64: archive.toString('base64') };
  const preview = prepareRisuImport({ source });
  const imported = await applyRisuImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'helper-image-charx',
  });
  const contentId = imported.receipt.items[0].id;
  const page = listHelperImages(store, { contentId, query: 'happy-face' });
  expect(page.images).toMatchObject([{ nativeNames: ['happy-face'] }]);
  const read = await readHelperImage(store, { contentId, imageId: page.images[0].imageId });
  const transmitted = Buffer.from(read.resolved.base64, 'base64');
  expect(read.image.input.hash).toBe(read.result.source.hash);
  expect(transmitted).toEqual(readImage(store.db, read.result.source.hash).bytes);
  const pixels = await sharp(transmitted).raw().toBuffer();
  expect(pixels[0]).toBeGreaterThan(240);
  expect(pixels[2]).toBeLessThan(15);
});

test('discovery searches original asset names and gives bounded, complete pagination', async () => {
  const store = fixture();
  const content = save(store, await red(), 23);
  const first = listHelperImages(store, { contentId: content.id, limit: 20 });
  expect(first).toMatchObject({ total: 23, matching: 23, nextOffset: 20 });
  expect(first.images).toHaveLength(20);
  expect(first.images[1]).toMatchObject({ descriptionTruncated: true });
  expect(first.images[1].description).toHaveLength(500);
  const last = listHelperImages(store, { contentId: content.id, offset: first.nextOffset });
  expect(last.images).toHaveLength(3);
  expect(last.nextOffset).toBeNull();
  expect(
    listHelperImages(store, { contentId: content.id, query: 'original-emotion-22' }).images
  ).toMatchObject([{ imageId: 'image-22' }]);
  expect(listHelperImages(store, { contentId: content.id, query: 'missing' })).toMatchObject({
    total: 23,
    matching: 0,
    images: [],
    nextOffset: null,
  });
});

test('transmission limits high-entropy pixels to 2048px and 2MiB', async () => {
  const store = fixture();
  const bytes = await sharp(randomBytes(2200 * 2100 * 4), {
    raw: { width: 2200, height: 2100, channels: 4 },
  })
    .png()
    .toBuffer();
  const content = save(store, bytes);
  const read = await readHelperImage(store, { contentId: content.id, imageId: 'image-0' });
  expect(read.result.source).toMatchObject({ width: 2200, height: 2100 });
  expect(Math.max(read.image.width, read.image.height)).toBeLessThanOrEqual(2048);
  expect(Buffer.from(read.resolved.base64, 'base64').length).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(read.image.input).toEqual({
    hash: read.image.hash,
    width: read.image.width,
    height: read.image.height,
  });
});

test('animated images disclose first-frame-only inspection and preserve the animation', async () => {
  const store = fixture();
  const pixels = Buffer.from([255, 0, 0, 0, 0, 255]);
  const bytes = await sharp(pixels, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
    .gif({ delay: [100, 100], loop: 0 })
    .toBuffer();
  const content = save(store, bytes, 1, 'image/gif');
  const read = await readHelperImage(store, { contentId: content.id, imageId: 'image-0' });
  expect(read.result.source).toMatchObject({ width: 1, height: 1, frames: 2 });
  expect(read.result.notice).toContain('first frame');
  const output = await sharp(Buffer.from(read.resolved.base64, 'base64')).raw().toBuffer();
  expect(output[0]).toBeGreaterThan(240);
  expect(output[2]).toBeLessThan(15);
  expect(readImage(store.db, read.result.source.hash).bytes).toEqual(bytes);
});
