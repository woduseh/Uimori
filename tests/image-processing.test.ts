import { expect, test } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { processImage } from '../server/image-processing.js';

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
