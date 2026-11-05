import type { SelectedIllustrationMoment } from '../core/illustration-storyboard.js';
import type { ProviderTool } from '../core/transport.js';
import { helperSceneSource } from './helper-scene-tools.js';
import { reserveSelectedIllustrations } from './illustrations.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Source, Store } from './store.js';

export const HELPER_ILLUSTRATION_GENERATION_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.generate',
    description:
      'Queue illustrations for the requested moments, across one or more scenes. Use original paragraph anchors and source hashes from illustration.scene.read. Specify the exact instant in focus and optional visual direction for each cut. Explicitly selected moments are queued directly for prompt preparation and rendering; automatic storyboarding is separate. Rendering runs in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        moments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              sourceId: { type: 'string' },
              expectedSourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              startAnchor: { type: 'string' },
              endAnchor: { type: 'string' },
              focus: { type: 'string', minLength: 1, maxLength: 8000 },
              direction: { type: 'string', maxLength: 8000 },
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

/** Reserve every affected scene in the helper operation transaction before waking the worker. */
export function generateHelperIllustrations(
  store: Store,
  chatId: string,
  args: Record<string, unknown>,
  options: { testMode?: boolean } = {}
) {
  fields(args, ['moments']);
  if (!Array.isArray(args.moments) || !args.moments.length)
    throw new HttpError(400, 'Select at least one illustration moment.');
  const moments = args.moments;
  return store.transaction(() => {
    // A chapter may span many sources. Verify the live history once for the whole reservation.
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
