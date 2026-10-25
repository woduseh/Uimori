import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

// Keep browser, home-screen and maskable icons derived from the same vector source.
const source = await readFile(new URL('../web/public/favicon.svg', import.meta.url));
const publicRoot = new URL('../web/public/', import.meta.url);
for (const [file, size] of [
  ['favicon.png', 64],
  ['icons/app-192.png', 192],
  ['icons/app-512.png', 512],
  ['icons/apple-touch-icon.png', 180],
]) {
  await sharp(source, { density: 768 })
    .resize(size, size)
    .png()
    .toFile(fileURLToPath(new URL(file, publicRoot)));
}

// The complete seal fits inside the maskable icon's central 80% safe circle.
const mark = await sharp(source, { density: 768 }).resize(400, 400).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#25231f' } })
  .composite([{ input: mark, gravity: 'centre' }])
  .png()
  .toFile(fileURLToPath(new URL('icons/app-maskable-512.png', publicRoot)));
