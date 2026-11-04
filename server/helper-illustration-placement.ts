import { splitSource } from '../core/auxiliary.js';
import type { IllustrationTarget } from '../core/illustration-storyboard.js';
import type { ProviderTool } from '../core/transport.js';
import { helperSceneSource } from './helper-scene-tools.js';
import {
  illustrationPresentation,
  newIllustrationPresentation,
  saveIllustrationPresentation,
} from './illustration-presentation.js';
import { illustrationJob } from './illustrations.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const id = { type: 'string', minLength: 1 } as const;
export const HELPER_ILLUSTRATION_PLACEMENT_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.cuts.place',
    description:
      'Place existing pictures at new paragraphs in their original scenes, including after a text edit. Use the displayed render job ID, current source hash and layout revision from cut inspection, and exact original paragraph anchors. An optional focus or visualBrief describes the revised moment for a future redraw. Set hero to change the lead image. All moves are saved together and reuse the existing images.',
    inputSchema: {
      type: 'object',
      properties: {
        placements: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              jobId: id,
              expectedSourceHash: id,
              expectedPresentationRevision: { type: 'integer', minimum: 0 },
              startAnchor: id,
              endAnchor: id,
              focus: id,
              visualBrief: id,
              hero: { type: 'boolean' },
            },
            required: [
              'jobId',
              'expectedSourceHash',
              'expectedPresentationRevision',
              'startAnchor',
              'endAnchor',
            ],
            additionalProperties: false,
          },
        },
      },
      required: ['placements'],
      additionalProperties: false,
    },
  },
];

function sceneLayout(
  store: Store,
  chatId: string,
  sourceId: string,
  ancestry: ReadonlySet<string>
) {
  const source = helperSceneSource(store, chatId, sourceId, ancestry);
  const previous = illustrationPresentation(store, sourceId);
  const current =
    previous?.sourceHash === source.hash
      ? previous
      : newIllustrationPresentation(source.hash, previous);
  const blocks = new Map(splitSource(source).map((block) => [block.anchor, block]));
  return { source, previous, current, blocks, changed: false, requestedHero: false };
}

export function placeIllustrationCuts(store: Store, chatId: string, args: Record<string, unknown>) {
  fields(args, ['placements']);
  if (!Array.isArray(args.placements) || !args.placements.length)
    throw new HttpError(400, 'Supply the pictures and their new paragraph anchors.');
  const entries = args.placements;
  return store.transaction(() => {
    const scenes = new Map<string, ReturnType<typeof sceneLayout>>();
    const seen = new Set<string>();
    const ancestry = new Set(
      store.history(store.chat(chatId).headRevision).map((item) => item.revision)
    );
    const placements = entries.map((raw) => {
      const entry = record(raw);
      fields(entry, [
        'jobId',
        'expectedSourceHash',
        'expectedPresentationRevision',
        'startAnchor',
        'endAnchor',
        'focus',
        'visualBrief',
        'hero',
      ]);
      const job = illustrationJob(store, text(entry.jobId, 'illustration job', 100));
      if (job.chatId !== chatId) throw new HttpError(404, 'Illustration not found in this chat');
      const targetId = job.input.target?.id ?? job.id;
      if (seen.has(targetId)) throw new HttpError(400, 'Duplicate illustration target');
      seen.add(targetId);
      const layout =
        scenes.get(job.sourceRevision) ?? sceneLayout(store, chatId, job.sourceRevision, ancestry);
      scenes.set(job.sourceRevision, layout);
      const { source, previous, current, blocks } = layout;
      if (text(entry.expectedSourceHash, 'source hash', 100) !== source.hash)
        throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
      if (
        number(entry.expectedPresentationRevision, 'illustration layout revision', 0) !==
        current.revision
      )
        throw new HttpError(409, 'ILLUSTRATION_PRESENTATION_CHANGED');
      const prior = previous?.targets[targetId] ?? previous?.detached?.[targetId];
      if (
        job.status !== 'completed' ||
        !store.db.prepare('SELECT 1 FROM illustration_images WHERE job_id=? LIMIT 1').get(job.id)
      )
        throw new HttpError(409, 'Choose a completed illustration with an image.');
      if (
        prior
          ? prior.displayedJobId !== job.id
          : store.db
              .prepare(
                `SELECT j.id FROM illustration_jobs j WHERE source_revision=? AND COALESCE(json_extract(input,'$.target.id'),j.id)=?
         AND EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id) AND status='completed'
         ORDER BY created_at DESC,j.id DESC LIMIT 1`
              )
              .get(source.id, targetId)?.id !== job.id
      )
        throw new HttpError(409, 'ILLUSTRATION_PRESENTATION_CHANGED');
      if (
        store.db
          .prepare(`SELECT 1 FROM illustration_jobs WHERE source_revision=?
        AND COALESCE(json_extract(input,'$.target.id'),id)=? AND status IN ('queued','running') LIMIT 1`)
          .get(source.id, targetId)
      )
        throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
      const start = blocks.get(text(entry.startAnchor, 'startAnchor', 150));
      const end = blocks.get(text(entry.endAnchor, 'endAnchor', 150));
      if (!start || !end || start.index > end.index)
        throw new HttpError(400, 'Invalid illustration paragraph range');
      const old = prior?.placedTarget ?? job.input.target;
      const focus =
        entry.focus === undefined
          ? (old?.focus ?? job.input.unplacedMoment?.focus ?? end.text)
          : text(entry.focus, 'focus');
      const visualBrief =
        entry.visualBrief === undefined
          ? (old?.visualBrief ?? job.input.unplacedMoment?.visualBrief ?? focus)
          : text(entry.visualBrief, 'visualBrief');
      const target: IllustrationTarget = {
        id: targetId,
        order: old?.order ?? end.index,
        ...(old?.planId ? { planId: old.planId } : {}),
        startAnchor: start.anchor,
        endAnchor: end.anchor,
        focus,
        visualBrief,
      };
      const moved =
        !current.targets[targetId] ||
        !old ||
        old.startAnchor !== target.startAnchor ||
        old.endAnchor !== target.endAnchor ||
        old.focus !== focus ||
        old.visualBrief !== visualBrief;
      if (moved) {
        if (current.detached) delete current.detached[targetId];
        current.targets[targetId] = {
          latestRequestedJobId: job.id,
          displayedJobId: job.id,
          placedTarget: target,
        };
        // Preserve other verified translated positions; this moment must be aligned anew.
        if (
          current.translation &&
          (old?.startAnchor !== target.startAnchor ||
            old.endAnchor !== target.endAnchor ||
            old.focus !== focus)
        )
          delete current.translation.afterByTarget[targetId];
      }
      if (entry.hero !== undefined && typeof entry.hero !== 'boolean')
        throw new HttpError(400, 'Invalid hero choice');
      if (entry.hero && layout.requestedHero)
        throw new HttpError(400, 'Choose one lead image per scene.');
      if (entry.hero) layout.requestedHero = true;
      const heroChanged =
        entry.hero !== undefined && (current.heroTargetId === targetId) !== entry.hero;
      if (heroChanged) current.heroTargetId = entry.hero ? targetId : null;
      const changed = moved || heroChanged;
      if (changed) layout.changed = true;
      return { sourceId: source.id, targetId, jobId: job.id, focus, changed };
    });
    const sourceIds: string[] = [];
    for (const [sourceId, layout] of scenes) {
      if (!layout.changed) continue;
      saveIllustrationPresentation(store, sourceId, layout.current);
      sourceIds.push(sourceId);
    }
    return {
      changed: sourceIds.length > 0,
      sourceIds,
      placements: placements.map((item) => ({
        ...item,
        revision: scenes.get(item.sourceId)!.current.revision,
      })),
    };
  });
}
