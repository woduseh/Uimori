import { afterEach, expect, test } from 'vitest';
import sharp from 'sharp';
import {
  inspectIllustrationCut,
  listIllustrationCuts,
  readIllustrationCutImage,
  readIllustrationScene,
  redrawIllustrationCut,
  resolveIllustrationCutImage,
} from '../server/helper-illustration-cuts.js';
import {
  claimIllustration,
  completeIllustration,
  completeIllustrationStoryboard,
  illustrationJob,
  queuedIllustrations,
  reserveIllustrationPlan,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import {
  chatWithSource,
  completedSource,
  fixtureSettings,
  illustrationDatabases,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('helper-illustration-cuts-');
afterEach(() => databases.cleanup());

test('source pages expose the same original anchors for focused generation and relocation', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const next = completedSource(store, chat.id);
  const other = chatWithSource(store);
  const first = readIllustrationScene(store, chat.id, {
    sourceId: source.id,
    limit: 1,
    maxBlockChars: 5,
  });
  expect(first.blocks).toMatchObject([{ index: 0, text: 'A lan', textTruncated: true }]);
  const rest = readIllustrationScene(store, chat.id, {
    sourceId: source.id,
    expectedSourceHash: first.sourceHash,
    offset: first.nextOffset!,
  });
  expect(rest.blocks[0].anchor).not.toEqual(first.blocks[0].anchor);
  expect(rest.blocks[0].text).toBe(source.text.slice(rest.blocks[0].start, rest.blocks[0].end));
  expect(rest.nextOffset).toBeNull();
  expect(() =>
    readIllustrationScene(store, chat.id, { sourceId: next.id, expectedSourceHash: 'stale' })
  ).toThrow('ILLUSTRATION_SOURCE_CHANGED');
  expect(() => readIllustrationScene(store, other.chat.id, { sourceId: source.id })).toThrow();
});

test('cut pages follow scene order, with the hero before cuts in original paragraph order', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const later = completedSource(store, chat.id, 'The ship sailed off.');
  for (const scene of [later, source]) {
    const blocks = readIllustrationScene(store, chat.id, { sourceId: scene.id }).blocks;
    const plan = reserveIllustrationPlan(store, scene, 'manual', {
      settings: fixtureSettings(),
      testMode: true,
      maxTargets: blocks.length,
    });
    const claimed = claimIllustration(store, plan.id, 'worker')!;
    completeIllustrationStoryboard(
      store,
      claimed.job,
      'worker',
      {
        heroIndex: blocks.length - 1,
        targets: blocks.map(({ anchor, text }) => ({
          startAnchor: anchor,
          endAnchor: anchor,
          focus: text,
          visualBrief: text,
        })),
      },
      { stage: 'planning', attempts: [], retries: [] }
    );
  }
  const first = listIllustrationCuts(store, chat.id, { limit: 1 });
  expect(first).toMatchObject({
    total: 3,
    nextOffset: 1,
    cuts: [{ sourceId: source.id, hero: true, focus: 'Mira waited on the pier.' }],
  });
  const rest = listIllustrationCuts(store, chat.id, { offset: first.nextOffset! });
  expect(rest.cuts.map((cut) => cut.sourceId)).toEqual([source.id, later.id]);
  expect(rest.nextOffset).toBeNull();
});

test('inspection addresses the chosen variation; redraw freezes its prompt and rejects stale or foreign requests', async () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const other = chatWithSource(store);
  const { revision, ...settings } = fixtureSettings();
  updateIllustrationSettings(store, { ...settings, expectedRevision: revision }, true);
  const scene = readIllustrationScene(store, chat.id, { sourceId: source.id });
  const plan = reserveIllustrationPlan(store, source, 'manual', { testMode: true });
  const claimed = claimIllustration(store, plan.id, 'worker')!;
  const anchor = scene.blocks[1].anchor;
  completeIllustrationStoryboard(
    store,
    claimed.job,
    'worker',
    {
      heroIndex: 0,
      targets: [
        {
          startAnchor: anchor,
          endAnchor: anchor,
          focus: 'a light',
          visualBrief: 'Mira at the pier',
        },
      ],
    },
    { stage: 'planning', attempts: [], retries: [] }
  );
  const cut = claimIllustration(store, queuedIllustrations(store)[0], 'worker')!;
  const images = await Promise.all(
    ['red', 'blue'].map(async (color) => ({
      mime: 'image/png' as const,
      bytes: await sharp({ create: { width: 16, height: 8, channels: 3, background: color } })
        .png()
        .toBuffer(),
      caption: color,
      prompt: `Draw a ${color} lantern`,
    }))
  );
  expect(
    completeIllustration(store, cut.job.id, cut.job.generation, 'worker', images, {
      stage: 'store',
      attempts: [],
      retries: [],
    })
  ).toBe(true);
  const list = listIllustrationCuts(store, chat.id, {});
  expect(list.cuts).toHaveLength(1);
  expect(list.cuts[0]).toMatchObject({
    displayedJobId: cut.job.id,
    hero: true,
    endAnchor: anchor,
    stale: false,
  });
  expect(list.cuts[0].images.map((image) => image.position)).toEqual([0, 1]);
  const imageId = list.cuts[0].images[1].imageId;
  const args = {
    imageId,
    expectedSourceHash: source.hash,
    expectedPresentationRevision: list.cuts[0].presentationRevision,
    changeRequest: 'Lower the lantern',
  };
  expect(() => resolveIllustrationCutImage(store, other.chat.id, imageId)).toThrow(
    'ILLUSTRATION_IMAGE_NOT_FOUND'
  );
  expect(
    inspectIllustrationCut(store, chat.id, { imageId, includeImage: false, includePrompt: true })
  ).toMatchObject({
    prompt: 'Draw a blue lantern',
    generatedFocus: 'a light',
    sourceHash: source.hash,
    caption: 'blue',
  });
  const read = await readIllustrationCutImage(store, chat.id, { imageId });
  const pixel = await sharp(Buffer.from(read.resolved.base64, 'base64')).raw().toBuffer();
  expect(pixel[2]).toBeGreaterThan(230);
  expect(pixel[0]).toBeLessThan(25);
  expect(() =>
    redrawIllustrationCut(store, chat.id, { ...args, expectedPresentationRevision: 0 }, true)
  ).toThrow('ILLUSTRATION_CUT_CHANGED');
  const result = redrawIllustrationCut(store, chat.id, args, true);
  expect(illustrationJob(store, result.jobId).input.redraw).toMatchObject({
    changeRequest: 'Lower the lantern',
    originalPrompt: { prompt: 'Draw a blue lantern', caption: 'blue' },
  });
  expect(listIllustrationCuts(store, chat.id, { sourceId: source.id }).cuts[0]).toMatchObject({
    latestJobId: result.jobId,
    displayedJobId: cut.job.id,
  });
  expect(() => redrawIllustrationCut(store, chat.id, args, true)).toThrow(
    'ILLUSTRATION_CUT_CHANGED'
  );
});
