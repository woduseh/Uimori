import { afterEach, expect, test } from 'vitest';
import { captureChatCopy, restoreChatCopy } from '../server/chat-copy.js';
import { deleteScenes, sceneDeletionImpact } from '../server/scene-deletion.js';
import {
  readIllustrationContinuity,
  saveIllustrationContinuity,
  sceneAppearanceNotes,
} from '../server/illustration-continuity.js';
import {
  illustrationJob,
  queuedIllustrations,
  regenerateIllustration,
  reserveIllustrationPlan,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import { runIllustrationJob, type IllustrationRunnerHooks } from '../server/illustration-runner.js';
import {
  chatWithSource,
  completedSource,
  fixtureSettings,
  illustrationDatabases,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-illustration-continuity-');
afterEach(() => databases.cleanup());

test('overlapping scene notes freeze on admission; later redraw sees only the latest applicable notes', async () => {
  const store = databases.create();
  const { chat, source: a } = chatWithSource(store);
  const b = completedSource(store, chat.id);
  const c = completedSource(store, chat.id);
  const { revision, ...settings } = fixtureSettings();
  updateIllustrationSettings(store, { expectedRevision: revision, ...settings }, true);
  const saved = saveIllustrationContinuity(store, chat.id, {
    expectedRevision: 0,
    edits: [
      { fromSourceId: a.id, toSourceId: b.id, text: 'Mira wears the red coat.' },
      { fromSourceId: b.id, text: 'Jun carries a compass.' },
    ],
  });
  const plan = reserveIllustrationPlan(store, b, 'manual', { testMode: true });
  expect(plan.input.sceneAppearanceNotes).toEqual([
    'Mira wears the red coat.',
    'Jun carries a compass.',
  ]);
  expect(sceneAppearanceNotes(store, chat.id, a.id)).toEqual(['Mira wears the red coat.']);
  expect(sceneAppearanceNotes(store, chat.id, c.id)).toEqual([]);
  saveIllustrationContinuity(store, chat.id, {
    expectedRevision: 1,
    edits: [
      { id: saved.notes[0].id, remove: true },
      { id: saved.notes[1].id, text: 'Jun pockets the compass.' },
    ],
  });
  const hooks: IllustrationRunnerHooks = {
    signal: new AbortController().signal,
    allowFixture: true,
    authorize: (connection) => connection,
    onAttemptStart: (wire) => store.product.startAttempt('', null, null, wire),
    onAttemptFinish: (id, result) => store.product.finishAttempt(id, result),
  };
  expect((await runIllustrationJob(store, plan.id, 'worker', hooks))?.status).toBe('completed');
  const [cut] = queuedIllustrations(store);
  expect(illustrationJob(store, cut).input.sceneAppearanceNotes).toEqual(
    plan.input.sceneAppearanceNotes
  );
  expect((await runIllustrationJob(store, cut, 'worker', hooks))?.status).toBe('completed');
  const redraw = regenerateIllustration(store, cut, true);
  expect(redraw.input.sceneAppearanceNotes).toEqual(['Jun pockets the compass.']);
  expect(() =>
    saveIllustrationContinuity(store, chat.id, {
      expectedRevision: saved.revision,
      edits: [{ id: saved.notes[1].id, remove: true }],
    })
  ).toThrow('changed');
  const foreign = chatWithSource(store).source;
  expect(() =>
    saveIllustrationContinuity(store, chat.id, {
      expectedRevision: 2,
      edits: [
        { id: saved.notes[1].id, remove: true },
        { fromSourceId: foreign.id, text: 'Wrong chat.' },
      ],
    })
  ).toThrow('range');
  expect(sceneAppearanceNotes(store, chat.id, b.id)).toEqual(['Jun pockets the compass.']);
});

test('copies clip notes to the selected ancestry; deleting a boundary retains surviving scenes and advances the revision', () => {
  const store = databases.create();
  const { chat, source: a } = chatWithSource(store);
  const b = completedSource(store, chat.id);
  const c = completedSource(store, chat.id);
  const saved = saveIllustrationContinuity(store, chat.id, {
    expectedRevision: 0,
    edits: [{ fromSourceId: b.id, toSourceId: c.id, text: 'Wet boots.' }],
  });
  expect(captureChatCopy(store, chat.id, a.id).state.illustrationContinuity).toEqual([]);
  const copy = captureChatCopy(store, chat.id, b.id);
  const restored = restoreChatCopy(store, copy, 'continuity-copy');
  const history = store.history(restored.headRevision);
  expect(sceneAppearanceNotes(store, restored.id, history[0].revision)).toEqual([]);
  expect(sceneAppearanceNotes(store, restored.id, history[1].revision)).toEqual(['Wet boots.']);
  deleteScenes(store, chat.id, b.id, {
    ...sceneDeletionImpact(store, chat.id, b.id).request,
    scope: 'only',
    idempotencyKey: 'remove-note-start',
  });
  expect(readIllustrationContinuity(store, chat.id, {})).toMatchObject({
    revision: 2,
    notes: [{ id: saved.notes[0].id, fromSourceId: c.id, toSourceId: c.id, text: 'Wet boots.' }],
  });
});
