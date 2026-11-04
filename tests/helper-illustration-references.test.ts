import { afterEach, expect, test } from 'vitest';
import sharp from 'sharp';
import { saveIllustrationReferenceAssignments } from '../server/helper-illustration-references.js';
import {
  claimIllustration,
  completeIllustration,
  frozenIllustrationReferences,
  illustrationReferences,
  removeIllustration,
  updateIllustrationReferences,
} from '../server/illustrations.js';
import { captureChatCopy, restoreChatCopy } from '../server/chat-copy.js';
import {
  chatWithSource,
  fixtureSettings,
  illustrationDatabases,
  reserveIllustration,
  PNG_BASE64,
} from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-helper-cut-reference-');
afterEach(() => databases.cleanup());

test('promoting a selected variation binds only its pixels, survives deletion and copy, and deduplicates on reuse', async () => {
  const store = databases.create();
  const { chat, source } = chatWithSource(store);
  const job = reserveIllustration(store, source, 'manual', {
    settings: fixtureSettings(),
    testMode: true,
  });
  const claim = claimIllustration(store, job.id, 'worker')!;
  const variations = await Promise.all(
    ['red', 'blue'].map(async (color) => ({
      bytes: await sharp({ create: { width: 4, height: 4, channels: 3, background: color } })
        .webp()
        .toBuffer(),
      mime: 'image/webp' as const,
      caption: color,
    }))
  );
  expect(
    completeIllustration(store, job.id, claim.job.generation, 'worker', variations, {
      stage: 'store',
      attempts: [],
      retries: [],
    })
  ).toBe(true);
  const [red, blue] = store.db
    .prepare('SELECT id,hash FROM illustration_images WHERE job_id=? ORDER BY position')
    .all(job.id);
  const profile = { id: 'mira', name: '미라', appearance: '푸른 눈' };
  updateIllustrationReferences(store, chat.id, {
    expectedRevision: 0,
    references: [],
    characterProfiles: [profile],
  });
  const other = chatWithSource(store).chat;
  expect(() =>
    saveIllustrationReferenceAssignments(store, other.id, {
      expectedRevision: 0,
      assignments: [{ imageId: blue.id, role: 'style' }],
    })
  ).toThrow();
  expect(() =>
    saveIllustrationReferenceAssignments(store, chat.id, {
      expectedRevision: 1,
      assignments: [
        { imageId: blue.id, profileIds: ['mira'] },
        { imageId: red.id, profileIds: ['missing'] },
      ],
    })
  ).toThrow();
  expect(store.product.assets(chat.id)).toHaveLength(0);
  expect(illustrationReferences(store, chat.id).revision).toBe(1);
  const assignments = [
    { imageId: blue.id, profileIds: ['mira'] },
    { imageId: red.id, role: 'style' },
  ];
  const assigned = saveIllustrationReferenceAssignments(store, chat.id, {
    expectedRevision: 1,
    assignments,
  });
  const [face, style] = assigned.assignments.map((entry) => entry.ref);
  expect(assigned.revision).toBe(2);
  expect(
    saveIllustrationReferenceAssignments(store, chat.id, { expectedRevision: 2, assignments })
  ).toMatchObject({ changed: false, revision: 2 });
  expect(store.product.assets(chat.id)).toHaveLength(2);
  expect(store.product.asset(face).bytes).toEqual(variations[1].bytes);
  expect(store.product.asset(style).bytes).toEqual(variations[0].bytes);
  removeIllustration(store, job.id);
  const copy = restoreChatCopy(store, captureChatCopy(store, chat.id), 'copied-cut-reference');
  expect(frozenIllustrationReferences(store, copy.id)).toMatchObject([
    { role: 'style', hash: red.hash },
    { role: 'character', hash: blue.hash },
  ]);
  expect(illustrationReferences(store, copy.id).characterProfiles[0]).toMatchObject({
    name: '미라',
    referenceRef: expect.any(String),
  });
});

test('batch assignments move character links and change explicit roles together, leaving unrelated roles alone', () => {
  const store = databases.create();
  const { chat } = chatWithSource(store);
  const [one, two, three] = ['One', 'Two', 'Three'].map(
    (title) =>
      store.product.createAsset(chat.id, {
        title,
        mime: 'image/png',
        base64: PNG_BASE64,
        description: '',
        actor: '',
        outfit: '',
        location: '',
        allowedUse: 'both',
      }).id
  );
  updateIllustrationReferences(store, chat.id, {
    expectedRevision: 0,
    references: [{ ref: three, role: 'style' }],
    characterProfiles: [{ id: 'mira', name: '미라', appearance: '긴 머리', referenceRef: one }],
  });
  expect(() =>
    saveIllustrationReferenceAssignments(store, chat.id, {
      expectedRevision: 0,
      assignments: [{ ref: one, role: 'style' }],
    })
  ).toThrow();
  expect(() =>
    saveIllustrationReferenceAssignments(store, chat.id, {
      expectedRevision: 1,
      assignments: [{ ref: one, role: 'style' }],
    })
  ).toThrow();
  const result = saveIllustrationReferenceAssignments(store, chat.id, {
    expectedRevision: 1,
    assignments: [
      { ref: two, profileIds: ['mira'] },
      { ref: one, profileIds: [], role: 'style' },
    ],
  });
  expect(result.assignments).toEqual([
    { ref: two, title: 'Two', changed: true },
    { ref: one, title: 'One', changed: true },
  ]);
  expect(illustrationReferences(store, chat.id)).toMatchObject({
    revision: 2,
    references: [
      { ref: three, role: 'style' },
      { ref: one, role: 'style' },
    ],
    characterProfiles: [{ id: 'mira', referenceRef: two }],
  });
  saveIllustrationReferenceAssignments(store, chat.id, {
    expectedRevision: 2,
    assignments: [{ ref: one, role: null }],
  });
  expect(illustrationReferences(store, chat.id).references).toEqual([
    { ref: three, role: 'style' },
  ]);
});
