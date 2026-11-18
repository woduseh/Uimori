import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const out = process.argv[2] ?? 'third_party/theme-assets';

const rays = [];
for (let i = 0; i <= 6; i++) {
  const angle = (i * 15 * Math.PI) / 180;
  const inner = 18;
  const outer = i % 2 ? 62 : 78;
  const spread = (3.5 * Math.PI) / 180;
  const p = (r, a) => `${(34 + r * Math.cos(a)).toFixed(1)} ${(34 + r * Math.sin(a)).toFixed(1)}`;
  rays.push(
    `M${p(inner, angle - spread / 3)} L${p(outer, angle - spread)} L${p(outer, angle + spread)} L${p(inner, angle + spread / 3)} Z`
  );
}
const arc = (r) => `M${34 + r} 34 A ${r} ${r} 0 0 1 34 ${34 + r}`;
const corner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<g fill="none" stroke="#000" stroke-linecap="square">
  <path stroke-width="6" d="M8 248 V8 H248"/>
  <path stroke-width="3" d="M22 220 V22 H220"/>
  <path stroke-width="2" d="M34 190 V34 H190"/>
  <path stroke-width="2" d="${arc(18)}"/><path stroke-width="2.5" d="${arc(86)}"/><path stroke-width="1.5" d="${arc(94)}"/>
</g>
<g fill="#000">
  <path d="${rays.join(' ')}"/>
  <path d="M248 0 L256 8 L248 16 L240 8 Z"/><path d="M0 248 L8 240 L16 248 L8 256 Z"/>
  <path d="M220 16 L226 22 L220 28 L214 22 Z"/><path d="M16 220 L22 214 L28 220 L22 226 Z"/>
  <circle cx="190" cy="34" r="4"/><circle cx="34" cy="190" r="4"/>
</g></svg>`;

const bars = (side) => {
  const sign = side === 'left' ? -1 : 1;
  const cx = 240;
  return [150, 110, 70]
    .map((length, index) => {
      const y = 22 + index * 10;
      const start = cx + sign * 30;
      const end = start + sign * length;
      const tip = end + sign * 8;
      return `<path d="M${start} ${y - 2} L${end} ${y - 2} L${tip} ${y} L${end} ${y + 2} L${start} ${y + 2} Z"/><circle cx="${tip + sign * 6}" cy="${y}" r="2.5"/>`;
    })
    .join('');
};
const wing = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 64">
<g fill="#000">${bars('left')}${bars('right')}
  <path d="M240 8 L262 20 V44 L240 56 L218 44 V20 Z"/>
</g>
<path d="M240 18 L252 32 L240 46 L228 32 Z" fill="#fff"/>
<circle cx="240" cy="32" r="3" fill="#000"/></svg>`;

for (const [name, svg, width] of [
  ['cinema-corner', corner, 512],
  ['cinema-wing', wing, 960],
]) {
  const raster = await sharp(Buffer.from(svg), { density: 300 }).resize({ width }).png().toBuffer();
  const { data, info } = await sharp(raster).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    const white = data[i] > 128 && data[i + 1] > 128 && data[i + 2] > 128;
    if (white) data[i + 3] = 0;
  }
  const bytes = await sharp(data, { raw: info }).webp({ lossless: true }).toBuffer();
  writeFileSync(`${out}/${name}.webp`, bytes);
  console.log(name, bytes.length, createHash('sha256').update(bytes).digest('hex'));
}
