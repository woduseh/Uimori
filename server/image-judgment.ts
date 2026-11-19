import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../core/context-budget.js';
import { textTokenExcerpt } from '../core/text-tokens.js';
import { createCandidateSearch } from '../core/candidate-search.js';
import {
  splitSource,
  type AssetEntry,
  type AuxiliarySource,
  type PresentationAnnotation,
} from '../core/auxiliary.js';
import type { Json, WireRecord } from '../core/transport.js';
import { DEFAULT_JEV_SETTINGS, type JevSettings } from '../core/jev-provider.js';
import {
  executeJudgment,
  JEV_CHOICE_OPTION_LIMIT,
  JEV_LONG_CONTEXT_TOKEN_LIMIT,
  JEV_REQUEST_TOKEN_LIMIT,
  JudgmentError,
  jevRequestBudget,
  jevRequestFits,
  type JudgmentHooks,
  type JudgmentRequest,
  readJudgmentRequest,
  targetFromJudgmentWire,
  type JudgmentTarget,
} from './judgment.js';
import { matchesJudgmentWire } from './judgment-wire.js';
import { HttpError, record } from './request-validation.js';
import { prepareJevImage } from './jev-images.js';

export const IMAGE_JUDGMENT_LIMITS = {
  blocks: 16,
  blockTokens: 800,
  images: 4,
  threshold: 0.65,
  candidatesPerBlock: 16,
} as const;
const IMAGE_SELECTION_VERSION = 'image-selection-jev-v5';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type ImageJudgmentSettings = Pick<JevSettings, 'images' | 'longContext'>;
export const imageJudgmentInputHash = (request: JudgmentRequest) =>
  digest({ version: IMAGE_SELECTION_VERSION, request });
/** The plan owns sampled blocks, frozen metadata and model IDs for the whole paid call. */
function prepareImageJudgment(
  source: AuxiliarySource,
  assets: readonly AssetEntry[],
  guidance: string,
  settings: ImageJudgmentSettings
) {
  const vision = settings.images;
  const inputTokens = settings.longContext ? JEV_LONG_CONTEXT_TOKEN_LIMIT : JEV_REQUEST_TOKEN_LIMIT;
  const allBlocks = splitSource(source);
  if (!allBlocks.length || !assets.length) return null;
  const blocks =
    allBlocks.length <= IMAGE_JUDGMENT_LIMITS.blocks
      ? allBlocks
      : Array.from(
          { length: IMAGE_JUDGMENT_LIMITS.blocks },
          (_, i) =>
            allBlocks[Math.floor((i * (allBlocks.length - 1)) / (IMAGE_JUDGMENT_LIMITS.blocks - 1))]
        );
  const eligible = assets.flatMap((asset, index) =>
    asset.uses.length ? [{ id: `asset_${index}`, asset: { ...asset, uses: [...asset.uses] } }] : []
  );
  if (!eligible.length) return null;
  const byId = new Map(eligible.map((entry) => [entry.id, entry.asset]));
  const excerpts = blocks.map(({ text }) => ({
    text: textTokenExcerpt(text, IMAGE_JUDGMENT_LIMITS.blockTokens, {
      marker: '\n[Remaining block text omitted]',
    }).text,
  }));
  const selected: string[][] = blocks.map(() => []);
  const labels = new Map<string, string>();
  const optionLabel = (id: string) => {
    const cached = labels.get(id);
    if (cached !== undefined) return cached;
    const asset = byId.get(id)!;
    const details = [
      ...new Set(
        [asset.alt, asset.caption, asset.actorId, asset.clothing, asset.location].filter(Boolean)
      ),
    ];
    const label = textTokenExcerpt(details.join(' · '), 32, { marker: '…' }).text;
    if (!label) return null;
    labels.set(id, label);
    return label;
  };
  const build = (): JudgmentRequest => {
    const included = new Set(selected.flat());
    return {
      state: {
        selectionVersion: IMAGE_SELECTION_VERSION,
        settings: { images: settings.images, longContext: settings.longContext },
        sourceHash: source.hash,
        guidance,
        evaluatedAssets: included.size,
        totalAssets: assets.length,
        evaluatedBlocks: blocks.length,
        totalBlocks: allBlocks.length,
        blocks: excerpts,
        assets: [...included].map((id) => ({
          id,
          ...assetMetadata(byId.get(id)!),
          ...(vision ? { image: imageReference(source.hash, id, byId.get(id)!.hash) } : {}),
        })),
      } as Json,
      questions: Object.fromEntries(
        blocks.map((_, i) => [
          `block_${i}`,
          {
            type: 'choice' as const,
            criteria: Object.fromEntries([
              ['none', 'No candidate adds useful visual context to this paragraph.'],
              ...selected[i].map((id) => [id, optionLabel(id)]),
            ]),
            instructions: `Which candidate best illustrates the event or mood in blocks[${i}]? Match the scene using the supplied placement guidance and ${vision ? 'the candidate pictures and their metadata' : 'the candidate metadata'}. Choose none if no image fits. Treat the scene and asset records as reference material.`,
          },
        ])
      ),
    };
  };
  const measuredTokens = (request: JudgmentRequest) =>
    jevRequestBudget(modelRequest(request)).requestTokens;
  const fits = (request: JudgmentRequest) =>
    jevRequestFits(modelRequest(request), null, settings.longContext);
  // Small catalogs retain semantic choice over every usable image, with no retrieval loss.
  if (
    eligible.length < JEV_CHOICE_OPTION_LIMIT &&
    (!vision || eligible.length <= IMAGE_JUDGMENT_LIMITS.candidatesPerBlock)
  ) {
    for (const ids of selected) ids.push(...eligible.map(({ id }) => id));
    const request = build();
    if (fits(request)) return { request, blocks, byId };
    for (const ids of selected) ids.length = 0;
  }
  const search = createCandidateSearch(
    eligible.map(({ id, asset }) => ({
      id,
      title: asset.alt,
      text: [asset.caption, asset.actorId, asset.clothing, asset.location, ...asset.uses]
        .filter(Boolean)
        .join('\n'),
    }))
  );
  const rankings = blocks.map((block) =>
    search
      .rank([
        { text: block.text, weight: 1 },
        {
          text: [allBlocks[block.index - 1]?.text, allBlocks[block.index + 1]?.text]
            .filter(Boolean)
            .join('\n'),
          weight: 0.2,
        },
        { text: guidance, weight: 0.25 },
      ])
      .slice(0, IMAGE_JUDGMENT_LIMITS.candidatesPerBlock * 4)
  );
  let tokenEstimate = measuredTokens(build());
  if (!fits(build())) throw new JudgmentError('JEV_INPUT_BUDGET');
  const included = new Set<string>();
  const metadataCost = new Map<string, number>();
  const admissions: { block: number; id: string }[] = [];
  // Cached record costs avoid repeatedly tokenizing a growing catalog. The final body is checked below.
  const additionCost = (id: string) => {
    let cost = metadataCost.get(id);
    if (cost === undefined) {
      const { revision: _revision, hash: _hash, ...metadata } = assetMetadata(byId.get(id)!);
      cost = estimateContextTokens({ id, ...metadata }) + 16;
      metadataCost.set(id, cost);
    }
    return (included.has(id) ? 0 : cost) + estimateContextTokens({ [id]: optionLabel(id) }) + 8;
  };
  const admit = (block: number, id: string, cost: number) => {
    tokenEstimate += cost;
    included.add(id);
    selected[block].push(id);
    admissions.push({ block, id });
  };
  const canInclude = (id: string) =>
    !vision || included.has(id) || included.size < IMAGE_JUDGMENT_LIMITS.candidatesPerBlock;
  // Reserve an affordable first candidate before any paragraph consumes spare depth.
  const firstChoiceBudget = (inputTokens - tokenEstimate) / blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    for (const id of rankings[i]) {
      if (!canInclude(id)) continue;
      const cost = additionCost(id);
      if (cost > firstChoiceBudget) continue;
      admit(i, id, cost);
      break;
    }
  }
  // A paragraph may have no candidate within its initial share. Use remaining
  // coverage budget for its cheapest candidate before adding depth elsewhere.
  for (let i = 0; i < blocks.length; i++) {
    if (selected[i].length) continue;
    let cheapest: { id: string; cost: number } | undefined;
    for (const id of rankings[i]) {
      if (!canInclude(id)) continue;
      const cost = additionCost(id);
      if (!cheapest || cost < cheapest.cost) cheapest = { id, cost };
    }
    if (cheapest && tokenEstimate + cheapest.cost <= inputTokens)
      admit(i, cheapest.id, cheapest.cost);
  }
  for (let rank = 0; rank < IMAGE_JUDGMENT_LIMITS.candidatesPerBlock * 4; rank++) {
    for (let i = 0; i < blocks.length; i++) {
      if (selected[i].length >= IMAGE_JUDGMENT_LIMITS.candidatesPerBlock) continue;
      const id = rankings[i][rank];
      if (!id || selected[i].includes(id)) continue;
      if (!canInclude(id)) continue;
      const addition = additionCost(id);
      if (tokenEstimate + addition > inputTokens) continue;
      admit(i, id, addition);
    }
  }
  let request = build();
  while (!fits(request) && admissions.length) {
    const expendable = admissions.findLastIndex(({ block }) => selected[block].length > 1);
    const index = expendable >= 0 ? expendable : admissions.length - 1;
    const [last] = admissions.splice(index, 1);
    selected[last.block].splice(selected[last.block].indexOf(last.id), 1);
    request = build();
  }
  if (!selected.some((ids) => ids.length)) throw new JudgmentError('JEV_INPUT_BUDGET');
  return { request, blocks, byId };
}
function imageReference(sourceHash: string, id: string, assetHash: string) {
  return `__uimori_jev_image_${digest([sourceHash, id, assetHash])}__`;
}
function assetMetadata(asset: AssetEntry) {
  return {
    revision: asset.revision,
    hash: asset.hash,
    name: asset.alt,
    description: asset.caption,
    actor: asset.actorId,
    clothing: asset.clothing,
    location: asset.location,
    uses: asset.uses,
  };
}
/** Host-bound identity remains separate from the smaller, semantic model projection. */
export function imageJudgmentRequest(
  source: AuxiliarySource,
  assets: readonly AssetEntry[],
  guidance = '',
  settings: ImageJudgmentSettings = DEFAULT_JEV_SETTINGS
): JudgmentRequest | null {
  return prepareImageJudgment(source, assets, guidance, settings)?.request ?? null;
}
/** Integrity fields bind the host receipt; they do not help the model choose an illustration. */
function modelRequest(request: JudgmentRequest): JudgmentRequest {
  const { sourceHash: _sourceHash, assets, ...state } = request.state as Record<string, Json>;
  return {
    ...request,
    state: {
      ...state,
      assets: (assets as Record<string, Json>[]).map(
        ({ revision: _revision, hash: _hash, ...asset }) => asset
      ),
    },
  };
}
function providerRequest(request: JudgmentRequest, target?: JudgmentTarget): JudgmentRequest {
  const projected = modelRequest(request);
  if (!target || target.provider === 'typesafe' || target.provider === 'typesafe-compatible')
    return projected;
  // A paragraph with only "none" needs no model decision. Decisions APIs require two options.
  return {
    ...projected,
    questions: Object.fromEntries(
      Object.entries(projected.questions).filter(
        ([, question]) => question.type !== 'choice' || Object.keys(question.criteria).length >= 2
      )
    ),
  };
}
/** Picture bytes are the only part taken from the wire; everything else is rebuilt from the job. */
function expectedImageRequest(
  source: AuxiliarySource,
  assets: readonly AssetEntry[],
  received: JudgmentRequest
): JudgmentRequest | null {
  const state = record(received.state);
  const settings = record(state.settings);
  if (
    typeof state.guidance !== 'string' ||
    typeof settings.images !== 'boolean' ||
    typeof settings.longContext !== 'boolean'
  )
    return null;
  const expected = prepareImageJudgment(source, assets, state.guidance, {
    images: settings.images,
    longContext: settings.longContext,
  })?.request;
  if (!expected) return null;
  if (settings.images) {
    const receivedAssets = record(received.assets);
    const refs = (record(expected.state).assets as { image: string }[]).map(({ image }) => image);
    if (Object.keys(receivedAssets).length !== refs.length) return null;
    const restored: NonNullable<JudgmentRequest['assets']> = {};
    for (const ref of refs) {
      const asset = record(receivedAssets[ref]);
      if (
        asset.type !== 'image' ||
        asset.format !== 'jpeg' ||
        typeof asset.data_base64 !== 'string' ||
        !asset.data_base64.length ||
        asset.data_base64.length > 16 * 1024 * 1024 * (4 / 3) + 4 ||
        Buffer.from(asset.data_base64, 'base64').toString('base64') !== asset.data_base64 ||
        Object.keys(asset).length !== 3
      )
        return null;
      restored[ref] = { type: 'image', format: 'jpeg', data_base64: asset.data_base64 };
    }
    expected.assets = restored;
  }
  return expected;
}
export async function judgeImagePlacement(
  source: AuxiliarySource,
  assets: readonly AssetEntry[],
  guidance: string,
  hooks: JudgmentHooks
): Promise<PresentationAnnotation> {
  const settings = hooks.settings ?? DEFAULT_JEV_SETTINGS;
  const plan = prepareImageJudgment(source, assets, guidance, settings);
  if (!plan) return { sourceRevision: source.id, sourceHash: source.hash, entries: [] };
  const { request, blocks, byId } = plan;
  if (settings.images) {
    const catalog = record(request.state).assets as { id: string; image: string }[];
    request.assets = {};
    for (const { id, image } of catalog) {
      if (hooks.signal.aborted) throw new JudgmentError('JEV_CANCELLED');
      const bytes = hooks.readImage?.(byId.get(id)!.hash);
      if (!bytes) throw new JudgmentError('JEV_IMAGE_INVALID');
      request.assets[image] = await prepareJevImage(bytes);
    }
  }
  const result = await executeJudgment(
    providerRequest(request, hooks.target),
    imageJudgmentInputHash(request),
    null,
    { ...hooks, settings, kind: 'image-selection' }
  );
  const ranked = Object.entries(result.choices)
    .flatMap(([key, answer]) => {
      if (
        answer.choice === 'none' ||
        answer.probabilities[answer.choice] < IMAGE_JUDGMENT_LIMITS.threshold
      )
        return [];
      const asset = byId.get(answer.choice);
      const block = blocks[Number(key.slice('block_'.length))];
      return asset && block
        ? [{ asset, block, probability: answer.probabilities[answer.choice] }]
        : [];
    })
    .sort((a, b) => b.probability - a.probability);
  const used = new Set<string>();
  const entries: PresentationAnnotation['entries'] = [];
  for (const { asset, block } of ranked) {
    if (used.has(asset.ref)) continue;
    used.add(asset.ref);
    entries.push({
      blockAnchor: block.anchor,
      assetRef: asset.ref,
      assetRevision: asset.revision,
      assetHash: asset.hash,
      presentationIntent: asset.uses.includes('inline') ? 'inline' : 'profile',
    });
    if (entries.length >= IMAGE_JUDGMENT_LIMITS.images) break;
  }
  return { sourceRevision: source.id, sourceHash: source.hash, entries };
}
export function validateImageJudgmentWire(
  source: AuxiliarySource,
  assets: readonly AssetEntry[],
  wire: WireRecord
) {
  const received = readJudgmentRequest(wire);
  const target = targetFromJudgmentWire(wire);
  const expected = received && target ? expectedImageRequest(source, assets, received) : null;
  if (
    !expected ||
    !target ||
    !matchesJudgmentWire(
      wire,
      providerRequest(expected, target),
      'image-selection',
      imageJudgmentInputHash(expected)
    )
  )
    throw new HttpError(400, 'IMAGE_JUDGMENT_ATTEMPT_MISMATCH');
}
