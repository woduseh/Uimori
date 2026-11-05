import { countTextTokens } from '../core/text-tokens.js';
import { ILLUSTRATION_EXCERPT_TOKENS, ILLUSTRATION_PROMPT_FIELDS } from '../core/illustration.js';
import { afterEach, expect, test } from 'vitest';
import { splitSource } from '../core/auxiliary.js';
import {
  parseStoryboard,
  parseIllustrationPlacement,
  storyboardRequest,
  illustrationPlacementRequest,
  illustrationTargetText,
} from '../core/illustration-storyboard.js';
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
import { placeIllustrationCuts } from '../server/helper-illustration-placement.js';
import {
  inspectIllustrationCut,
  readIllustrationScene,
  listIllustrationCuts,
  reviseFailedIllustrationCut,
  deleteIllustrationCut,
} from '../server/helper-illustration-cuts.js';
import { generateHelperIllustrations } from '../server/helper-illustration-generation.js';
import {
  fixtureSettings,
  chatWithSource,
  illustrationDatabases,
  completedSource,
} from './fixtures/illustration.js';
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
  expect(parseStoryboard(JSON.stringify(valid), blocks, 4, 'comfyui', false).targets).toHaveLength(
    2
  );
  expect(() =>
    parseStoryboard(
      JSON.stringify({ ...valid, targets: [targets[0], targets[0]] }),
      blocks,
      4,
      'comfyui',
      false
    )
  ).toThrow('ILLUSTRATION_STORYBOARD_INVALID');
  expect(() => parseStoryboard(JSON.stringify(valid), blocks, 1, 'comfyui', false)).toThrow(
    'ILLUSTRATION_STORYBOARD_INVALID'
  );
  expect(() =>
    parseStoryboard(JSON.stringify(valid), blocks, 4, 'comfyui', false, [targets[0]])
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

test('a chapter request reserves all exact moments atomically and renders them from the frozen selection', async () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const next = completedSource(store, chat.id, 'A door opens.\n\nThe light goes out.');
  settings(store);
  const moments = [source, next].flatMap((scene) =>
    splitSource(scene)
      .map(({ anchor, text }) => ({
        sourceId: scene.id,
        expectedSourceHash: scene.hash,
        startAnchor: anchor,
        endAnchor: anchor,
        focus: text,
        direction: 'In silhouette',
      }))
      .reverse()
  );
  const generate = (cuts: typeof moments) =>
    generateHelperIllustrations(store, chat.id, { moments: cuts }, { testMode: true });
  expect(() => generate([...moments, moments[3]])).toThrow('ILLUSTRATION_TARGET_CONFLICT');
  expect(() => generate([moments[0], { ...moments[3], startAnchor: 'missing' }])).toThrow(
    'ILLUSTRATION_TARGET_UNAVAILABLE'
  );
  expect(() =>
    generate([moments[0], { ...moments[3], expectedSourceHash: '0'.repeat(64) }])
  ).toThrow('ILLUSTRATION_SOURCE_CHANGED');
  expect(queuedIllustrations(store)).toEqual([]);
  const reserved = generate(moments);
  expect(reserved.plans.map((plan) => plan.count)).toEqual([2, 2]);
  expect(reserved.plans.flatMap((plan) => plan.jobIds)).toHaveLength(4);
  expect(queuedIllustrations(store)).toHaveLength(4);
  expect(
    illustrationsForSources(store, [source.id, next.id]).every((job) => job.task === 'render')
  ).toBe(true);
  for (const plan of reserved.plans) {
    const selected = moments.filter((moment) => moment.sourceId === plan.sourceId);
    const jobs = plan.jobIds.map((id) => illustrationJob(store, id));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.input.target!.endAnchor)).toEqual(
      selected.map((item) => item.endAnchor).reverse()
    );
    for (const cut of jobs) {
      const fixed = selected.find((item) => item.endAnchor === cut.input.target!.endAnchor)!;
      expect(cut.input).not.toHaveProperty('plan');
      expect(cut.input.target).toMatchObject({
        startAnchor: fixed.startAnchor,
        focus: fixed.focus,
        visualBrief: fixed.direction,
      });
      expect((await runIllustrationJob(store, cut.id, 'worker', hooks(store)))?.status).toBe(
        'completed'
      );
    }
  }
  expect(() => generate([moments[0]])).toThrow('ILLUSTRATION_TARGET_CONFLICT');
});

test('failed image-less cuts can be revised with guards, then removed without touching siblings', async () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  settings(store);
  const blocks = splitSource(source);
  const first = generateHelperIllustrations(
    store,
    chat.id,
    {
      moments: [
        {
          sourceId: source.id,
          expectedSourceHash: source.hash,
          startAnchor: blocks[0].anchor,
          endAnchor: blocks[0].anchor,
          focus: 'The lantern',
        },
      ],
    },
    { testMode: true }
  );
  const failedId = first.plans[0].jobId;
  cancelIllustration(store, failedId);
  const listing = listIllustrationCuts(store, chat.id, { sourceId: source.id });
  const cut = listing.cuts[0];
  expect(cut).toMatchObject({
    latestJobId: failedId,
    status: 'cancelled',
    displayedJobId: null,
    images: [],
  });
  const guards = {
    targetId: cut.targetId,
    expectedLatestJobId: failedId,
    expectedSourceHash: source.hash,
    expectedPresentationRevision: cut.presentationRevision,
  };
  expect(() =>
    reviseFailedIllustrationCut(store, chat.id, { ...guards, endAnchor: 'not-an-anchor' }, true)
  ).toThrow('ILLUSTRATION_TARGET_UNAVAILABLE');
  expect(illustrationPresentation(store, source.id)!.revision).toBe(cut.presentationRevision);
  const next = reviseFailedIllustrationCut(
    store,
    chat.id,
    {
      ...guards,
      startAnchor: blocks[1].anchor,
      endAnchor: blocks[1].anchor,
      focus: 'Mira waits on the pier',
      visualBrief: 'A calm portrait at the pier',
    },
    true
  );
  const replacement = illustrationJob(store, next.jobId);
  expect(replacement.input.target).toMatchObject({
    id: cut.targetId,
    startAnchor: blocks[1].anchor,
    endAnchor: blocks[1].anchor,
    focus: 'Mira waits on the pier',
    visualBrief: 'A calm portrait at the pier',
  });
  expect(illustrationJob(store, failedId).status).toBe('cancelled');
  expect(() => reviseFailedIllustrationCut(store, chat.id, guards, true)).toThrow(
    'ILLUSTRATION_PRESENTATION_CHANGED'
  );
  const current = listIllustrationCuts(store, chat.id, { sourceId: source.id }).cuts[0];
  const deletion = {
    expectedLatestJobId: next.jobId,
    expectedSourceHash: source.hash,
    expectedPresentationRevision: current.presentationRevision,
  };
  expect(() => deleteIllustrationCut(store, chat.id, deletion)).toThrow('ILLUSTRATION_ACTIVE');
  cancelIllustration(store, next.jobId);
  expect(deleteIllustrationCut(store, chat.id, deletion)).toMatchObject({
    deleted: true,
    targetId: cut.targetId,
  });
  expect(listIllustrationCuts(store, chat.id, { sourceId: source.id }).cuts).toEqual([]);
  expect(illustrationSlots(store, source.id).total).toBe(0);
});

test('obsolete failed cuts remain removable after their manuscript was edited', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  settings(store);
  const anchor = splitSource(source)[0].anchor;
  const result = generateHelperIllustrations(
    store,
    chat.id,
    {
      moments: [
        {
          sourceId: source.id,
          expectedSourceHash: source.hash,
          startAnchor: anchor,
          endAnchor: anchor,
          focus: 'The lantern',
        },
      ],
    },
    { testMode: true }
  );
  const jobId = result.plans[0].jobId;
  cancelIllustration(store, jobId);
  const changed = store.editSource(source.id, {
    text: 'The same evening, seen from the opposite pier.',
    expectedRevision: 0,
  });
  const cut = listIllustrationCuts(store, chat.id, { sourceId: changed.id }).cuts[0];
  expect(cut.stale).toBe(true);
  expect(
    deleteIllustrationCut(store, chat.id, {
      expectedLatestJobId: jobId,
      expectedSourceHash: changed.hash,
      expectedPresentationRevision: cut.presentationRevision,
    })
  ).toMatchObject({ deleted: true });
  expect(listIllustrationCuts(store, chat.id, { sourceId: changed.id }).cuts).toEqual([]);
});

test('illustration scene reads can center on an exact anchor without guessing its offset', () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const blocks = splitSource(source);
  const page = readIllustrationScene(store, chat.id, {
    sourceId: source.id,
    expectedSourceHash: source.hash,
    anchor: blocks[1].anchor,
    limit: 1,
  });
  expect(page.blocks.map((block) => block.anchor)).toEqual([blocks[1].anchor]);
  expect(page.offset).toBe(1);
  expect(() =>
    readIllustrationScene(store, chat.id, { sourceId: source.id, anchor: 'invalid' })
  ).toThrow('ILLUSTRATION_ANCHOR_NOT_FOUND');
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

test('placing a cut after an edit keeps original images and job evidence through redraw, copy and deletion', async () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  settings(store);
  const plan = reserveIllustrationPlan(store, source, 'manual', { testMode: true, maxTargets: 2 });
  await runIllustrationJob(store, plan.id, 'planner', hooks(store));
  const jobs = queuedIllustrations(store);
  for (const id of jobs) await runIllustrationJob(store, id, 'renderer', hooks(store));
  const original = illustrationJob(store, jobs[0]);
  const picture = illustrationsForSources(store, [source.id]).find(
    (job) => job.id === original.id
  )!;
  const revision = illustrationPresentation(store, source.id)!.revision;
  const edited = store.editSource(source.id, {
    text: 'A closed door.\n\nMira lights the lantern on the pier.',
    expectedRevision: 0,
  });
  const anchor = splitSource(edited)[1].anchor;
  const move = {
    jobId: original.id,
    expectedSourceHash: edited.hash,
    expectedPresentationRevision: revision,
    startAnchor: anchor,
    endAnchor: anchor,
    focus: 'Mira on the pier',
    visualBrief: 'The silver lantern.',
  };
  expect(() =>
    placeIllustrationCuts(store, chat.id, {
      placements: [move, { ...move, jobId: jobs[1], endAnchor: 'unknown' }],
    })
  ).toThrow();
  expect(illustrationPresentation(store, source.id)!.sourceHash).toBe(source.hash);
  const result = placeIllustrationCuts(store, chat.id, { placements: [move] });
  expect(result.placements[0]).toMatchObject({ revision: revision + 1, changed: true });
  expect(() => placeIllustrationCuts(store, chat.id, { placements: [move] })).toThrow(
    'ILLUSTRATION_PRESENTATION_CHANGED'
  );
  expect(
    placeIllustrationCuts(store, chat.id, {
      placements: [{ ...move, expectedPresentationRevision: revision + 1 }],
    }).changed
  ).toBe(false);
  expect(illustrationJob(store, original.id)).toEqual(original);
  expect(queuedIllustrations(store)).toEqual([]);
  expect(illustrationSlots(store, source.id)).toEqual({ active: 0, total: 1 });
  const cuts = illustrationsForSources(store, [source.id]);
  expect(cuts.find((job) => job.id === original.id)).toMatchObject({
    sourceHash: edited.hash,
    generatedSourceHash: source.hash,
    target: { endAnchor: anchor },
    images: picture.images,
  });
  expect(cuts.find((job) => job.id === jobs[1])!.sourceHash).toBe(source.hash);
  const copy = captureChatCopy(store, chat.id);
  const restored = restoreChatCopy(store, copy, 'reanchored');
  const restoredSource = store.source(restored.headRevision!);
  const restoredCut = illustrationsForSources(store, [restoredSource.id]).find((job) => job.target);
  expect(restoredCut?.target?.endAnchor).toBe(splitSource(restoredSource)[1].anchor);
  expect(restoredCut?.images[0].hash).toBe(picture.images[0].hash);
  const redo = regenerateIllustration(store, original.id, true);
  expect(redo.input.target).toMatchObject({
    endAnchor: anchor,
    focus: 'Mira on the pier',
    visualBrief: 'The silver lantern.',
  });
  expect(redo.sourceHash).toBe(edited.hash);
  expect(() =>
    placeIllustrationCuts(store, chat.id, {
      placements: [
        {
          ...move,
          expectedPresentationRevision: illustrationPresentation(store, source.id)!.revision,
        },
      ],
    })
  ).toThrow('ILLUSTRATION_ACTIVE');
  await runIllustrationJob(store, redo.id, 'redraw', hooks(store));
  removeIllustration(store, redo.id);
  expect(illustrationSlots(store, source.id).total).toBe(0);
  expect(
    illustrationsForSources(store, [source.id])
      .filter((job) => job.task === 'render')
      .map((job) => job.id)
  ).toEqual([jobs[1]]);
});

test.each(['move', 'plan'])(
  'revising a %s layout keeps other stale cuts and their authored moments portable',
  async (flow) => {
    const store = databases.create();
    const { chat, source } = chatWithSource(store);
    settings(store);
    const first = reserveIllustrationPlan(store, source, 'manual', {
      testMode: true,
      maxTargets: 2,
    });
    await runIllustrationJob(store, first.id, 'planner', hooks(store));
    const ids = queuedIllustrations(store);
    for (const id of ids) await runIllustrationJob(store, id, 'render', hooks(store));
    const v2 = store.editSource(source.id, {
      text: 'At the shore.\n\nAt the gate.',
      expectedRevision: 0,
    });
    const note = (index: number) => ({
      focus: `Chosen focus ${index}`,
      visualBrief: `Chosen brief ${index}`,
    });
    const position = (id: string, scene: typeof source, index: number, revision: number) => ({
      jobId: id,
      expectedSourceHash: scene.hash,
      expectedPresentationRevision: revision,
      startAnchor: splitSource(scene)[index].anchor,
      endAnchor: splitSource(scene)[index].anchor,
    });
    const before = illustrationPresentation(store, source.id)!.revision;
    placeIllustrationCuts(store, chat.id, {
      placements: ids.map((id, i) => ({ ...position(id, v2, i, before), ...note(i) })),
    });
    const v3 = store.editSource(source.id, {
      text: 'Shoreline.\n\nGatehouse.\n\nDoorway.',
      expectedRevision: 1,
    });
    if (flow === 'move') {
      placeIllustrationCuts(store, chat.id, { placements: [position(ids[0], v3, 0, before + 1)] });
    } else {
      const extra = reserveIllustrationPlan(store, v3, 'manual', { testMode: true, maxTargets: 1 });
      await runIllustrationJob(store, extra.id, 'planner', hooks(store));
      for (const id of queuedIllustrations(store))
        await runIllustrationJob(store, id, 'render', hooks(store));
    }
    const other = illustrationsForSources(store, [source.id]).find((item) => item.id === ids[1])!;
    expect(other).toMatchObject({ sourceHash: v2.hash, target: { focus: note(1).focus } });
    const frozen = illustrationJob(store, ids[1]).input.target!;
    expect(inspectIllustrationCut(store, chat.id, { imageId: other.images[0].id })).toMatchObject({
      sourceHash: v2.hash,
      currentSourceHash: v3.hash,
      generatedSourceHash: source.hash,
      target: note(1),
      generatedFocus: frozen.focus,
      generatedVisualBrief: frozen.visualBrief,
    });
    expect(illustrationSlots(store, source.id).total).toBe(1);
    const copy = captureChatCopy(store, chat.id);
    const stale = copy.illustrations.find((item) => item.group === ids[1])!;
    expect(stale).toMatchObject({ stale: true, sourceHash: v2.hash, unplacedMoment: note(1) });
    const fork = restoreChatCopy(store, copy, 'detached');
    const forkSource = store.source(fork.headRevision!);
    const restored = illustrationsForSources(store, [forkSource.id]).find(
      (item) => item.unplacedMoment?.focus === note(1).focus
    )!;
    expect(restored.sourceHash).toBe(v2.hash);
    expect(
      inspectIllustrationCut(store, fork.id, { imageId: restored.images[0].id })
    ).toMatchObject({
      unplacedMoment: note(1),
      target: null,
      generatedSourceHash: null,
      generatedFocus: null,
      generatedVisualBrief: null,
    });
    expect(illustrationSlots(store, forkSource.id).total).toBe(1);
    const reverted = store.editSource(forkSource.id, { text: v2.text, expectedRevision: 0 });
    expect(reverted.hash).toBe(v2.hash);
    expect(illustrationSlots(store, forkSource.id).total).toBe(0);
    expect(() => regenerateIllustration(store, restored.id, true)).toThrow(
      'ILLUSTRATION_TARGET_UNAVAILABLE'
    );
    expect(
      captureChatCopy(store, fork.id).illustrations.find((item) => item.group === restored.id)
    ).toMatchObject({ stale: true, unplacedMoment: note(1) });
    placeIllustrationCuts(store, fork.id, {
      placements: [
        position(
          restored.id,
          reverted,
          1,
          illustrationPresentation(store, forkSource.id)!.revision
        ),
      ],
    });
    expect(
      illustrationPresentation(store, forkSource.id)!.targets[restored.id].placedTarget
    ).toMatchObject(note(1));
    expect(regenerateIllustration(store, restored.id, true).input.target).toMatchObject({
      ...note(1),
      endAnchor: splitSource(reverted)[1].anchor,
    });
    placeIllustrationCuts(store, chat.id, {
      placements: [position(ids[1], v3, 1, illustrationPresentation(store, source.id)!.revision)],
    });
    expect(
      illustrationPresentation(store, source.id)!.targets[other.target!.id].placedTarget
    ).toMatchObject(note(1));
    if (flow === 'plan') {
      removeIllustration(store, ids[0]);
      expect(Object.keys(illustrationPresentation(store, source.id)!.detached ?? {})).toHaveLength(
        0
      );
    }
  }
);

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

for (const flow of [
  'original-only',
  'illustration-first',
  'translation-first',
  'translation-edit',
]) {
  test(`illustration positions survive ${flow} without regenerating pictures`, async () => {
    const store = databases.create();
    const { source } = chatWithSource(store);
    settings(store);
    const translate = (text: string) =>
      store.editTranslation(source.id, {
        expectedRevision: store.source(source.id).translationRevision ?? 0,
        expectedSourceHash: source.hash,
        text,
      });
    if (flow === 'translation-first' || flow === 'translation-edit')
      translate('강 위에 등불.\n\n부두에 미라.');
    const plan = reserveIllustrationPlan(store, source, 'manual', {
      testMode: true,
      maxTargets: 2,
    });
    await runIllustrationJob(store, plan.id, 'worker', hooks(store));
    const finish = async () => {
      for (const id of queuedIllustrations(store))
        await runIllustrationJob(store, id, 'worker', hooks(store));
    };
    await finish();
    const pictures = () =>
      illustrationsForSources(store, [source.id]).flatMap((job) =>
        job.images.map((image) => image.id)
      );
    const before = pictures();
    if (flow === 'illustration-first') translate('강 위에 등불.\n\n부두에 미라.');
    if (flow === 'translation-edit')
      translate('강 위로 흔들리는 등불.\n\n미라는 조용한 부두에서 기다렸다.');
    await finish();
    expect(pictures()).toEqual(before);
    const cuts = illustrationsForSources(store, [source.id]).filter((job) => job.task === 'render');
    expect(
      cuts.every((job) => source.blocks!.some((block) => block.anchor === job.target?.endAnchor))
    ).toBe(true);
    if (flow === 'original-only')
      expect(illustrationPresentation(store, source.id)?.translation).toBeUndefined();
    else
      expect(
        Object.values(illustrationPresentation(store, source.id)!.translation!.afterByTarget).every(
          Boolean
        )
      ).toBe(true);
  });
}

test('explicit remapping replaces a cached null, deduplicates active work and never renders again', async () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  settings(store);
  const plan = reserveIllustrationPlan(store, source, 'manual', { testMode: true, maxTargets: 2 });
  await runIllustrationJob(store, plan.id, 'worker', hooks(store));
  for (const id of queuedIllustrations(store))
    await runIllustrationJob(store, id, 'worker', hooks(store));
  store.editTranslation(source.id, {
    expectedRevision: 0,
    expectedSourceHash: source.hash,
    text: '등불이 흔들렸다.\n\n미라가 기다렸다.',
  });
  const placement = claimIllustration(store, queuedIllustrations(store)[0], 'worker')!;
  const nulls = Object.fromEntries(
    placement.job.input.placement!.targets.map((target) => [target.id, null])
  );
  completeIllustrationPlacement(store, placement.job, 'worker', nulls, {
    ...diagnostic(),
    stage: 'placement',
  });
  expect(scheduleIllustrationPlacement(store, source.id)).toBeNull();
  const pictures = illustrationsForSources(store, [source.id]).flatMap((item) => item.images);
  const retry = scheduleIllustrationPlacement(store, source.id, true)!;
  expect(retry.input.task).toBe('placement');
  expect(scheduleIllustrationPlacement(store, source.id, true)?.id).toBe(retry.id);
  expect(queuedIllustrations(store)).toEqual([retry.id]);
  await runIllustrationJob(store, retry.id, 'worker', hooks(store));
  expect(
    Object.values(illustrationPresentation(store, source.id)!.translation!.afterByTarget).every(
      Boolean
    )
  ).toBe(true);
  expect(illustrationsForSources(store, [source.id]).flatMap((item) => item.images)).toEqual(
    pictures
  );
});

test('compact wire aliases preserve every source paragraph and round-trip to canonical anchors', () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const connection = store.product.connection({
    title: 'Synthetic',
    protocol: 'codex-app-server-v1',
    endpoint: 'codex://local',
    enabled: true,
  });
  const selected = store.product.model({
    title: 'Planner',
    connectionId: connection.id,
    modelId: 'synthetic',
    maxOutputTokens: 1024,
    temperature: null,
  });
  const model = store.product.modelSnapshot(selected.id, 'illustration');
  const scene = {
    text: source.text,
    bot: null,
    persona: null,
    styleGuidance: 'ink',
    negativeGuidance: 'Comfy-only',
    allowSkip: false,
  };
  const blocks = splitSource(source);
  const request = storyboardRequest(
    model,
    scene,
    source,
    { maxTargets: 2, existingTargets: [], generator: 'codex', promptMode: 'none' },
    undefined
  );
  const input = request.input.source as { blocks: [string, string][] };
  expect(input.blocks).toEqual(
    blocks.map((block, index) => [`s${index.toString(36)}`, block.text])
  );
  expect(JSON.stringify(request)).not.toContain(blocks[0].anchor);
  expect(request.stable.contract).not.toContain(ILLUSTRATION_PROMPT_FIELDS);
  expect(request.input.source).not.toHaveProperty('negativeGuidance');
  const result = parseStoryboard(
    JSON.stringify({
      heroIndex: 0,
      targets: [
        { startAnchor: 's0', endAnchor: 's1', focus: 'A lantern', visualBrief: 'Mira on the pier' },
      ],
    }),
    blocks,
    2,
    'none',
    false
  );
  expect(result.targets[0]).toMatchObject({
    startAnchor: blocks[0].anchor,
    endAnchor: blocks[1].anchor,
  });
  const fixed = [
    {
      startAnchor: blocks[0].anchor,
      endAnchor: blocks[1].anchor,
      focus: 'Mira lowers the lantern',
      direction: 'Low angle',
    },
  ];
  const exact = storyboardRequest(
    model,
    scene,
    source,
    {
      maxTargets: 1,
      existingTargets: [],
      selectedMoments: fixed,
      generator: 'codex',
      promptMode: 'codex',
    },
    undefined
  );
  expect(exact.input.source).toMatchObject({
    selectedMoments: [
      {
        id: 'm0',
        startAnchor: 's0',
        endAnchor: 's1',
        focus: fixed[0].focus,
        direction: 'Low angle',
      },
    ],
  });
  const draft = {
    id: 'm0',
    startAnchor: 's1',
    endAnchor: 's1',
    focus: 'A different instant',
    visualBrief: 'Mira in profile',
    prompt: { prompt: '  Mira holds a lantern. ', caption: 'A lantern' },
  };
  const parse = (targets: unknown[]) =>
    parseStoryboard(
      JSON.stringify({ heroIndex: 0, targets }),
      blocks,
      1,
      'codex',
      false,
      [],
      fixed
    );
  expect(parse([draft]).targets).toMatchObject([
    {
      startAnchor: fixed[0].startAnchor,
      endAnchor: fixed[0].endAnchor,
      focus: fixed[0].focus,
      prompt: { prompt: draft.prompt.prompt },
    },
  ]);
  expect(() => parse([])).toThrow('ILLUSTRATION_STORYBOARD_INVALID');
  expect(() => parse([{ ...draft, id: 'wrong' }])).toThrow('ILLUSTRATION_STORYBOARD_INVALID');
  const both = blocks.map(({ anchor, text }) => ({
    startAnchor: anchor,
    endAnchor: anchor,
    focus: text,
  }));
  const reordered = parseStoryboard(
    JSON.stringify({
      heroIndex: 0,
      targets: [{ ...draft, id: 'm1', visualBrief: 'second' }, draft],
    }),
    blocks,
    2,
    'codex',
    false,
    [],
    both
  );
  expect(reordered.heroIndex).toBe(1);
  expect(reordered.targets.map(({ focus, visualBrief }) => [focus, visualBrief])).toEqual([
    [both[0].focus, draft.visualBrief],
    [both[1].focus, 'second'],
  ]);
  const target = { ...result.targets[0], id: 'target-uuid' };
  const placement = {
    target: {
      mode: 'translation' as const,
      textHash: source.hash,
      translationJobId: 'translation-id',
      translationRevision: 1,
    },
    targetSetHash: 'a'.repeat(64),
    targets: [target],
  };
  const alignment = illustrationPlacementRequest(
    model,
    scene,
    source,
    source,
    placement,
    undefined
  );
  expect(alignment.input.source).toMatchObject({
    targets: [{ id: 'i0' }],
    translationBlocks: blocks.map((block, index) => [`t${index.toString(36)}`, block.text]),
  });
  expect(parseIllustrationPlacement('{"afterByTarget":{"i0":"t1"}}', [target.id], blocks)).toEqual({
    [target.id]: blocks[1].anchor,
  });
  expect(parseIllustrationPlacement('{"afterByTarget":{"i0":null}}', [target.id], blocks)).toEqual({
    [target.id]: null,
  });
  expect(() =>
    parseIllustrationPlacement('{"afterByTarget":{"i0":"t999"}}', [target.id], blocks)
  ).toThrow();
  expect(() =>
    parseIllustrationPlacement(
      '{"afterByTarget":{"i0":"t1","target-uuid":"t0"}}',
      [target.id],
      blocks
    )
  ).toThrow();
  expect(store.source(source.id)).toEqual(source);
});

test('a wide render target retains its brief and final event while bounding only the repeated source excerpt', () => {
  const store = databases.create();
  const { chat } = chatWithSource(store);
  const source = completedSource(
    store,
    chat.id,
    'Distant scenery. '.repeat(10000) + '\n\nThe lantern rises.'
  );
  const blocks = splitSource(source);
  const target = {
    startAnchor: blocks[0].anchor,
    endAnchor: blocks[1].anchor,
    focus: 'The lantern rises',
    visualBrief: 'Mira, silver hair, blue coat, raising a lantern on the pier.',
  };
  const input = JSON.parse(illustrationTargetText(source, target));
  expect(input.focus).toBe(target.focus);
  expect(input.visualBrief).toBe(target.visualBrief);
  expect(input.excerpt).toMatch(/^\[Earlier text omitted\]/);
  expect(input.excerpt.endsWith('The lantern rises.')).toBe(true);
  expect(countTextTokens(input.excerpt)).toBeLessThanOrEqual(ILLUSTRATION_EXCERPT_TOKENS.target);
  expect(store.source(source.id).text).toBe(source.text);
});
