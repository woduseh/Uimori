import { createHash } from 'node:crypto';
import type { AssetEntry, BlockScene, SourceBlock } from '../auxiliary.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// Synthetic artwork and lexical cues for explicitly selected local test fixtures only.
const artwork: Record<string, string> = {
  'mira-profile':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" rx="32" fill="#203b51"/><circle cx="120" cy="95" r="42" fill="#d9b78d"/><path d="M45 240v-24a75 75 0 0 1 150 0v24" fill="#688fad"/><path d="M77 85a44 44 0 0 1 86 0l-20-24-30 16z" fill="#44343c"/><circle cx="104" cy="100" r="3"/><circle cx="136" cy="100" r="3"/></svg>',
  'harbor-evening':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300"><rect width="640" height="300" fill="#253653"/><circle cx="500" cy="65" r="29" fill="#e8c28e"/><path d="M0 180h640v120H0" fill="#426b83"/><path d="M0 216h445v22H0M80 238v62m180-62v62m140-62v62" stroke="#9c7962" stroke-width="15"/><path d="M365 110v105m-18-101h36" stroke="#423f48" stroke-width="8"/><rect x="350" y="116" width="29" height="42" rx="8" fill="#edc572"/></svg>',
  'observatory-dome':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300"><rect width="640" height="300" fill="#29334c"/><circle cx="95" cy="64" r="18" fill="#d9d3b2"/><path d="M0 300Q300 80 640 300" fill="#536454"/><rect x="252" y="134" width="135" height="91" fill="#a39c84"/><path d="M250 136a70 70 0 0 1 140 0z" fill="#568f83"/><path d="M320 76v61" stroke="#375a57" stroke-width="9"/><rect x="307" y="173" width="25" height="52" fill="#48474e"/></svg>',
};
const asset = (
  ref: string,
  alt: string,
  fields: Pick<AssetEntry, 'actorId' | 'clothing' | 'location' | 'uses'>
): AssetEntry => ({
  ref,
  revision: 1,
  hash: digest(artwork[ref]),
  url: `/api/assets/${ref}`,
  alt,
  caption: `합성 로컬 에셋 · ${alt}`,
  ...fields,
});
export const BUILTIN_ASSETS: readonly AssetEntry[] = Object.freeze([
  asset('mira-profile', '미라 합성 인물 그림', {
    actorId: 'mira',
    clothing: null,
    location: null,
    uses: ['profile'],
  }),
  asset('harbor-evening', '저녁 항구 합성 그림', {
    actorId: null,
    clothing: null,
    location: 'pier',
    uses: ['inline'],
  }),
  asset('observatory-dome', '초록 지붕 천문대 합성 그림', {
    actorId: null,
    clothing: null,
    location: 'observatory',
    uses: ['inline'],
  }),
]);
export function builtinAssetSvg(ref: string): string | null {
  return Object.hasOwn(artwork, ref) ? artwork[ref] : null;
}

/** Tiny lexical scene cues for the synthetic corpus; unknown stays unknown. */
export function sourceScenes(
  blocks: SourceBlock[],
  assets: readonly AssetEntry[] = BUILTIN_ASSETS
): BlockScene[] {
  const contains = (text: string, cue: string) =>
    text.toLocaleLowerCase('en').includes(cue.toLocaleLowerCase('en'));
  return blocks.map((block) => {
    const actorIds = [
      ...new Set(
        assets.flatMap((asset) =>
          asset.actorId && contains(block.text, asset.actorId) ? [asset.actorId] : []
        )
      ),
    ];
    const clothing = [
      ...new Set(
        [
          'blue coat',
          'red cloak',
          ...assets.flatMap((asset) => (asset.clothing ? [asset.clothing] : [])),
        ].filter((cue) => contains(block.text, cue))
      ),
    ];
    const locations = [
      ...new Set(
        assets.flatMap((asset) =>
          asset.location &&
          (contains(block.text, asset.location) ||
            (asset.location === 'pier' && /\bharbor\b/iu.test(block.text)))
            ? [asset.location]
            : []
        )
      ),
    ];
    return {
      anchor: block.anchor,
      actorIds,
      clothing,
      location: locations.length === 1 ? locations[0] : null,
    };
  });
}
