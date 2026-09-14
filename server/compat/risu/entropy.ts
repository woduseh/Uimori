import { createHash } from 'node:crypto';

/** Binds a frozen receipt entry to the inputs it was produced from, and seeds the generator below. */
export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * mulberry32, seeded from the entry key. A Risu evaluation that draws entropy - `{{random}}`, `{{roll}}`,
 * an `@@probability` roll - must give the same answer every time this exact entry of this exact run is
 * evaluated, and a different one for the next run.
 */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
