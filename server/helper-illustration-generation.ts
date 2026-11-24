import type { SelectedIllustrationMoment } from '../core/illustration-storyboard.js';
import type { ProviderTool } from '../core/transport.js';
import { helperSceneSource } from './helper-scene-tools.js';
import { reserveSelectedIllustrations } from './illustrations.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Source, Store } from './store.js';

export const HELPER_ILLUSTRATION_MOMENTS_MAX = 10;

export const HELPER_ILLUSTRATION_GENERATION_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.generate',
    description:
      'Queue new illustrations for chosen moments of the story, in one or several scenes. Each moment is a paragraph range of one scene with the exact instant to depict. The chosen moments go straight to prompt preparation, the content check and rendering, one picture each, without an automatic storyboard of the whole scene. Rendering runs in the background: the result returns the queued jobIds per scene, and task.list or task.inspect shows their progress. Read the paragraphs and anchors with illustration.scene.read first, and check illustration.cuts.list so a moment is not illustrated twice.',
    inputSchema: {
      type: 'object',
      properties: {
        moments: {
          type: 'array',
          minItems: 1,
          maxItems: HELPER_ILLUSTRATION_MOMENTS_MAX,
          description: 'One entry per picture. Queue more pictures with a later call.',
          items: {
            type: 'object',
            properties: {
              sourceId: { type: 'string', description: 'Id of the scene.' },
              expectedSourceHash: {
                type: 'string',
                pattern: '^[a-f0-9]{64}$',
                description: 'Current sourceHash of the scene, from illustration.scene.read.',
              },
              startAnchor: {
                type: 'string',
                description: 'First paragraph anchor of the moment, from illustration.scene.read.',
              },
              endAnchor: { type: 'string', description: 'Last paragraph anchor of the moment.' },
              focus: {
                type: 'string',
                minLength: 1,
                maxLength: 8000,
                description: 'The exact instant to depict.',
              },
              direction: {
                type: 'string',
                maxLength: 8000,
                description: 'Optional visual direction such as framing, angle or mood.',
              },
            },
            required: ['sourceId', 'expectedSourceHash', 'startAnchor', 'endAnchor', 'focus'],
            additionalProperties: false,
          },
        },
      },
      required: ['moments'],
      additionalProperties: false,
    },
  },
];

export function generateHelperIllustrations(
  store: Store,
  chatId: string,
  args: Record<string, unknown>,
  options: { testMode?: boolean } = {}
) {
  fields(args, ['moments']);
  if (!Array.isArray(args.moments) || !args.moments.length)
    throw new HttpError(400, 'Select at least one illustration moment.');
  if (args.moments.length > HELPER_ILLUSTRATION_MOMENTS_MAX)
    throw new HttpError(
      400,
      `ILLUSTRATION_MOMENTS_LIMIT: Queue at most ${HELPER_ILLUSTRATION_MOMENTS_MAX} pictures per call.`
    );
  const moments = args.moments;
  return store.transaction(() => {
    const ancestry = new Set(
      store.history(store.chat(chatId).headRevision).map((item) => item.revision)
    );
    const groups = new Map<
      string,
      { source: Source; selectedMoments: SelectedIllustrationMoment[] }
    >();
    for (const raw of moments) {
      const moment = record(raw);
      fields(moment, [
        'sourceId',
        'expectedSourceHash',
        'startAnchor',
        'endAnchor',
        'focus',
        'direction',
      ]);
      const sourceId = text(moment.sourceId, 'source ID', 100);
      let group = groups.get(sourceId);
      if (!group) {
        group = {
          source: helperSceneSource(store, chatId, sourceId, ancestry),
          selectedMoments: [],
        };
        groups.set(sourceId, group);
      }
      if (text(moment.expectedSourceHash, 'source hash', 64) !== group.source.hash)
        throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
      const direction =
        moment.direction === undefined
          ? ''
          : text(moment.direction, 'illustration direction', 8000, true).trim();
      group.selectedMoments.push({
        startAnchor: text(moment.startAnchor, 'start anchor', 100),
        endAnchor: text(moment.endAnchor, 'end anchor', 100),
        focus: text(moment.focus, 'illustration focus', 8000),
        ...(direction ? { direction } : {}),
      });
    }
    const plans = Array.from(groups.values(), ({ source, selectedMoments }) => {
      const jobs = reserveSelectedIllustrations(store, source, selectedMoments, options);
      return {
        sourceId: source.id,
        revision: source.editRevision ?? 0,
        focus: selectedMoments[0].focus,
        jobId: jobs[0].id,
        jobIds: jobs.map((job) => job.id),
        count: jobs.length,
      };
    });
    return { chatId, plans, count: moments.length };
  });
}
