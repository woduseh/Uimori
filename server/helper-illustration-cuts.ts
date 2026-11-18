import { splitSource } from '../core/auxiliary.js';
import { cutsFor } from '../core/illustration-cuts.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { prepareHelperImage } from './helper-image-tools.js';
import { helperSceneSource } from './helper-scene-tools.js';
import {
  illustrationPresentation,
  saveIllustrationPresentation,
} from './illustration-presentation.js';
import {
  illustrationJob,
  illustrationsForSources,
  projectIllustration,
  regenerateIllustration,
  removeIllustration,
} from './illustrations.js';
import { fields, HttpError, number, text } from './request-validation.js';
import type { Store } from './store.js';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
const hash = { type: 'string', minLength: 64, maxLength: 64 } as const;
const paging = {
  offset: {
    type: 'integer',
    minimum: 0,
    description: 'Entry offset. Pass the previous nextOffset.',
  },
  limit: { type: 'integer', minimum: 1, description: 'Maximum entries per page.' },
} as const;
const guard = {
  expectedSourceHash: {
    ...hash,
    description:
      'Current sourceHash of the scene, from illustration.scene.read or illustration.cuts.list (currentSourceHash).',
  },
  expectedPresentationRevision: {
    type: 'integer',
    minimum: 0,
    description: 'presentationRevision of the scene from illustration.cuts.list.',
  },
  expectedLatestJobId: {
    ...id,
    description: 'latestJobId of the cut from illustration.cuts.list.',
  },
} as const;
const schema = (properties: Record<string, Json>, required: string[]): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const HELPER_ILLUSTRATION_CUT_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.scene.read',
    description:
      'Read the original text of one scene as paragraphs, each with the exact anchor and the scene sourceHash that the illustration operations need. Use it to choose the moment for a new illustration or the paragraph a cut should move to. Paragraphs keep manuscript order and their start and end are UTF-16 offsets in the full scene. Pass anchor to get a short page centred on one known paragraph instead of guessing its index.',
    inputSchema: schema(
      {
        sourceId: { ...id, description: 'Id of the scene, from chat.read.' },
        expectedSourceHash: {
          ...hash,
          description: 'Optional: fail if the scene no longer has this sourceHash.',
        },
        anchor: {
          ...id,
          description: 'Centre the page on this paragraph anchor. Do not combine with offset.',
        },
        ...paging,
        maxBlockChars: {
          type: 'integer',
          minimum: 1,
          description: 'Shorten each paragraph excerpt to this many characters.',
        },
      },
      ['sourceId']
    ),
  },
  {
    name: 'illustration.cuts.list',
    description:
      'List the illustration cuts of the story, or of one scene. Each cut shows its latest request, the image variations on display, its position in the scene, whether it is stale after a text edit, and the values the other cut operations need: targetId, latestJobId, imageId, currentSourceHash and presentationRevision. Use it to find an existing cut before suggesting new ones, and before redrawing, revising, moving or deleting a cut. To look at a picture, pass an imageId to illustration.cut.read.',
    inputSchema: schema(
      {
        sourceId: {
          ...id,
          description: 'Limit to the cuts of this scene. Omit for the whole story.',
        },
        ...paging,
      },
      []
    ),
  },
  {
    name: 'illustration.cut.read',
    description:
      'Look at one generated illustration variation by its imageId: the picture itself as image input, plus the caption, scene, generator and target that produced it. Use it to compare a picture with the manuscript or with the appearance profiles before judging or redrawing it. Set includeImage to false for the metadata alone, or includePrompt to true to see the stored rendering prompt.',
    inputSchema: schema(
      {
        imageId: { ...id, description: 'Id of the image variation, from illustration.cuts.list.' },
        includeImage: {
          type: 'boolean',
          description: 'Send the picture itself. Default true.',
        },
        includePrompt: {
          type: 'boolean',
          description: 'Also return the stored rendering prompt. Default false.',
        },
      },
      ['imageId']
    ),
  },
  {
    name: 'illustration.cut.redraw',
    description:
      'Queue a new rendering of a cut that already has a picture, with the current settings and optionally a requested change. The existing picture stays visible until the new one succeeds, and rendering continues in the background. For a cut that failed without producing a picture, use illustration.cut.revise instead.',
    inputSchema: schema(
      {
        imageId: { ...id, description: 'Id of the displayed variation to redraw.' },
        expectedSourceHash: guard.expectedSourceHash,
        expectedPresentationRevision: guard.expectedPresentationRevision,
        expectedLatestJobId: guard.expectedLatestJobId,
        changeRequest: {
          type: 'string',
          maxLength: 8000,
          description: 'What should be different in the new picture. Omit to redraw as is.',
        },
      },
      ['imageId', 'expectedSourceHash', 'expectedPresentationRevision']
    ),
  },
  {
    name: 'illustration.cut.revise',
    description:
      'Change the moment or the visual brief of a cut that failed, was cancelled or was interrupted without producing a picture, and queue a fresh render. The earlier failure stays in the history. The new request goes through prompt preparation and the content check like any other. For a cut that already has a picture, use illustration.cut.redraw.',
    inputSchema: schema(
      {
        targetId: { ...id, description: 'targetId of the cut, from illustration.cuts.list.' },
        expectedLatestJobId: guard.expectedLatestJobId,
        expectedSourceHash: guard.expectedSourceHash,
        expectedPresentationRevision: guard.expectedPresentationRevision,
        startAnchor: {
          ...id,
          description: 'New first paragraph anchor of the moment, from illustration.scene.read.',
        },
        endAnchor: { ...id, description: 'New last paragraph anchor of the moment.' },
        focus: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'The exact instant to depict.',
        },
        visualBrief: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'How the picture should look: framing, mood and visible details.',
        },
        changeRequest: {
          type: 'string',
          maxLength: 8000,
          description: 'What should change compared with the failed request.',
        },
      },
      ['targetId', 'expectedLatestJobId', 'expectedSourceHash', 'expectedPresentationRevision']
    ),
  },
  {
    name: 'illustration.cut.delete',
    description:
      'Permanently delete one illustration cut together with its pictures and render history. This cannot be undone. Use the latestJobId and guards from illustration.cuts.list. Queued or rendering cuts cannot be deleted.',
    inputSchema: schema(
      {
        expectedLatestJobId: guard.expectedLatestJobId,
        expectedSourceHash: guard.expectedSourceHash,
        expectedPresentationRevision: guard.expectedPresentationRevision,
      },
      ['expectedLatestJobId', 'expectedSourceHash', 'expectedPresentationRevision']
    ),
  },
];

type Args = Record<string, unknown>;
function page(args: Args) {
  return {
    offset: args.offset === undefined ? 0 : number(args.offset, 'offset', 0),
    limit: args.limit === undefined ? 20 : number(args.limit, 'limit'),
  };
}
export function readIllustrationScene(store: Store, chatId: string, args: Args) {
  fields(args, ['sourceId', 'expectedSourceHash', 'anchor', 'offset', 'limit', 'maxBlockChars']);
  const source = helperSceneSource(store, chatId, text(args.sourceId, 'source ID', 100));
  if (args.expectedSourceHash !== undefined && args.expectedSourceHash !== source.hash)
    throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
  const { offset: requestedOffset, limit } = page(args);
  const maxChars =
    args.maxBlockChars === undefined ? undefined : number(args.maxBlockChars, 'block characters');
  const all = splitSource(source);
  const anchorIndex =
    args.anchor === undefined
      ? -1
      : all.findIndex((block) => block.anchor === text(args.anchor, 'anchor', 100));
  if (args.anchor !== undefined && anchorIndex < 0)
    throw new HttpError(404, 'ILLUSTRATION_ANCHOR_NOT_FOUND');
  if (args.anchor !== undefined && args.offset !== undefined)
    throw new HttpError(400, 'Specify anchor or offset, not both');
  const offset =
    anchorIndex < 0 ? requestedOffset : Math.max(0, anchorIndex - Math.floor(limit / 2));
  return {
    chatId,
    sourceId: source.id,
    sourceHash: source.hash,
    editRevision: source.editRevision ?? 0,
    offset,
    blocks: all.slice(offset, offset + limit).map((block) =>
      maxChars && block.text.length > maxChars
        ? {
            ...block,
            text: block.text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/u, ''),
            textTruncated: true,
          }
        : block
    ),
    total: all.length,
    nextOffset: offset + limit < all.length ? offset + limit : null,
  };
}

export function listIllustrationCuts(store: Store, chatId: string, args: Args) {
  fields(args, ['sourceId', 'offset', 'limit']);
  const { offset, limit } = page(args);
  const chat = store.chat(chatId);
  const selected =
    args.sourceId === undefined
      ? undefined
      : helperSceneSource(store, chatId, text(args.sourceId, 'source ID', 100));
  // Count cut identities first. Scenes outside the requested page need no
  // manuscript, job recipe, diagnostics or generated-image metadata.
  const scenes = store.db
    .prepare(`WITH RECURSIVE chain(id) AS (
    SELECT ? UNION SELECT s.parent_revision FROM sources s JOIN chain ON s.id=chain.id WHERE s.parent_revision IS NOT NULL
  )
  SELECT j.source_revision AS sourceId, COUNT(DISTINCT COALESCE(json_extract(j.input,'$.target.id'),j.id)) AS count
  FROM illustration_jobs j JOIN chain ON j.source_revision=chain.id JOIN sources s ON s.id=chain.id
  WHERE j.chat_id=? AND COALESCE(json_extract(j.input,'$.task'),'render')='render'
  ${selected ? 'AND j.source_revision=?' : ''}
  GROUP BY j.source_revision ORDER BY s.rowid`)
    .all(chat.headRevision, chatId, ...(selected ? [selected.id] : [])) as {
    sourceId: string;
    count: number;
  }[];
  let total = 0;
  const cuts = scenes.flatMap(({ sourceId, count }) => {
    const first = total;
    total += count;
    if (total <= offset || first >= offset + limit) return [];
    const source = selected ?? store.source(sourceId);
    const raw = illustrationPresentation(store, sourceId);
    const anchors = new Map(splitSource(source).map((block) => [block.anchor, block.index]));
    const group = cutsFor(illustrationsForSources(store, [sourceId]), source.hash);
    const position = (cut: (typeof group)[number]) => {
      if (!cut.stale && cut.job.display?.hero) return -1;
      if (!cut.stale && cut.job.target) return anchors.get(cut.job.target.endAnchor) ?? Infinity;
      return Infinity;
    };
    return group
      .sort((a, b) => position(a) - position(b))
      .slice(Math.max(0, offset - first), offset + limit - first)
      .map(({ job, picture, stale }) => ({
        sourceId,
        currentSourceHash: source.hash,
        sourceHash: job.sourceHash,
        editRevision: source.editRevision ?? 0,
        presentationRevision: raw?.revision ?? 0,
        targetId: job.target?.id ?? null,
        latestJobId: job.id,
        status: job.status,
        displayedJobId: picture?.id ?? null,
        stale,
        hero: !stale && (job.display?.hero ?? false),
        ...(job.target
          ? {
              startAnchor: job.target.startAnchor,
              endAnchor: job.target.endAnchor,
              focus: job.target.focus,
            }
          : job.unplacedMoment
            ? { focus: job.unplacedMoment.focus }
            : {}),
        images: (picture?.images ?? []).map(({ id, caption, position }) => ({
          imageId: id,
          position,
          caption,
        })),
      }));
  });
  return { chatId, cuts, total, nextOffset: offset + limit < total ? offset + limit : null };
}
/** An immutable completed variation is chat-owned. Metadata lookup never loads its pixels. */
export function resolveIllustrationCutImage(store: Store, chatId: string, imageId: string) {
  const image = store.db
    .prepare(`SELECT i.id AS imageId,i.job_id AS jobId,j.source_revision AS sourceId,
    j.source_hash AS sourceHash,i.position,i.hash,i.mime,COALESCE(json_extract(i.body,'$.caption'),'') AS caption
    FROM illustration_images i JOIN illustration_jobs j ON j.id=i.job_id
    WHERE i.id=? AND i.chat_id=? AND j.chat_id=i.chat_id AND j.status='completed'`)
    .get(imageId, chatId) as
    | {
        imageId: string;
        jobId: string;
        sourceId: string;
        sourceHash: string;
        position: number;
        hash: string;
        mime: string;
        caption: string;
      }
    | undefined;
  if (!image) throw new HttpError(404, 'ILLUSTRATION_IMAGE_NOT_FOUND');
  return image;
}

export function inspectIllustrationCut(store: Store, chatId: string, args: Args) {
  fields(args, ['imageId', 'includeImage', 'includePrompt']);
  for (const key of ['includeImage', 'includePrompt']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean')
      throw new HttpError(400, 'Invalid ' + key);
  }
  const image = resolveIllustrationCutImage(store, chatId, text(args.imageId, 'image ID', 100));
  const row = illustrationJob(store, image.jobId);
  const presentation = illustrationPresentation(store, image.sourceId);
  const projected = projectIllustration(store, row, presentation);
  const key = row.input.target?.id ?? row.id;
  const placement = presentation?.targets[key] ?? presentation?.detached?.[key];
  const currentTarget = placement?.placedTarget ?? row.input.target;
  // A copied picture has placement notes but no original generation recipe.
  const generator: string = row.input.generator;
  const hasRecipe = generator !== 'none';
  const variant = projected.images.find((item) => item.id === image.imageId)!;
  return {
    ...image,
    chatId,
    generatedSourceHash: hasRecipe ? image.sourceHash : null,
    sourceHash: projected.sourceHash,
    currentSourceHash: store.source(image.sourceId).hash,
    generator,
    preset: row.input.preset ?? null,
    target: projected.target
      ? { ...projected.target, visualBrief: currentTarget?.visualBrief ?? null }
      : null,
    ...(projected.unplacedMoment ? { unplacedMoment: projected.unplacedMoment } : {}),
    generatedFocus: hasRecipe ? (row.input.target?.focus ?? null) : null,
    generatedVisualBrief: hasRecipe ? (row.input.target?.visualBrief ?? null) : null,
    ...(args.includePrompt === true
      ? {
          prompt: variant.prompt ?? row.diagnostic?.prompt?.prompt ?? null,
          revisedPrompt: variant.revisedPrompt ?? null,
          negativePrompt: row.diagnostic?.prompt?.negativePrompt ?? null,
        }
      : {}),
  };
}
export async function readIllustrationCutImage(
  store: Store,
  chatId: string,
  args: Args,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const metadata = inspectIllustrationCut(store, chatId, args);
  return prepareHelperImage(
    store,
    metadata.hash,
    metadata.caption || 'Illustration',
    metadata,
    signal,
    'full'
  );
}

export function redrawIllustrationCut(store: Store, chatId: string, args: Args, testMode = false) {
  fields(args, [
    'imageId',
    'expectedSourceHash',
    'expectedPresentationRevision',
    'expectedLatestJobId',
    'changeRequest',
  ]);
  const image = resolveIllustrationCutImage(store, chatId, text(args.imageId, 'image ID', 100));
  const expectedHash = text(args.expectedSourceHash, 'source hash', 64);
  const presentationRevision = number(
    args.expectedPresentationRevision,
    'presentation revision',
    0
  );
  const latestId =
    args.expectedLatestJobId === undefined
      ? undefined
      : text(args.expectedLatestJobId, 'latest job ID', 100);
  const changes =
    args.changeRequest === undefined
      ? undefined
      : text(args.changeRequest, 'change request', 8000, true);
  return store.transaction(() => {
    const source = helperSceneSource(store, chatId, image.sourceId);
    if (source.hash !== expectedHash) throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
    const job = projectIllustration(store, illustrationJob(store, image.jobId));
    if (job.sourceHash !== source.hash) throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
    if (!job.target || !job.display) throw new HttpError(409, 'ILLUSTRATION_TARGET_UNAVAILABLE');
    if (
      job.display.revision !== presentationRevision ||
      job.display.displayedJobId !== job.id ||
      (latestId && job.display.latestRequestedJobId !== latestId)
    )
      throw new HttpError(409, 'ILLUSTRATION_CUT_CHANGED');
    const next = regenerateIllustration(store, job.id, testMode, changes, image.imageId);
    return {
      chatId,
      sourceId: source.id,
      sourceHash: source.hash,
      editRevision: source.editRevision ?? 0,
      jobId: next.id,
      targetId: job.target.id,
      focus: job.target.focus,
      status: next.status,
    };
  });
}

/** The presentation's latest-job identity is the CAS owner even when no image exists. */
function currentCut(store: Store, chatId: string, args: Args, permitStale = false) {
  const job = illustrationJob(store, text(args.expectedLatestJobId, 'latest job ID', 100));
  if (job.chatId !== chatId || (job.input.task ?? 'render') !== 'render' || !job.input.target)
    throw new HttpError(404, 'ILLUSTRATION_TARGET_UNAVAILABLE');
  const source = helperSceneSource(store, chatId, job.sourceRevision);
  if (
    source.hash !== text(args.expectedSourceHash, 'source hash', 64) ||
    (!permitStale && source.hash !== job.sourceHash)
  )
    throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
  const presentation = illustrationPresentation(store, source.id);
  if (!permitStale && presentation?.sourceHash !== source.hash)
    throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
  if (
    !presentation ||
    presentation.revision !== number(args.expectedPresentationRevision, 'presentation revision', 0)
  )
    throw new HttpError(409, 'ILLUSTRATION_PRESENTATION_CHANGED');
  const entry =
    presentation.targets[job.input.target.id] ??
    (permitStale ? presentation.detached?.[job.input.target.id] : undefined);
  if (!entry || entry.latestRequestedJobId !== job.id)
    throw new HttpError(409, 'ILLUSTRATION_CUT_CHANGED');
  return { job, source, presentation, entry };
}

export function reviseFailedIllustrationCut(
  store: Store,
  chatId: string,
  args: Args,
  testMode = false
) {
  fields(args, [
    'targetId',
    'expectedLatestJobId',
    'expectedSourceHash',
    'expectedPresentationRevision',
    'startAnchor',
    'endAnchor',
    'focus',
    'visualBrief',
    'changeRequest',
  ]);
  return store.transaction(() => {
    const { job, source, presentation, entry } = currentCut(store, chatId, args);
    if (text(args.targetId, 'target ID', 100) !== job.input.target!.id)
      throw new HttpError(409, 'ILLUSTRATION_CUT_CHANGED');
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status) || entry.displayedJobId)
      throw new HttpError(409, 'ILLUSTRATION_TARGET_UNAVAILABLE');
    const before = entry.placedTarget ?? job.input.target!;
    const startAnchor =
      args.startAnchor === undefined
        ? before.startAnchor
        : text(args.startAnchor, 'start anchor', 100);
    const endAnchor =
      args.endAnchor === undefined ? before.endAnchor : text(args.endAnchor, 'end anchor', 100);
    const blocks = splitSource(source);
    const index = new Map(blocks.map(({ anchor, index }) => [anchor, index]));
    if (
      index.get(startAnchor) === undefined ||
      index.get(endAnchor) === undefined ||
      index.get(startAnchor)! > index.get(endAnchor)!
    )
      throw new HttpError(400, 'ILLUSTRATION_TARGET_UNAVAILABLE');
    if (
      Object.keys(presentation.targets).some(
        (other) =>
          other !== before.id &&
          (presentation.targets[other].placedTarget?.endAnchor ??
            illustrationJob(store, presentation.targets[other].latestRequestedJobId).input.target
              ?.endAnchor) === endAnchor
      )
    )
      throw new HttpError(409, 'ILLUSTRATION_TARGET_CONFLICT');
    const focus = args.focus === undefined ? before.focus : text(args.focus, 'focus', 8000);
    const visualBrief =
      args.visualBrief === undefined
        ? args.focus === undefined
          ? before.visualBrief
          : focus
        : text(args.visualBrief, 'visual brief', 8000);
    entry.placedTarget = { ...before, startAnchor, endAnchor, focus, visualBrief };
    if (
      presentation.translation &&
      (startAnchor !== before.startAnchor ||
        endAnchor !== before.endAnchor ||
        focus !== before.focus)
    )
      delete presentation.translation.afterByTarget[before.id];
    saveIllustrationPresentation(store, source.id, presentation);
    const newJob = regenerateIllustration(
      store,
      job.id,
      testMode,
      args.changeRequest === undefined
        ? undefined
        : text(args.changeRequest, 'change request', 8000, true)
    );
    return {
      chatId,
      sourceId: source.id,
      editRevision: source.editRevision ?? 0,
      targetId: before.id,
      jobId: newJob.id,
      status: newJob.status,
      focus,
    };
  });
}

export function deleteIllustrationCut(store: Store, chatId: string, args: Args) {
  fields(args, ['expectedLatestJobId', 'expectedSourceHash', 'expectedPresentationRevision']);
  return store.transaction(() => {
    const { job, source } = currentCut(store, chatId, args, true);
    const targetId = job.input.target!.id;
    removeIllustration(store, job.id);
    return {
      deleted: true,
      chatId,
      sourceId: source.id,
      editRevision: source.editRevision ?? 0,
      targetId,
    };
  });
}
