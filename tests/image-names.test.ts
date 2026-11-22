import { expect, test } from 'vitest';
import { cardDefinesImageNames, imageNameTree, type ImageNameTree } from '../core/image-names.js';
import { NATIVE_HOST_CONTEXT_ID } from '../core/provider-messages.js';
import type { MainInput } from '../core/provider.js';
import type { RunSnapshot } from '../core/types.js';
import { requestInput } from '../server/main-host-context.js';

function expand(tree: ImageNameTree, prefix = ''): string[] {
  if (Array.isArray(tree)) return tree.map((ending) => prefix + ending);
  return Object.entries(tree).flatMap(([part, child]) => expand(child, prefix + part));
}

test('a name tree states shared beginnings once and still yields every exact name', () => {
  expect(imageNameTree(['mira school-smile', 'mira school-cry', 'mira home-smile'])).toEqual({
    'mira ': { 'school-': ['smile', 'cry'], '': ['home-smile'] },
  });
  const names = [
    'mira',
    'mira_happy',
    'mira_happy_01',
    'mira_happy_02',
    'mira.sad',
    'Mira_happy',
    'lone',
    'a b-c.d_e',
    'a b-c.d_f',
    'a b',
    '_lead',
    'trail_',
    '가을 교복-웃음',
    '가을 교복-울음',
  ];
  expect(expand(imageNameTree(names)).sort()).toEqual([...names].sort());
  expect(JSON.stringify(imageNameTree(many)).length).toBeLessThan(JSON.stringify(many).length);
});

test('a card defines its image names when its text carries nearly all of their words', () => {
  const names = ['mira school-smile', 'mira school-cry', 'juno home-smile'];
  const rules =
    'Images: <img="{name} {place}-{emotion}">. Names: Mira, Juno. Places: school, home. Emotions: smile, cry.';
  expect(cardDefinesImageNames(names, rules)).toBe(true);
  expect(cardDefinesImageNames(names, rules.replace('cry', 'laugh'))).toBe(false);
  expect(cardDefinesImageNames([], rules)).toBe(false);
});

const words = [
  'amber',
  'birch',
  'cedar',
  'dune',
  'ember',
  'fjord',
  'grove',
  'heath',
  'isle',
  'jade',
];
const many = words.flatMap((a) => words.flatMap((b) => [`${a} ${b}-day`, `${a} ${b}-night`]));
function placement(
  catalog: NonNullable<NonNullable<MainInput['imagePlacement']>['catalog']>,
  options: { card?: string; hostContext?: string } = {}
) {
  const snapshot = {
    parentRevision: null,
    settings: {},
    history: [],
    profile: { packages: [{ body: options.card ?? '', lore: [] }] },
    ...(options.hostContext
      ? {
          promptCompilation: {
            usedSlots: [],
            messages: [
              {
                id: NATIVE_HOST_CONTEXT_ID,
                role: 'user',
                content: [{ type: 'text', text: options.hostContext }],
                completion: 'complete',
                provenance: { blockId: NATIVE_HOST_CONTEXT_ID, origin: 'prompt' },
              },
            ],
          },
        }
      : {}),
  } as unknown as RunSnapshot;
  const input = {
    task: '',
    facts: [],
    history: [],
    pinnedSources: [],
    prefetch: [],
    catalog: [],
    results: [],
    imagePlacement: { owner: 'writer', catalog },
  } as unknown as MainInput;
  return (requestInput(snapshot, input).source as { imagePlacement: Record<string, any> })
    .imagePlacement;
}

test('names the card spells out are not listed; other large lists become a name tree', () => {
  const bare = many.map((name) => ({ name }));
  const described = { name: 'cover', description: 'The cover image.' };
  const named = placement([...bare, described], {
    card: `Use <img="{a} {b}-{time}">. ${words.join(', ')}; day or night.`,
  });
  expect(named.catalog).toEqual([described]);
  expect(named.cardNamedImages.count).toBe(many.length);
  expect(named.nameTrees).toBeUndefined();

  const unnamed = placement([...bare, described], { card: 'A quiet town.' });
  expect(unnamed.catalog).toEqual([described]);
  expect(unnamed.cardNamedImages).toBeUndefined();
  expect(expand(unnamed.nameTrees.cardSyntax).sort()).toEqual([...many].sort());

  const listedOnlyInHostContext = placement(bare, {
    card: 'A quiet town.',
    hostContext: JSON.stringify(bare),
  });
  expect(listedOnlyInHostContext.cardNamedImages).toBeUndefined();
  expect(listedOnlyInHostContext.nameTrees.cardSyntax).toBeDefined();
});

test('short lists stay as they are, and app-syntax names keep their tag form', () => {
  const few = many.slice(0, 20).map((name) => ({ name }));
  expect(placement(few, { card: 'A quiet town.' })).toEqual({ owner: 'writer', catalog: few });
  const tagged = many.map((name) => ({ name, tag: `{{img::${name}}}` }));
  const result = placement(tagged, { card: words.join(' ') });
  expect(result.catalog).toBeUndefined();
  expect(result.cardNamedImages).toBeUndefined();
  expect(result.nameTrees.tag).toBe('{{img::NAME}}');
  expect(expand(result.nameTrees.appSyntax).sort()).toEqual([...many].sort());
});
