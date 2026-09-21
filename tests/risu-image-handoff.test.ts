import { expect, test } from 'vitest';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  detectRisuImageHandoff,
  imageHandoffSource,
  projectRisuImageHandoff,
  risuImageGuidance,
  risuImageHandoffText,
  validateRisuImageHandoff,
} from '../core/risu-image-handoff.js';
import { nativeRisuAssetNames, type RisuContentSource } from '../core/risu-native.js';
import { nativeImageTag } from '../server/risu-native-image-tags.js';
import { renderNativeRisuMessage } from '../server/risu-native-render.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import type { RisuContent } from '../core/risu-content.js';

const source = (): RisuContentSource => ({
  version: 1,
  sourceHash: 'a'.repeat(64),
  assets: [{ name: 'Hinano_School_happy', uri: 'embeded://happy.webp', imageId: 'happy' }],
  card: {
    name: 'Synthetic',
    description: 'Keep story configuration.',
    post_history_instructions:
      'A. Narrative\nKeep this.\nC. Image Tag Insertion\nUse <img="Hinano_{Attire}_{Emotion}"> before the paragraph.\nD. Outfit\nKeep this too.',
    assets: [{ name: 'Hinano_School_happy', uri: 'embeded://happy.webp', ext: 'webp' }],
    character_book: {
      entries: [
        {
          name: 'Image Tag System',
          content: 'Use <img="Hinano_School_happy"> only when visually present.',
        },
      ],
    },
    extensions: {
      risuai: {
        customScripts: [
          {
            type: 'editdisplay',
            in: '<img="Hinano_(School|Home)_(happy|sad)">',
            out: '<div class="original-box"><img src="{{path::Hinano_$1_$2.webp}}"></div>',
          },
        ],
      },
    },
  },
});
const pkg = (native = source()): RisuContent => ({
  version: 2,
  id: 'native',
  revision: 1,
  title: 'Native',
  description: '',
  body: String(native.card.description),
  nativeRisu: native,
  lore: [
    {
      id: 'lore-0',
      title: 'Images',
      description: '',
      text: 'Use <img="Hinano_School_happy"> only when visually present.',
      loading: 'pinned',
    },
  ],
  imageHandoff: detectRisuImageHandoff(native),
});

test('image handoff moves exact explicit instruction ranges only when automatic placement is enabled', () => {
  const original = pkg(),
    before = structuredClone(original);
  expect(original.imageHandoff!.ranges).toHaveLength(2);
  expect(validateRisuImageHandoff(original.imageHandoff, original.nativeRisu!)).toEqual(
    original.imageHandoff
  );
  expect(projectRisuImageHandoff(original, false)).toBe(original);
  const projected = projectRisuImageHandoff(original, true);
  expect(projected.body).toBe('Keep story configuration.');
  expect(projected).not.toHaveProperty('instructions');
  expect(risuImageHandoffText(original, 'card:post_history_instructions')).toBe(
    'A. Narrative\nKeep this.\nD. Outfit\nKeep this too.'
  );
  expect(projected.lore[0].text).toBe('');
  expect(risuImageGuidance(original)).toContain('only when visually present');
  expect(original).toEqual(before);
  const overlapping = structuredClone(original.imageHandoff!);
  overlapping.ranges.push({ ...overlapping.ranges[0], id: 'overlap' });
  expect(() => validateRisuImageHandoff(overlapping, original.nativeRisu!)).toThrow(
    'PACKAGE_IMAGE_HANDOFF_OVERLAP'
  );
  const stale = structuredClone(original);
  stale.nativeRisu!.card.post_history_instructions = 'Changed by author';
  expect(() => validateRisuImageHandoff(stale.imageHandoff, stale.nativeRisu!)).toThrow(
    'PACKAGE_IMAGE_HANDOFF_STALE'
  );
});

test('ambiguous CBS section boundaries remain opt-in and source changes cannot inherit a previous opt-in', () => {
  const native = source();
  native.card.post_history_instructions = 'C. Image Tag Insertion\nUse <img="route">\n{{/if}}';
  const policy = detectRisuImageHandoff(native)!;
  const candidate = policy.ranges.find(
    (range) => range.field === 'card:post_history_instructions'
  )!;
  expect(candidate.confidence).toBe('candidate');
  expect(candidate.enabled).toBe(false);
  candidate.enabled = true;
  expect(
    detectRisuImageHandoff(native, policy)!.ranges.find((range) => range.field === candidate.field)!
      .enabled
  ).toBe(true);
  native.card.post_history_instructions += '\nNew text';
  expect(
    detectRisuImageHandoff(native, policy)!.ranges.find((range) => range.field === candidate.field)!
      .enabled
  ).toBe(false);
});

test('disabled lore and folders do not become image instructions', () => {
  const native = source();
  native.card.character_book = {
    entries: [
      { name: 'Image Tag System', content: 'Use <img="disabled">', enabled: false },
      { name: 'Image Tag System', content: 'Use <img="folder">', mode: 'folder' },
    ],
  };
  expect(
    detectRisuImageHandoff(native)!.ranges.every((range) => range.field.startsWith('card:'))
  ).toBe(true);
});

test('retired image instruction receipts are rejected instead of kept readable', () => {
  const native = source();
  const retired = 'C. Image Tag Insertion\nUse <img="retired"> {{setvar::retired::1}}';
  native.card.scenario = retired;
  native.card.character_book = { entries: [] };
  native.card.post_history_instructions = '';
  const historical = {
    version: 1 as const,
    ranges: [
      {
        id: 'old-scenario',
        field: 'card:scenario',
        start: 0,
        end: retired.length,
        text: retired,
        enabled: true,
        confidence: 'section' as const,
      },
    ],
    tagTemplates: ['<img="{asset}">'],
  };
  expect(() => validateRisuImageHandoff(historical, native)).toThrow('PACKAGE_IMAGE_HANDOFF_STALE');
  expect(detectRisuImageHandoff(native)?.ranges).toEqual([]);
  const value = { ...pkg(native), imageHandoff: historical };
  expect(imageHandoffSource(native, 'card:scenario')).toBe('');
  expect(risuImageGuidance(value)).toBe('');
  expect(risuImageHandoffText(value, 'card:scenario')).toBe('');
});

test('reverse mapping preserves original image tag spelling and box instead of emitting a generic image', async () => {
  const native = source(),
    url = '/api/package-image-blobs/' + 'b'.repeat(64);
  const context = {
    charName: 'Synthetic',
    userName: 'User',
    variables: {},
    messages: [],
    assetUrls: Object.fromEntries(
      nativeRisuAssetNames(native, native.assets[0]).map((name) => [name, url])
    ),
  };
  expect(context.assetUrls['Hinano_School_happy.webp']).toBe(url);
  const tag = await nativeImageTag({
    native,
    context,
    name: native.assets[0].name,
    url,
    templates: ['<img="{asset}">'],
  });
  expect(tag).toBe('<img="Hinano_School_happy">');
  const rendered = await renderNativeRisuMessage({ native, context, text: tag! });
  expect(rendered.html).toContain('class="original-box"');
  expect(rendered.html).toContain(url);
  expect(
    await nativeImageTag({
      native,
      context,
      name: native.assets[0].name,
      url: '/api/package-image-blobs/' + 'c'.repeat(64),
      templates: ['<img="{asset}">'],
    })
  ).toBeNull();
});

test('reverse mapping verifies state-dependent wardrobe resolution against the selected asset', async () => {
  const native = source();
  native.module = {
    regex: [
      {
        type: 'editdisplay',
        in: '<\\s*img\\s*=\\s*"\\s*Harper_(.*?)"\\s*>',
        flag: 'gi',
        ableFlag: true,
        out: '<div class="image-box">{{img::{{getvar::outfit}}_$1.webp}}</div>',
      },
    ],
  };
  native.assets = [{ name: 'daily_smiling.webp', uri: 'embeded://daily.webp', imageId: 'daily' }];
  const url = '/api/package-image-blobs/' + 'a'.repeat(64);
  const context = {
    charName: 'Harper',
    userName: 'User',
    variables: { outfit: 'daily' },
    messages: [],
    assetUrls: { 'daily_smiling.webp': url },
  };
  const input = {
    native,
    context,
    name: 'daily_smiling.webp',
    url,
    templates: ['<img="{asset}">'],
  };
  expect(await nativeImageTag(input)).toBe('<img="Harper_smiling">');
  expect(
    await nativeImageTag({ ...input, context: { ...context, variables: { outfit: 'other' } } })
  ).toBeNull();
});

test('reverse mapping accepts typo correction only when it renders the exact selected image', async () => {
  const native = source();
  native.module = {
    regex: [{ type: 'editdisplay', in: '<img="[^"]+">', out: '{{img::scene_annyoed.webp}}' }],
  };
  native.assets = [{ name: 'scene_annoyed.webp', uri: 'embeded://scene.webp', imageId: 'scene' }];
  const url = '/api/package-image-blobs/scene';
  const otherUrl = '/api/package-image-blobs/other';
  const context = { variables: {}, assetUrls: { 'scene_annoyed.webp': url } };
  const input = {
    native,
    context,
    name: 'scene_annoyed.webp',
    url,
    templates: ['<img="{asset}">'],
  };
  expect(await nativeImageTag(input)).toBe('<img="scene_annoyed.webp">');
  native.assets.push({ name: 'scene_annyoed.webp', uri: 'embeded://other.webp', imageId: 'other' });
  const exactOther = {
    ...context,
    assetUrls: { ...context.assetUrls, 'scene_annyoed.webp': otherUrl },
  };
  expect(await nativeImageTag({ ...input, context: exactOther })).toBeNull();
  expect(await nativeImageTag({ ...input, context: exactOther, url: otherUrl })).toBe(
    '<img="scene_annoyed.webp">'
  );
});

test.runIf(Boolean(process.env.UIMORI_RISU_LOCAL_CARDS))(
  'three local cards detect their actual image instructions, tag grammar and missing dependency',
  async () => {
    const paths: string[] = JSON.parse(process.env.UIMORI_RISU_LOCAL_CARDS!);
    for (const path of paths) {
      const input = readCharacterCard(
        { name: basename(path), uploadId: 'local-handoff' },
        undefined,
        () => readFileSync(path)
      );
      const content = analyzeNativeRisuImport(input).file.contents[0].source.package!;
      const native = content.nativeRisu!,
        policy = content.imageHandoff!;
      const assetUrls = Object.fromEntries(
        native.assets.flatMap((asset) =>
          nativeRisuAssetNames(native, asset).map((name) => [
            name,
            `/api/package-image-blobs/${content.images!.find((image) => image.id === asset.imageId)!.blobHash}`,
          ])
        )
      );
      const isHarper = basename(path) === 'Harper.charx',
        isHinano = basename(path).startsWith('Fujimiya');
      const selected = native.assets.find(
        (asset) =>
          asset.name ===
          (isHinano
            ? 'Hinano_Kitchen_default'
            : isHarper
              ? 'daily_smiling.webp'
              : 'boreum_icon0.png')
      )!;
      expect(selected).toBeDefined();
      const context = {
        charName: content.title,
        userName: 'User',
        variables: { ...content.variableDefaults?.values, outfit: 'daily', young: '0' },
        messages: [],
        assetUrls,
        messageIndex: 0,
      };
      const tag = await nativeImageTag({
        native,
        context,
        name: selected.name,
        url: assetUrls[selected.name],
        templates: policy.tagTemplates,
        guidance: risuImageGuidance(content),
      });
      if (isHinano) {
        expect(policy.ranges).toHaveLength(1);
        expect(policy.ranges[0].field).toBe('lore:lore-22');
        expect(tag).toBe('<img="Hinano_Kitchen_default">');
      } else if (isHarper) {
        expect(policy.ranges).toHaveLength(2);
        expect(tag).toBe('<img="Harper_smiling">');
      } else {
        expect(policy.ranges).toHaveLength(0);
        expect(tag).toBeNull();
      }
      console.info(
        JSON.stringify({
          file: basename(path),
          ranges: policy.ranges.map((range) => ({ field: range.field, enabled: range.enabled })),
          tagResolved: tag !== null,
        })
      );
    }
  },
  60_000
);
