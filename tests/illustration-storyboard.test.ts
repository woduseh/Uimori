import { afterEach, expect, test } from 'vitest';
import { splitSource } from '../core/auxiliary.js';
import { parseStoryboard, parseIllustrationPlacement } from '../core/illustration-storyboard.js';
import { runIllustrationJob, type IllustrationRunnerHooks } from '../server/illustration-runner.js';
import {
  reserveIllustrationPlan,
  claimIllustration,
  completeIllustrationStoryboard,
  illustrationJob,
  illustrationsForSources,
  queuedIllustrations,
  illustrationSlots,
  regenerateIllustration,
  cancelIllustration,
  retryIllustration,
  updateIllustrationSettings,
  scheduleIllustrationPlacement,
  completeIllustrationPlacement,
  removeIllustration,
} from '../server/illustrations.js';
import {
  illustrationPresentation,
  changeIllustrationHero,
} from '../server/illustration-presentation.js';
import { captureChatCopy, restoreChatCopy } from '../server/chat-copy.js';
import { fixtureSettings, chatWithSource, illustrationDatabases } from './fixtures/illustration.js';
import type { Store } from '../server/store.js';

const databases = illustrationDatabases('uimori-storyboard-');
afterEach(() => databases.cleanup());
const hooks = (store: Store): IllustrationRunnerHooks => ({
  signal: new AbortController().signal,
  allowFixture: true,
  authorize: (connection) => connection,
  onAttemptStart: (wire) => store.product.startAttempt('', null, null, wire),
  onAttemptFinish: (id, result) => store.product.finishAttempt(id, result),
});
const diagnostic = () => ({ stage: 'planning' as const, attempts: [], retries: [] });
function settings(store: Store) {
  const { revision, ...body } = fixtureSettings({ maxPerSource: 3, maxAutoRetries: 0 });
  updateIllustrationSettings(store, { expectedRevision: revision, ...body }, true);
}

test('storyboard requires distinct real moments, preserves narrative order and accepts uncertain translation positions', () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const blocks = splitSource(source);
  const targets = blocks.map((block) => ({
    startAnchor: block.anchor,
    endAnchor: block.anchor,
    focus: block.text,
    visualBrief: block.text,
    prompt: { prompt: block.text, negativePrompt: '', caption: '장면' },
  }));
  const valid = { heroIndex: 1, targets };
  expect(parseStoryboard(JSON.stringify(valid), blocks, 4, true, false).targets).toHaveLength(2);
  expect(() =>
    parseStoryboard(
      JSON.stringify({ ...valid, targets: [targets[0], targets[0]] }),
      blocks,
      4,
      true,
      false
    )
  ).toThrow('ILLUSTRATION_STORYBOARD_INVALID');
  expect(() => parseStoryboard(JSON.stringify(valid), blocks, 1, true, false)).toThrow(
    'ILLUSTRATION_STORYBOARD_INVALID'
  );
  expect(() =>
    parseStoryboard(JSON.stringify(valid), blocks, 4, true, false, [targets[0]])
  ).toThrow('ILLUSTRATION_STORYBOARD_INVALID');
  expect(
    parseIllustrationPlacement(
      JSON.stringify({ afterByTarget: { first: blocks[1].anchor, second: null } }),
      ['first', 'second'],
      blocks
    )
  ).toEqual({ first: blocks[1].anchor, second: null });
  expect(() =>
    parseIllustrationPlacement('{"afterByTarget":{"first":"missing"}}', ['first'], blocks)
  ).toThrow('ILLUSTRATION_PLACEMENT_INVALID');
});

test('planning atomically reserves cuts, prioritizes the hero and cannot fan out after cancellation', async () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  settings(store);
  const plan = reserveIllustrationPlan(store, source, 'manual', {
    testMode: true,
    maxTargets: 3,
    requestKey: 'one',
  });
  expect(illustrationSlots(store, source.id).total).toBe(3);
  expect(
    reserveIllustrationPlan(store, source, 'manual', {
      testMode: true,
      maxTargets: 3,
      requestKey: 'one',
    }).id
  ).toBe(plan.id);
  expect(() => reserveIllustrationPlan(store, source, 'manual', { testMode: true })).toThrow(
    'ILLUSTRATION_PLAN_ACTIVE'
  );
  await runIllustrationJob(store, plan.id, 'worker', hooks(store));
  const cuts = queuedIllustrations(store).map((id) => illustrationJob(store, id));
  expect(cuts).toHaveLength(2); // no forced quota for a two-moment scene
  expect(cuts[0].input.target?.endAnchor).toBe(splitSource(source)[1].anchor);
  expect(illustrationSlots(store, source.id).total).toBe(2);
  for (const cut of cuts) await runIllustrationJob(store, cut.id, 'worker', hooks(store));
  const another = reserveIllustrationPlan(store, source, 'manual', { testMode: true });
  const claimed = claimIllustration(store, another.id, 'late-worker')!;
  cancelIllustration(store, another.id);
  expect(
    completeIllustrationStoryboard(
      store,
      claimed.job,
      'late-worker',
      { heroIndex: null, targets: [] },
      diagnostic()
    )
  ).toBe(false);
  expect(queuedIllustrations(store)).toEqual([]);
  expect(illustrationSlots(store, source.id).total).toBe(2);
});

test('regeneration keeps the old picture, failed siblings are independent and copy restores groups and verified anchors', async () => {
  const store = databases.create();
  const { source, chat } = chatWithSource(store);
  settings(store);
  const plan = reserveIllustrationPlan(store, source, 'manual', { testMode: true, maxTargets: 2 });
  await runIllustrationJob(store, plan.id, 'worker', hooks(store));
  const cuts = queuedIllustrations(store);
  for (const id of cuts) await runIllustrationJob(store, id, 'worker', hooks(store));
  const original = illustrationJob(store, cuts[0]);
  const redo = regenerateIllustration(store, original.id, true);
  expect(
    illustrationPresentation(store, source.id)?.targets[original.input.target!.id].displayedJobId
  ).toBe(original.id);
  cancelIllustration(store, redo.id);
  expect(
    illustrationPresentation(store, source.id)?.targets[original.input.target!.id].displayedJobId
  ).toBe(original.id);
  retryIllustration(store, redo.id);
  await runIllustrationJob(store, redo.id, 'worker', hooks(store));
  const layout = illustrationPresentation(store, source.id)!;
  expect(layout.targets[original.input.target!.id].displayedJobId).toBe(redo.id);
  changeIllustrationHero(
    store,
    source.id,
    source.hash,
    layout.revision,
    illustrationJob(store, cuts[1]).input.target!.id
  );
  // One workflow can return multiple images of one target; portable copies keep that grouping.
  const image = store.db.prepare('SELECT * FROM illustration_images WHERE job_id=?').get(redo.id)!;
  store.db
    .prepare(
      'INSERT INTO illustration_images SELECT ?,job_id,chat_id,1,mime,hash,body,created_at FROM illustration_images WHERE id=?'
    )
    .run('second-variant', image.id);
  const copy = captureChatCopy(store, chat.id);
  expect(copy.illustrations).toHaveLength(3); // old replaced result is not exported
  const restored = restoreChatCopy(store, copy, 'portable-copy');
  const restoredSource = store.source(restored.headRevision!);
  const restoredCuts = illustrationsForSources(store, [restoredSource.id]);
  expect(restoredCuts).toHaveLength(2);
  expect(restoredCuts.map((cut) => cut.images.length).sort()).toEqual([1, 2]);
  expect(restoredCuts.filter((cut) => cut.display?.hero)).toHaveLength(1);
  for (const cut of restoredCuts) {
    expect(
      splitSource(restoredSource).some((block) => block.anchor === cut.target?.endAnchor)
    ).toBe(true);
    expect(splitSource(source).some((block) => block.anchor === cut.target?.endAnchor)).toBe(false);
  }
  expect(queuedIllustrations(store)).toEqual([]); // no imported generation replay
  removeIllustration(store, redo.id);
  expect(
    illustrationsForSources(store, [source.id]).filter(
      (cut) => cut.target?.id === original.input.target!.id
    )
  ).toEqual([]);
  expect(restoredCuts.flatMap((cut) => cut.images)).toHaveLength(3);
});

test('translation completion schedules once, keeps old mapping from overwriting a new translation and copies it without re-generation', async () => {
  const store = databases.create();
  const { source, chat } = chatWithSource(store);
  settings(store);
  const plan = reserveIllustrationPlan(store, source, 'manual', { testMode: true, maxTargets: 2 });
  await runIllustrationJob(store, plan.id, 'worker', hooks(store));
  for (const id of queuedIllustrations(store))
    await runIllustrationJob(store, id, 'worker', hooks(store));
  const translation = store.editTranslation(source.id, {
    expectedRevision: 0,
    expectedSourceHash: source.hash,
    text: '강 위로 등불이 흔들렸다.\n\n미라는 부두에서 기다렸다.',
  });
  scheduleIllustrationPlacement(store, source.id);
  const placements = queuedIllustrations(store);
  expect(placements).toHaveLength(1);
  const old = claimIllustration(store, placements[0], 'mapping-worker')!;
  const next = store.editTranslation(source.id, {
    expectedRevision: translation.revision!,
    expectedSourceHash: source.hash,
    text: '강에는 등불이, 부두에는 미라가 있었다.',
  });
  expect(
    completeIllustrationPlacement(
      store,
      old.job,
      'mapping-worker',
      {},
      { ...diagnostic(), stage: 'placement' }
    )
  ).toBe(true);
  expect(illustrationPresentation(store, source.id)?.translation).toBeUndefined();
  for (const id of queuedIllustrations(store))
    await runIllustrationJob(store, id, 'worker', hooks(store));
  const mapping = illustrationPresentation(store, source.id)!.translation!;
  expect(mapping.target.textHash).toBe(next.translationLayout!.textHash);
  expect(Object.values(mapping.afterByTarget)).toContain(null); // merged paragraph cannot be guessed by synthetic index
  const copy = captureChatCopy(store, chat.id);
  const restored = restoreChatCopy(store, copy, 'translated-copy');
  const restoredSource = store.source(restored.headRevision!);
  const saved = illustrationPresentation(store, restoredSource.id)?.translation;
  expect(saved?.target.textHash).toBe(mapping.target.textHash);
  expect(queuedIllustrations(store)).toEqual([]);
});
