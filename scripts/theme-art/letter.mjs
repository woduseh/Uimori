import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const out = process.argv[2] ?? 'third_party/theme-assets';

const leaf = (x, y, angle, size = 1) =>
  `<path transform="translate(${x} ${y}) rotate(${angle}) scale(${size})" d="M0 0 C 6 -10 18 -12 26 -4 C 18 2 8 4 0 0 Z"/>`;
const corner = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 240 240">
<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
  <path stroke-width="3" d="M14 226 V 70 C 14 36 36 14 70 14 H 226"/>
  <path stroke-width="1.4" d="M26 214 V 84 C 26 50 50 26 84 26 H 214"/>
</g>
<g id="vine">
  <g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
    <path stroke-width="2.4" d="M40 160 C 40 104 58 74 92 64 C 122 56 140 74 134 96 C 128 114 106 114 104 100 C 102 90 114 84 120 92"/>
    <path stroke-width="1.8" d="M40 160 C 40 182 30 200 18 208"/>
    <path stroke-width="1.6" d="M66 122 C 80 134 98 134 110 124"/>
  </g>
  <g fill="#000">${leaf(56, 138, -70, 1.1)}${leaf(44, 172, -110, 0.9)}${leaf(80, 128, 20, 0.8)}${leaf(92, 64, -40, 0.9)}<circle cx="120" cy="92" r="3.5"/></g>
</g>
<use xlink:href="#vine" transform="matrix(0 1 1 0 0 0)"/>
<g fill="#000"><circle cx="14" cy="14" r="7"/><circle cx="226" cy="14" r="4"/><circle cx="14" cy="226" r="4"/></g></svg>`;

const divider = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 64">
<g fill="none" stroke="#000" stroke-linecap="round">
  <path stroke-width="2" d="M20 32 H 176"/><path stroke-width="2" d="M304 32 H 460"/>
  <path stroke-width="2.6" d="M176 32 C 196 32 204 12 222 14 C 238 16 236 36 224 36 C 214 36 214 26 222 26"/>
  <path stroke-width="2.6" d="M304 32 C 284 32 276 52 258 50 C 242 48 244 28 256 28 C 266 28 266 38 258 38"/>
  <path stroke-width="2.6" d="M176 32 C 196 32 204 52 222 50"/><path stroke-width="2.6" d="M304 32 C 284 32 276 12 258 14"/>
</g>
<g fill="#000">
  <path d="M240 14 L 250 32 L 240 50 L 230 32 Z"/>
  <circle cx="20" cy="32" r="4"/><circle cx="460" cy="32" r="4"/><circle cx="100" cy="32" r="3"/><circle cx="380" cy="32" r="3"/>
  ${leaf(150, 32, -150, 0.8)}${leaf(150, 32, 150, 0.8)}${leaf(330, 32, -30, 0.8)}${leaf(330, 32, 30, 0.8)}
</g></svg>`;

for (const [name, svg, width] of [
  ['letter-corner', corner, 480],
  ['letter-divider', divider, 960],
]) {
  const bytes = await sharp(Buffer.from(svg), { density: 300 })
    .resize({ width })
    .webp({ lossless: true })
    .toBuffer();
  writeFileSync(`${out}/${name}.webp`, bytes);
  console.log(name, bytes.length, createHash('sha256').update(bytes).digest('hex'));
}
