import { afterEach, expect, test } from 'vitest';
import type { RunSnapshot } from '../core/types.js';
import {
  illustrationResearch,
  ILLUSTRATION_RESEARCH_TOOLS,
} from '../server/illustration-research.js';
import { nativeContent } from './fixtures/native-content.js';
import { chatWithSource, fixtureSettings, illustrationDatabases } from './fixtures/illustration.js';
import {
  claimIllustration,
  completeIllustrationStoryboard,
  illustrationJob,
  queuedIllustrations,
  regenerateIllustration,
  reserveIllustrationPlan,
  updateIllustrationSettings,
} from '../server/illustrations.js';
import { splitSource } from '../core/auxiliary.js';
import { parseStoryboard } from '../core/illustration-storyboard.js';

const databases = illustrationDatabases('uimori-research-');
afterEach(() => databases.cleanup());

test('research reads native frozen descriptions and lore by exact paths, pages matches, and exposes no writes', () => {
  const pkg = nativeContent({
    description: 'Mira has green eyes.',
    character_book: { entries: [{ keys: ['Mira'], content: 'Mira carries a silver compass.' }] },
  });
  const snapshot = {
    profile: {
      packages: [pkg, nativeContent({ description: 'Unattached secret.' }, { id: 'other' })],
      packageAttachments: [{ id: pkg.id, revision: pkg.revision, role: 'bot' }],
    },
  } as RunSnapshot;
  const input = {
    research: {
      prior: [
        { id: 'old', sourceHash: 'frozen', caption: 'Mira at the pier', prompt: 'silver compass' },
      ],
    },
  } as Parameters<typeof illustrationResearch>[1];
  const research = illustrationResearch(structuredClone(snapshot), structuredClone(input));
  pkg.nativeRisu.card.description = 'Changed after reservation';
  expect(research.catalog).toHaveLength(2);
  const result = research.execute('illustration.sources.search', {
    query: 'green eyes',
    limit: 1,
  }) as any;
  expect(result.matches[0]).toMatchObject({
    id: 'resource:0',
    path: '/package/nativeRisu/card/description',
    excerpt: 'Mira has green eyes.',
  });
  expect(
    research.execute('illustration.sources.read', {
      id: 'resource:0',
      path: result.matches[0].path,
    })
  ).toMatchObject({ text: 'Mira has green eyes.', revision: 1 });
  expect(
    research.execute('illustration.sources.search', { query: 'Unattached secret' })
  ).toMatchObject({ total: 0 });
  expect(
    research.execute('illustration.sources.read', { id: 'illustration:old', path: '/prompt' })
  ).toMatchObject({ text: 'silver compass' });
  expect(() => research.execute('resource.save', {})).toThrow('Read-only');
  expect(ILLUSTRATION_RESEARCH_TOOLS.map((tool) => tool.name)).toEqual([
    'illustration.sources.search',
    'illustration.sources.read',
  ]);
});

test('shared cast survives distinct cuts and redraw without changing scene-specific visual briefs or old parser contracts', () => {
  const store = databases.create();
  const { source } = chatWithSource(store);
  const { revision, ...settings } = fixtureSettings({ maxPerSource: 3 });
  updateIllustrationSettings(store, { expectedRevision: revision, ...settings }, true);
  const plan = reserveIllustrationPlan(store, source, 'manual', { testMode: true, maxTargets: 2 });
  const targets = splitSource(source).map((block, index) => ({
    startAnchor: block.anchor,
    endAnchor: block.anchor,
    focus: block.text,
    visualBrief: index ? 'Mira takes off her coat' : 'Mira in a red coat',
  }));
  const visualCanon = [{ name: 'Mira', appearance: 'Green eyes and silver braid' }];
  const board = parseStoryboard(
    JSON.stringify({ heroIndex: 0, targets, visualCanon }),
    splitSource(source),
    2,
    'none',
    false
  );
  const claimed = claimIllustration(store, plan.id, 'test')!;
  expect(
    completeIllustrationStoryboard(store, claimed.job, 'test', board, {
      stage: 'planning',
      attempts: [],
      retries: [],
    })
  ).toBe(true);
  const cuts = queuedIllustrations(store).map((id) => illustrationJob(store, id));
  expect(cuts.map((cut) => cut.input.visualCanon)).toEqual([visualCanon, visualCanon]);
  expect(cuts.map((cut) => cut.input.target?.visualBrief)).toEqual(
    targets.map((target) => target.visualBrief)
  );
  store.db.prepare("UPDATE illustration_jobs SET status='failed' WHERE id=?").run(cuts[0].id);
  expect(regenerateIllustration(store, cuts[0].id, true).input.visualCanon).toEqual(visualCanon);
  expect(
    parseStoryboard(
      JSON.stringify({ heroIndex: 0, targets }),
      splitSource(source),
      2,
      'none',
      false
    )
  ).toEqual({ heroIndex: 0, targets });
});
