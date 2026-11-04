import { splitSource } from '../core/auxiliary.js';
import { cutsFor } from '../core/illustration-cuts.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { prepareHelperImage } from './helper-image-tools.js';
import { helperSceneSource } from './helper-scene-tools.js';
import { illustrationPresentation } from './illustration-presentation.js';
import {
  illustrationJob,
  illustrationsForSources,
  projectIllustration,
  regenerateIllustration,
} from './illustrations.js';
import { fields, HttpError, number, text } from './request-validation.js';
import type { Store } from './store.js';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
const hash = { type: 'string', minLength: 64, maxLength: 64 } as const;
const paging = {
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1 },
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
      'Read original scene paragraphs with their exact anchors and current sourceHash. Use them to select an illustration moment or move a cut. Pages preserve manuscript order. maxBlockChars optionally shortens each excerpt; start and end are full UTF-16 offsets.',
    inputSchema: schema(
      {
        sourceId: id,
        expectedSourceHash: hash,
        ...paging,
        maxBlockChars: { type: 'integer', minimum: 1 },
      },
      ['sourceId']
    ),
  },
  {
    name: 'illustration.cuts.list',
    description:
      'List cuts from the story, optionally for one sourceId. Each cut includes the latest request, its displayed image variations, position, stale status and edit guards. Use an imageId with illustration.cut.read to see a particular variation.',
    inputSchema: schema({ sourceId: id, ...paging }, []),
  },
  {
    name: 'illustration.cut.read',
    description:
      'Inspect one generated illustration variation by imageId. View its pixels and the caption, scene, generator and target that produced it. Set includeImage to false for metadata alone, or includePrompt to true to inspect the stored rendering prompt.',
    inputSchema: schema(
      { imageId: id, includeImage: { type: 'boolean' }, includePrompt: { type: 'boolean' } },
      ['imageId']
    ),
  },
  {
    name: 'illustration.cut.redraw',
    description:
      'Request a new rendering of the displayed cut using current settings. Supply the imageId of the chosen variation, currentSourceHash and presentationRevision from cuts.list, and any requested changes. The successful image stays visible until the queued replacement succeeds.',
    inputSchema: schema(
      {
        imageId: id,
        expectedSourceHash: hash,
        expectedPresentationRevision: { type: 'integer', minimum: 0 },
        expectedLatestJobId: id,
        changeRequest: { type: 'string', maxLength: 8000 },
      },
      ['imageId', 'expectedSourceHash', 'expectedPresentationRevision']
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
  fields(args, ['sourceId', 'expectedSourceHash', 'offset', 'limit', 'maxBlockChars']);
  const source = helperSceneSource(store, chatId, text(args.sourceId, 'source ID', 100));
  if (args.expectedSourceHash !== undefined && args.expectedSourceHash !== source.hash)
    throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
  const { offset, limit } = page(args);
  const maxChars =
    args.maxBlockChars === undefined ? undefined : number(args.maxBlockChars, 'block characters');
  const all = splitSource(source);
  return {
    chatId,
    sourceId: source.id,
    sourceHash: source.hash,
    editRevision: source.editRevision ?? 0,
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
    signal
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
