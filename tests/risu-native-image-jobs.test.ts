import { afterEach, expect, test } from 'vitest';
import { splitSource } from '../core/auxiliary.js';
import { detectRisuImageHandoff } from '../core/risu-image-handoff.js';
import type { Content } from '../core/product.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { nativeImageDisplayText, nativeImageGuidance } from '../server/risu-native-images.js';
import { imageCatalog, latestImageJob, putImageBlob } from '../server/package-images.js';
import { renderNativeRisuMessage } from '../server/risu-native-render.js';
import { nativeRisuContext } from '../server/risu-native-context.js';
import {
  claimIllustration,
  completeIllustration,
  illustrationsForSources,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import { readerDetail } from '../server/reader.js';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import {
  completedSource,
  fixtureSettings,
  illustrationDatabases,
  PNG_BASE64,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-native-image-jobs-');
afterEach(() => databases.cleanup());

function fixture() {
  const store = databases.create();
  const card = {
    name: 'Native image fixture',
    description: 'A synthetic character.',
    character_book: {
      entries: [
        {
          name: 'Image Tag System',
          content: 'Use <img="Mira_happy"> before the paragraph. Outfit: {{getvar::outfit}}.',
          constant: true,
        },
      ],
    },
    assets: [
      { name: 'main', type: 'icon', uri: 'embeded://main.png', ext: 'png' },
      { name: 'Mira_happy', uri: 'embeded://happy.png', ext: 'png' },
    ],
    extensions: {
      risuai: {
        defaultVariables: 'outfit=school',
        customScripts: [
          {
            type: 'editdisplay',
            in: '<img="Mira_(happy|sad)">',
            out: '<figure class="authored-image-box">{{img::Mira_$1.png}}</figure>',
          },
        ],
      },
    },
  };
  const input = readCharacterCard({
    name: 'native.json',
    base64: Buffer.from(JSON.stringify(card)).toString('base64'),
  });
  input.members.set('main.png', () => Buffer.from(PNG_BASE64, 'base64'));
  input.members.set('happy.png', () => Buffer.from(PNG_BASE64, 'base64'));
  const { file } = analyzeNativeRisuImport(input);
  for (const { mime, base64 } of file.images) putImageBlob(store.product, { mime, base64 });
  const { id: _id, revision: _revision, ...body } = file.contents[0].source;
  const content = store.product.content(body) as Content;
  const chat = createFixtureChat(store, 'Native images', 'calm', { botId: content.id });
  const { chatId: _chatId, revision, ...profile } = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    ...profile,
    expectedRevision: revision,
    image: true,
  });
  return { store, chat, content };
}

test('validated image annotations use native boxes and placement without changing source or annotation receipts', async () => {
  const { store, chat } = fixture();
  const source = completedSource(store, chat.id, 'Mira smiles.\n\nThe afternoon stays quiet.');
  const snapshot = store.run(source.runId!).snapshot;
  expect(await nativeImageGuidance(snapshot)).toContain('Outfit: school.');
  expect(
    await nativeImageGuidance({ ...snapshot, profile: { ...snapshot.profile!, image: false } })
  ).toBe('');
  const pending = latestImageJob(store, source.id, 'original')!;
  const asset = imageCatalog(pending.input)[0];
  expect(asset).toBeDefined();
  const claim = store.claimJob(pending.id, 'images', {})!;
  expect(
    store.finishAuxiliary(pending.id, claim.generation, 'images', {
      status: 'completed',
      result: {
        mock: true,
        sourceRevision: source.id,
        sourceHash: source.hash,
        imageTarget: pending.imageTarget,
        annotations: [
          {
            blockAnchor: splitSource(source)[0].anchor,
            assetRef: asset.ref,
            assetRevision: asset.revision,
            assetHash: asset.hash,
            presentationIntent: 'inline',
            caption: 'Synthetic smile',
          },
        ],
      },
      error: null,
    })
  ).toBe(true);
  const receipt = structuredClone(store.job(pending.id));
  const display = await nativeImageDisplayText(store, snapshot, source.id);
  expect(display.issues).toEqual([]);
  expect(display.text.indexOf('<img="Mira_happy">')).toBeLessThan(
    display.text.indexOf('Mira smiles.')
  );
  const context = nativeRisuContext(snapshot)!;
  const rendered = await renderNativeRisuMessage({
    native: context.native,
    context,
    text: display.text,
  });
  expect(rendered.html).toContain('class="authored-image-box"');
  expect(rendered.html).toContain(asset.url);
  expect(store.source(source.id)).toEqual(source);
  expect(store.job(pending.id)).toEqual(receipt);
});

test('native model output reserves the existing independent illustration queue and exposes completed images in the reader', () => {
  const { store, chat } = fixture();
  const { revision, ...settings } = fixtureSettings({ automatic: true });
  updateIllustrationSettings(store, { ...settings, expectedRevision: revision }, true);
  const source = completedSource(store, chat.id);
  const job = illustrationsForSources(store, [source.id])[0];
  expect(job).toMatchObject({ status: 'queued', origin: 'automatic', sourceRevision: source.id });
  expect(latestImageJob(store, source.id, 'original')?.status).toBe('queued');
  const claim = claimIllustration(store, job.id, 'illustrations')!;
  expect(claim).not.toBeNull();
  expect(
    completeIllustration(
      store,
      job.id,
      claim.job.generation,
      'illustrations',
      [
        {
          mime: 'image/png',
          bytes: Buffer.from(PNG_BASE64, 'base64'),
          caption: 'Synthetic illustration',
        },
      ],
      { stage: 'store', attempts: [], retries: [] }
    )
  ).toBe(true);
  expect(readerDetail(store, chat.id, {}).illustrations[0]).toMatchObject({
    status: 'completed',
    images: [{ caption: 'Synthetic illustration' }],
  });
  expect(latestImageJob(store, source.id, 'original')?.status).toBe('queued');
  expect(store.source(source.id)).toEqual(source);
});

test('image guidance preserves outer CBS conditions and excludes surrounding story instructions', async () => {
  const { store, chat } = fixture();
  const source = completedSource(store, chat.id);
  const snapshot = store.run(source.runId).snapshot;
  const pkg = snapshot.profile!.packages!.find((entry) => entry.nativeRisu)!;
  const native = pkg.nativeRisu!;
  native.card.character_book = { entries: [] };
  native.card.post_history_instructions = [
    '{{#if {{equal::{{getvar::young}}::0}}}}',
    'C. Image Tag Insertion',
    'Use <img="Mira_adult"> only for the adult route.',
    'D. Narrative',
    'Keep adult narration in the story prompt.',
    '{{/if}}',
    '{{#if {{equal::{{getvar::young}}::1}}}}',
    'C. Image Tag Insertion',
    'Use <img="Mira_young"> only for the younger route.',
    'D. Narrative',
    'Keep younger narration in the story prompt.',
    '{{/if}}',
  ].join('\n');
  pkg.imageHandoff = detectRisuImageHandoff(native);
  expect(pkg.imageHandoff!.ranges).toHaveLength(2);
  snapshot.profile!.variableState = {
    revision: 1,
    values: { young: '0' },
  };
  const adult = await nativeImageGuidance(snapshot);
  expect(adult).toContain('Mira_adult');
  expect(adult).not.toContain('Mira_young');
  expect(adult).not.toContain('narration');
  snapshot.profile!.variableState!.values.young = '1';
  const young = await nativeImageGuidance(snapshot);
  expect(young).toContain('Mira_young');
  expect(young).not.toContain('Mira_adult');
  expect(young).not.toContain('narration');
});
