import { expect, test } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { processImage, resizeIllustrationReference } from '../server/image-processing.js';

test('animated GIF keeps both frames, timing and loop when stored as WebP', async () => {
  const raw = Buffer.alloc(8 * 16 * 4);
  for (let index = 0; index < raw.length; index += 4) {
    raw[index] = index < raw.length / 2 ? 255 : 0;
    raw[index + 2] = index < raw.length / 2 ? 0 : 255;
    raw[index + 3] = 255;
  }
  const gif = await sharp(raw, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } })
    .gif({ delay: [70, 140], loop: 2 })
    .toBuffer();
  const before = await sharp(gif, { animated: true }).metadata();
  expect(before.pages).toBe(2);
  const converted = await processImage(gif);
  const after = await sharp(converted.bytes, { animated: true }).metadata();
  expect(after.format).toBe('webp');
  expect(after.pages).toBe(2);
  expect(after.pageHeight).toBe(before.pageHeight);
  expect(after.width).toBe(before.width);
  expect(after.delay).toEqual(before.delay);
  expect(after.loop).toBe(before.loop);
  expect(converted.hash).toBe(createHash('sha256').update(converted.bytes).digest('hex'));
});

test('PNG intake keeps image dimensions and transparency in WebP', async () => {
  const png = await sharp({
    create: {
      width: 128,
      height: 96,
      channels: 4,
      background: { r: 120, g: 30, b: 80, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const converted = await processImage(png);
  const metadata = await sharp(converted.bytes).metadata();
  expect(metadata).toMatchObject({ format: 'webp', width: 128, height: 96, hasAlpha: true });
});

test('repeated WebP intake is byte-identical rather than another lossy encoding', async () => {
  const original = await sharp({
    create: { width: 24, height: 16, channels: 4, background: '#aaccdd88' },
  })
    .webp({ quality: 90 })
    .toBuffer();
  const first = await processImage(original),
    second = await processImage(first.bytes);
  expect(second.bytes.equals(original)).toBe(true);
  expect(second.hash).toBe(first.hash);
});

test.each([false, true])(
  'WebP with intact dimensions but damaged pixel data is rejected before storage (lossless=%s)',
  async (lossless) => {
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let index = 0; index < pixels.length; index++)
      pixels[index] = (index * 17 + (index % 29)) % 256;
    const damaged = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
      .webp({ lossless })
      .toBuffer();
    damaged.fill(255, 40);
    expect(await sharp(damaged).metadata()).toMatchObject({
      format: 'webp',
      width: 64,
      height: 64,
    });
    await expect(processImage(damaged)).rejects.toThrow(
      '이미지를 읽거나 WebP로 변환하지 못했어요.'
    );
  }
);

test('WebP intake preserves animated bytes and validates pixels in the last frame', async () => {
  const pixels = Buffer.alloc(64 * 128 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = (index * 17 + (index % 29)) % 256;
    pixels[index + 1] = (index * 13 + (index % 31)) % 256;
    pixels[index + 2] = (index * 11 + (index % 37)) % 256;
    pixels[index + 3] = 255;
  }
  const original = await sharp(pixels, {
    raw: { width: 64, height: 128, channels: 4, pageHeight: 64 },
  })
    .webp({ delay: [70, 140], loop: 2 })
    .toBuffer();
  const processed = await processImage(original);
  expect(processed.bytes).toBe(original);
  expect(processed).toMatchObject({ width: 64, height: 64 });
  expect(await sharp(processed.bytes, { animated: true }).metadata()).toMatchObject({
    pages: 2,
    pageHeight: 64,
    delay: [70, 140],
    loop: 2,
  });

  const damaged = Buffer.from(original);
  let lastFrame = 0;
  for (let offset = 12; offset < damaged.length; ) {
    const size = damaged.readUInt32LE(offset + 4);
    if (damaged.toString('ascii', offset, offset + 4) === 'ANMF') lastFrame = offset;
    offset += 8 + size + (size % 2);
  }
  expect(lastFrame).toBeGreaterThan(0);
  // Keep the frame/chunk headers and VP8 dimensions intact; corrupt only its pixel bitstream.
  expect(damaged.toString('ascii', lastFrame + 24, lastFrame + 28)).toBe('VP8 ');
  damaged.fill(255, lastFrame + 42, lastFrame + 8 + damaged.readUInt32LE(lastFrame + 4));
  expect(await sharp(damaged, { animated: true }).metadata()).toMatchObject({ pages: 2 });
  expect((await sharp(damaged, { pages: 1 }).raw().toBuffer()).length).toBe(64 * 64 * 3);
  await expect(processImage(damaged)).rejects.toThrow('이미지를 읽거나 WebP로 변환하지 못했어요.');
});

test('Codex reference transmission bounds pixels without modifying stored image bytes or enlarging small references', async () => {
  const original = await sharp({
    create: { width: 3072, height: 2048, channels: 4, background: '#aaccdd88' },
  })
    .png()
    .toBuffer();
  const hash = createHash('sha256').update(original).digest('hex');
  const copy = await resizeIllustrationReference(original, 'image/png');
  expect(copy.mime).toBe('image/webp');
  expect(await sharp(copy.bytes).metadata()).toMatchObject({
    width: 1536,
    height: 1024,
    hasAlpha: true,
  });
  expect(createHash('sha256').update(original).digest('hex')).toBe(hash);
  expect(await sharp(original).metadata()).toMatchObject({ width: 3072, height: 2048 });
  const unchanged = await resizeIllustrationReference(copy.bytes, copy.mime);
  expect(unchanged.bytes).toBe(copy.bytes);
});
