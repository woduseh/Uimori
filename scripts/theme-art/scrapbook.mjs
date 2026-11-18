import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const out = process.argv[2] ?? 'third_party/theme-assets';

let seed = 7;
const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const points = [];
let x = 0;
const firstY = 14;
points.push([0, firstY]);
while (x < 500) {
  x += 6 + random() * 8;
  points.push([Math.min(x, 512), 8 + random() * 14]);
}
points.push([512, firstY]);
const torn = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 24"><path fill="#000" d="M0 0 H512 V${firstY} ${points
  .reverse()
  .map(([px, py]) => `L${px.toFixed(1)} ${py.toFixed(1)}`)
  .join(' ')} Z"/></svg>`;

const leaf = (cx, cy, angle) =>
  `<g transform="translate(${cx} ${cy}) rotate(${angle})"><path d="M0 0 C 12 -10 34 -10 46 0 C 34 10 12 10 0 0 Z" fill-opacity=".7"/><path d="M2 0 H 44" stroke="#fff" stroke-width="2" stroke-opacity="0"/></g>`;
const flower = (cx, cy, r) =>
  `<g transform="translate(${cx} ${cy})">${[0, 72, 144, 216, 288]
    .map((a) => `<ellipse rx="${r * 0.45}" ry="${r}" transform="rotate(${a}) translate(0 ${-r})"/>`)
    .join('')}<circle r="${r * 0.4}" fill-opacity="1"/></g>`;
const sprig = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 384">
<g fill="none" stroke="#000" stroke-linecap="round"><path stroke-width="4" d="M128 372 C 96 300 170 250 136 180 C 110 126 168 80 150 24"/>
<path stroke-width="2.5" d="M136 180 C 160 160 182 150 200 152"/><path stroke-width="2.5" d="M140 110 C 116 96 96 92 78 96"/></g>
<g fill="#000">
${leaf(120, 330, -150)}${leaf(124, 300, -20)}${leaf(146, 250, -160)}${leaf(140, 214, -10)}${leaf(128, 160, -170)}${leaf(146, 130, -25)}${leaf(150, 72, -155)}
<g fill-opacity=".85">${flower(150, 22, 12)}${flower(200, 150, 10)}${flower(76, 96, 9)}</g>
</g></svg>`;

for (const [name, svg, width] of [
  ['scrap-torn', torn, 1024],
  ['scrap-sprig', sprig, 512],
]) {
  const bytes = await sharp(Buffer.from(svg), { density: 300 })
    .resize({ width })
    .webp({ lossless: true })
    .toBuffer();
  writeFileSync(`${out}/${name}.webp`, bytes);
  console.log(name, bytes.length, createHash('sha256').update(bytes).digest('hex'));
}
