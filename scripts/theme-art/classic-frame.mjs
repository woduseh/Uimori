import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const out = process.argv[2] ?? 'third_party/theme-assets';

const petals = [];
const dots = [];
for (let i = 0; i < 8; i++) {
  const a = (i * 45 * Math.PI) / 180;
  petals.push(
    `<path transform="translate(96 96) rotate(${i * 45})" d="M0 -20 C 16 -34 14 -60 0 -70 C -14 -60 -16 -34 0 -20 Z"/>`
  );
  const b = a + Math.PI / 8;
  dots.push(
    `<circle cx="${(96 + 62 * Math.sin(b)).toFixed(1)}" cy="${(96 - 62 * Math.cos(b)).toFixed(1)}" r="5"/>`
  );
}
const rosette = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
<rect x="4" y="4" width="184" height="184" fill="none" stroke="#000" stroke-width="6"/>
<rect x="16" y="16" width="160" height="160" fill="none" stroke="#000" stroke-width="2.5"/>
<g fill="#000">${petals.join('')}${dots.join('')}<circle cx="96" cy="96" r="14"/></g>
<circle cx="96" cy="96" r="6" fill="#fff"/></svg>`;

const leaves = (side) => {
  const sign = side === 'left' ? -1 : 1;
  const list = [];
  for (let i = 0; i < 9; i++) {
    const x = 240 + sign * (34 + i * 20);
    const y = 34 - Math.sin((i / 8) * Math.PI) * 6;
    const up = i % 2 === 0;
    const angle = sign * (up ? -35 : 35) + (side === 'left' ? 180 : 0);
    list.push(
      `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle})" d="M0 0 C 6 -6 20 -6 26 0 C 20 6 6 6 0 0 Z"/>`
    );
  }
  const end = 240 + sign * 210;
  return `<path d="M${240 + sign * 26} 34 Q ${240 + sign * 120} 22 ${end} 34" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>${list.join('')}`;
};
const laurel = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 64">
<g fill="#000">${leaves('left')}${leaves('right')}
<ellipse cx="226" cy="30" rx="12" ry="7" fill="none" stroke="#000" stroke-width="3"/>
<ellipse cx="254" cy="30" rx="12" ry="7" fill="none" stroke="#000" stroke-width="3"/>
<circle cx="240" cy="32" r="5"/>
<path d="M238 36 L226 56 L232 54 L236 60 Z"/><path d="M242 36 L254 56 L248 54 L244 60 Z"/></g></svg>`;

for (const [name, svg, width] of [
  ['classic-rosette', rosette, 384],
  ['classic-laurel', laurel, 960],
]) {
  const raster = await sharp(Buffer.from(svg), { density: 300 }).resize({ width }).png().toBuffer();
  const { data, info } = await sharp(raster)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i] > 128 && data[i + 1] > 128 && data[i + 2] > 128) data[i + 3] = 0;
  const bytes = await sharp(data, { raw: info }).webp({ lossless: true }).toBuffer();
  writeFileSync(`${out}/${name}.webp`, bytes);
  console.log(name, bytes.length, createHash('sha256').update(bytes).digest('hex'));
}
