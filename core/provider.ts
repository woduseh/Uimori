import { createKnowledgeBrowser } from './knowledge-browse.js';
import { KNOWLEDGE_SKILL_TOOLS } from './read-tools.js';
import { createHash } from 'node:crypto';
import {
  conversationSummary,
  projectedLogicalHistory,
  selectLogicalHistory,
} from './context-projection.js';
import type { ModelInput, Resource, RunSnapshot, ToolEvent } from './types.js';
import { executeStoryRead, STORY_READ_NAMES } from './story-context.js';
import { validateSourceHistory } from './source-history.js';
import { projectStoryUiText } from './story-ui.js';
import {
  compiledPackages,
  packageContextFromCompiled,
  type ResolvedPackage,
} from './package-context.js';
import { DEFAULT_LORE_CONTEXT, measureLoreText, type LorePlacement } from './lore-context.js';
import { countTextTokens, textTokenExcerpt } from './text-tokens.js';
import type { RisuContentSource } from './risu-native.js';
import { isTokenizerProfileId, type TokenizerProfileId } from './tokenizer-profiles.js';
import { outlineContract, type OutlineSnapshot } from './outline.js';
import { AUTHOR_NOTE_GUIDANCE } from './notes.js';
import { PROMPT_COMPILER_VERSIONS } from './risu-prompt.js';
import { packageImages } from './package-images.js';
import { candidateTerms, createCandidateSearch } from './candidate-search.js';

const ALLOWED_TOOLS = KNOWLEDGE_SKILL_TOOLS.map((tool) => tool.name);
export const CATALOG_SUMMARY_TOKENS = 80;
export const CATALOG_TOKENS = 6_000;
export const KNOWLEDGE_READ_TOKENS = 2_000;
export const KNOWLEDGE_READ_MAX_TOKENS = 16_000;
export const KNOWLEDGE_ITEM_TOKENS = 2_000;
export type ReadBudget = {
  tokens: number;
  tokenizer: TokenizerProfileId;
  ranges?: (number | null)[];
};
export const CATALOG_READ_GUIDANCE =
  'The catalog lists summaries of references whose full text is not in the input. When an entry bears on this request, read its full text first: fetch known ids with knowledge.read({ids:[...]}), using a one-item array for a single reference, and request independently needed references together. Wait for earlier results only when they decide the next read. References already delivered in full need no second read. Use knowledge.search when the catalog does not identify the entry you need: exact names favor normal search, mode=relevant ranks lexical matches, and mode=browse follows package/folder structure when vocabulary differs. Follow returned nextRead references; folder metadata is not evidence that the underlying text was read.';

const metadata = ({ text: _text, chatId: _chatId, loreFolder: _loreFolder, ...item }: Resource) =>
  item;
const scopedMetadata = (item: Resource, allowedIds: Set<string>) => ({
  ...metadata(item),
  ...(item.relatedIds ? { relatedIds: item.relatedIds.filter((id) => allowedIds.has(id)) } : {}),
});
const summary = (text: string, profile?: TokenizerProfileId) =>
  textTokenExcerpt(text, CATALOG_SUMMARY_TOKENS, { profile, marker: '…' }).text;
const catalogEntry = (
  item: Resource,
  allowedIds: Set<string>,
  pinnedBodiesDelivered: boolean,
  profile?: TokenizerProfileId
): Omit<Resource, 'text' | 'chatId'> => {
  const pinned = item.loading === 'pinned';
  return {
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    title: item.title,
    description: pinned && pinnedBodiesDelivered ? '' : summary(item.description, profile),
    ...(item.sourceKind ? { sourceKind: item.sourceKind } : {}),
    ...(pinned ? { loading: 'pinned' as const } : {}),
    ...(item.relatedIds ? { relatedIds: item.relatedIds.filter((id) => allowedIds.has(id)) } : {}),
  };
};
export function resourceCatalog(
  resources: readonly Resource[],
  {
    pinnedBodiesDelivered = true,
    tokenizer,
    skipOversized = false,
  }: {
    pinnedBodiesDelivered?: boolean;
    tokenizer?: TokenizerProfileId;
    skipOversized?: boolean;
  } = {}
) {
  const allowedIds = new Set(resources.map((item) => item.id));
  const catalog: MainInput['catalog'] = [];
  for (const resource of resources) {
    const entry = catalogEntry(resource, allowedIds, pinnedBodiesDelivered, tokenizer);
    catalog.push(entry);
    if (countTextTokens(JSON.stringify(catalog), tokenizer) > CATALOG_TOKENS) {
      catalog.pop();
      if (skipOversized && countTextTokens(JSON.stringify([entry]), tokenizer) > CATALOG_TOKENS)
        continue;
      break;
    }
  }
  const listed = catalog.length;
  return {
    catalog,
    ...(listed < resources.length
      ? {
          catalogPage: {
            total: resources.length,
            listed,
            remaining:
              'Use knowledge.search or skills.list with pagination to discover the full approved scope.',
          },
        }
      : {}),
  };
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const KNOWLEDGE_SEARCH_TOKENS = 6_000;
const knowledgeBrowsers = new WeakMap<
  RunSnapshot,
  Map<string, ReturnType<typeof createKnowledgeBrowser>>
>();
export function roleResources(
  snapshot: RunSnapshot,
  role: 'main' | 'translation' | 'image' = 'main'
) {
  return collectRoleResources(snapshot, compiledPackages(snapshot, role));
}
function collectRoleResources(snapshot: RunSnapshot, packages: readonly ResolvedPackage[]) {
  const resources = snapshot.resources.filter(
    (item) =>
      item.chatId === snapshot.chatId &&
      !(snapshot.profile?.packageAttachments?.length && item.id.startsWith('package:'))
  );
  const ids = new Set(resources.map((item) => item.id));
  for (const pack of packages)
    for (const item of pack.resources)
      if (!ids.has(item.id)) {
        resources.push(item);
        ids.add(item.id);
      }
  return resources;
}
export type MainInput = ModelInput & {
  imagePlacement?: {
    owner: 'writer' | 'jev';
    catalog?: { title?: string; description?: string; name?: string; tag?: string }[];
  };
  contextSummary?: NonNullable<ReturnType<typeof conversationSummary>>;
  pinnedSources?: {
    risuSource?: Resource['risuSource'];
    id: string;
    revision: number;
    kind: string;
    hash: string;
    text: string;
    loreContext?: LorePlacement;
    nativeRisuPosition?: import('./risu-native.js').NativeRisuLorePosition;
  }[];
  notes?: import('./notes.js').AuthorNote[];
  outline?: OutlineSnapshot;
  catalogPage?: { total: number; listed: number; remaining: string };
};
export function pinnedSlotSources(
  input: MainInput,
  slot: string
): NonNullable<MainInput['pinnedSources']> {
  const sources = (input.pinnedSources ?? []).filter((item) => !item.nativeRisuPosition);
  if (slot === 'references') return sources;
  if (slot === 'backgroundLore')
    return sources.filter((item) => item.loreContext?.placement !== 'scene');
  if (slot === 'sceneLore')
    return sources.filter((item) => item.loreContext?.placement === 'scene');
  if (slot === 'bot' || slot === 'description')
    return sources.filter((item) => item.kind === 'bot');
  if (slot === 'persona') return sources.filter((item) => item.kind === 'persona');
  if (slot === 'lore' || slot === 'lorebook')
    return sources.filter((item) => !['bot', 'persona', 'instruction'].includes(item.kind));
  return [];
}
export function buildMainInput(
  snapshot: RunSnapshot,
  results: readonly ToolEvent[] = [],
  packages?: readonly ResolvedPackage[]
): MainInput {
  if (
    snapshot.promptCompilation &&
    !PROMPT_COMPILER_VERSIONS.has(snapshot.promptCompilation.compilerVersion)
  )
    throw new Error('PROMPT_INVALID_COMPILED');
  packages ??= compiledPackages(snapshot, 'main');
  const resources = collectRoleResources(snapshot, packages);
  const input: MainInput = {
    role: 'main',
    contract: '',
    task: snapshot.nativeRisuExecution?.request ?? snapshot.request,
    facts: [],
    history: [],
    catalog: [],
    prefetch: [],
    tools: [...ALLOWED_TOOLS],
    results: structuredClone([...results]),
  };
  const packageData = packageContextFromCompiled(packages);
  if (snapshot.profile?.image) {
    input.imagePlacement = { owner: 'jev' };
    input.contract +=
      '\nJEV selects existing catalog images after writing. Write the narrative without catalog image tags; do not insert image placeholders.';
  } else if (snapshot.profile) {
    const profile = snapshot.profile;
    const assets =
      snapshot.imageCatalog ??
      packageImages(profile)
        .filter(
          (asset) =>
            asset.allowedUse !== 'profile' &&
            profile.packages?.find((pkg) => pkg.id === asset.packageOwner?.id)?.portraitImageId !==
              asset.packageOwner?.imageId
        )
        .map((asset) => ({
          ref: asset.id,
          alt: asset.title,
          caption: asset.description,
          url: asset.url,
        }));
    if (assets.length) {
      const nativeAssets = new Map<string, Map<string, RisuContentSource['assets'][number]>>();
      for (const pkg of profile.packages ?? []) {
        if (nativeAssets.has(pkg.id)) continue;
        const byImage = new Map<string, RisuContentSource['assets'][number]>();
        for (const entry of pkg.nativeRisu?.assets ?? [])
          if (!byImage.has(entry.imageId)) byImage.set(entry.imageId, entry);
        nativeAssets.set(pkg.id, byImage);
      }
      input.imagePlacement = {
        owner: 'writer',
        catalog: assets.map((asset) => {
          const owner = /^package:([^:]+):(bot|persona|module):([^:]+)$/u.exec(asset.ref);
          const pkg = owner && profile.packages?.find((entry) => entry.id === owner[1]);
          const native = owner ? nativeAssets.get(owner[1])?.get(owner[3]) : undefined;
          return {
            ...(asset.alt !== native?.name ? { title: asset.alt } : {}),
            ...(asset.caption ? { description: asset.caption } : {}),
            ...(native
              ? {
                  name: native.name,
                  ...(!pkg?.imageHandoff ? { tag: `{{img::${native.name}}}` } : {}),
                }
              : { tag: `![](${asset.url})` }),
          };
        }),
      };
      input.contract +=
        '\nYou select existing images while writing. Follow the authored image instructions and their tag syntax; imagePlacement in host context says which image names exist and how they are listed. Where an exact tag is supplied, use it at the intended position. Images are optional; use only existing images. No separate image model adds images afterward.';
    }
  }
  if (packageData) {
    const pinned = [
      ...packageData.pinned.map((r) => ({
        id: r.id,
        revision: r.revision,
        kind: r.sourceKind ?? r.kind,
        text: r.text,
        ...(r.risuSource ? { risuSource: structuredClone(r.risuSource) } : {}),
        ...(r.loreContext ? { loreContext: structuredClone(r.loreContext) } : {}),
        ...(r.nativeRisuPosition
          ? { nativeRisuPosition: structuredClone(r.nativeRisuPosition) }
          : {}),
      })),
    ].map((r) => ({ ...r, hash: hash(r.text) }));
    input.pinnedSources = [...(input.pinnedSources ?? []), ...pinned];
    input.facts.push(...pinned.map((r) => r.text));
  }
  if (input.pinnedSources) {
    const seen = new Set<string>();
    input.pinnedSources = input.pinnedSources.filter((item) => {
      const key = `${item.id}@${item.revision}:${item.hash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const policy =
      snapshot.loreContext?.policy ?? snapshot.profile?.loreContext ?? DEFAULT_LORE_CONTEXT;
    const used = input.pinnedSources.reduce(
      (sum, item) => sum + measureLoreText(item.text, countTextTokens),
      0
    );
    if (used > policy.maxPinnedTokens)
      throw Object.assign(
        new Error(
          'LORE_PINNED_BUDGET_EXCEEDED: 고정 자료가 설정한 토큰 한도를 초과했어요. 자료를 줄이거나 고정 자료 한도를 조정해 주세요.'
        ),
        { statusCode: 409 }
      );
    input.facts = input.pinnedSources
      .filter((item) => item.kind !== 'skill')
      .map((item) => item.text);
  }
  if (snapshot.story?.notes.length) {
    input.notes = structuredClone(snapshot.story.notes);
    input.contract += '\n' + AUTHOR_NOTE_GUIDANCE;
  }
  input.history = validateSourceHistory(snapshot)
    .filter((entry) => entry.sceneContext?.sceneEnabled !== false)
    .map(({ revision, text, contentHash }) => ({
      revision,
      text: projectStoryUiText(text),
      contentHash,
    }));
  input.tools.push(...STORY_READ_NAMES);
  if (snapshot.contextPlan) {
    const kept = new Set(snapshot.contextPlan.recentSourceRevisions);
    input.history = input.history.filter((entry) => kept.has(entry.revision));
    input.contextSummary = conversationSummary(snapshot);
  }
  if (snapshot.outline) {
    input.outline = structuredClone(snapshot.outline);
    input.contract += `\n${outlineContract(snapshot.outline)}`;
  }
  const visibleHistory = projectedLogicalHistory(
    snapshot,
    selectLogicalHistory(snapshot, input.history),
    false
  );
  const rankedIds = createCandidateSearch(
    resources.map((item) => ({
      id: item.id,
      title: item.title,
      text: `${item.id} ${item.description}`,
    }))
  ).rankMatched([
    { text: input.task, weight: 3 },
    ...visibleHistory.slice(-3).map((entry) => ({ text: entry.text, weight: 0.5 })),
    ...(input.contextSummary ? [{ text: input.contextSummary.text, weight: 0.5 }] : []),
  ]);
  const byId = new Map(resources.map((item) => [item.id, item]));
  const rankedSet = new Set(rankedIds);
  const catalogResources = [
    ...rankedIds.map((id) => byId.get(id)!),
    ...resources.filter((item) => !rankedSet.has(item.id)),
  ];
  Object.assign(
    input,
    resourceCatalog(catalogResources, {
      skipOversized: true,
      tokenizer:
        snapshot.contextPlan && 'tokenizer' in snapshot.contextPlan.budget
          ? snapshot.contextPlan.budget.tokenizer
          : undefined,
    })
  );
  return input;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('Run cancelled'), { name: 'AbortError' });
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    return null;
  return value as number;
}

function relevantBodyOffset(text: string, terms: readonly string[]): number | undefined {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let normalized = '';
  const originalOffsets: number[] = [];
  for (const part of segmenter.segment(text)) {
    const value = part.segment.normalize('NFC').toLowerCase();
    normalized += value;
    for (let i = 0; i < value.length; i++) originalOffsets.push(part.index);
  }
  let earliest = Infinity;
  for (const term of terms) {
    const index = normalized.indexOf(term);
    if (index >= 0) earliest = Math.min(earliest, originalOffsets[index]!);
  }
  return Number.isFinite(earliest) ? earliest : undefined;
}

export type ToolAction = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  recoveredFromTruncation?: boolean;
};

export type KnowledgeReadResult = {
  source: Pick<Resource, 'id' | 'revision' | 'kind' | 'sourceKind'> & {
    hash: string;
    reference: string;
  };
  range: { start: number; end: number; unit: 'utf16-code-unit' };
  totalChars: number;
  nextOffset: number | null;
  text: string;
};
function readResourceRange(
  resource: Resource,
  offset: number,
  limit: number,
  role: string
): KnowledgeReadResult {
  const end = Math.min(resource.text.length, offset + limit);
  return {
    source: {
      id: resource.id,
      kind: resource.kind,
      ...(role === 'translation' && resource.sourceKind ? { sourceKind: resource.sourceKind } : {}),
      revision: resource.revision,
      hash: hash(resource.text),
      reference: `resource:${resource.id}@${resource.revision}#chars=${offset}-${end}`,
    },
    range: { start: offset, end, unit: 'utf16-code-unit' },
    totalChars: resource.text.length,
    text: resource.text.slice(offset, end),
    nextOffset: end < resource.text.length ? end : null,
  };
}
export function knowledgeReadResults(event: ToolEvent): KnowledgeReadResult[] {
  if (event.denied || event.name !== 'knowledge.read') return [];
  const data = event.result as { items?: unknown[] };
  if (!Array.isArray(data.items)) return [];
  return data.items.flatMap((item) => {
    const entry = item as { denied?: boolean; read?: KnowledgeReadResult };
    return entry.denied === false && entry.read ? [entry.read] : [];
  });
}

export function executeTool(
  snapshot: RunSnapshot,
  action: ToolAction,
  signal?: AbortSignal,
  role: 'main' | 'translation' | 'image' = 'main',
  budget?: ReadBudget
): ToolEvent {
  checkAbort(signal);
  const profile =
    budget?.tokenizer ??
    (snapshot.contextPlan && 'tokenizer' in snapshot.contextPlan.budget
      ? snapshot.contextPlan.budget.tokenizer
      : undefined) ??
    'openai-o200k';
  const readBudget: ReadBudget = budget ?? { tokens: KNOWLEDGE_READ_TOKENS, tokenizer: profile };
  if ((role === 'main' || role === 'translation') && STORY_READ_NAMES.includes(action.name))
    return executeStoryRead(snapshot, action);
  const denied = (code: string): ToolEvent => ({
    callId: action.callId,
    name: ALLOWED_TOOLS.includes(action.name) ? action.name : 'unapproved',
    args: {},
    result: { code },
    denied: true,
    ...(['INVALID_ARGUMENTS', 'RESOURCE_UNAVAILABLE', 'TOKEN_LIMIT_TOO_SMALL'].includes(code)
      ? { errorKind: 'recoverable' as const }
      : {}),
  });
  if (!ALLOWED_TOOLS.includes(action.name)) return denied('TOOL_NOT_ALLOWED');
  const { args } = action;
  if (action.name === 'knowledge.search' && args.mode === 'browse') {
    let browsers = knowledgeBrowsers.get(snapshot);
    if (!browsers) knowledgeBrowsers.set(snapshot, (browsers = new Map()));
    let browse = browsers.get(role);
    if (!browse) {
      browse = createKnowledgeBrowser(roleResources(snapshot, role), {
        chatId: snapshot.chatId,
        role,
        tokenizer: profile,
      });
      browsers.set(role, browse);
    }
    return browse(action);
  }
  const scope = roleResources(snapshot, role);
  const tokenReadSize = (
    text: string,
    offset: number,
    limit: number | undefined,
    tokens: number
  ) => {
    let end = limit === undefined ? text.length : Math.min(text.length, offset + limit);
    if (
      end > offset &&
      end < text.length &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]) &&
      /[\uDC00-\uDFFF]/u.test(text[end])
    )
      end--;
    return textTokenExcerpt(text.slice(offset, end), tokens, { marker: '', profile }).text.length;
  };

  if (action.name === 'knowledge.read') {
    if (
      !Number.isSafeInteger(readBudget.tokens) ||
      readBudget.tokens < KNOWLEDGE_READ_TOKENS ||
      readBudget.tokens > KNOWLEDGE_READ_MAX_TOKENS ||
      !isTokenizerProfileId(readBudget.tokenizer)
    )
      throw new Error('INVALID_KNOWLEDGE_READ_BUDGET');
    if (
      Object.keys(args).some((key) => !['ids', 'offset', 'limit', 'tokenLimit'].includes(key)) ||
      !Array.isArray(args.ids) ||
      args.ids.length < 1 ||
      args.ids.length > 16 ||
      args.ids.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
      new Set(args.ids).size !== args.ids.length
    )
      return denied('INVALID_ARGUMENTS');

    const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = args.limit === undefined ? undefined : pageNumber(args.limit, 4096, 4096);
    const tokenLimit = pageNumber(args.tokenLimit, KNOWLEDGE_ITEM_TOKENS, 8000);
    if (offset === null || limit === null || limit === 0 || tokenLimit === null || tokenLimit === 0)
      return denied('INVALID_ARGUMENTS');
    const fits = () => countTextTokens(JSON.stringify(result()), profile) <= readBudget.tokens;

    const ids = args.ids;
    const frozenRanges = readBudget.ranges;
    if (
      frozenRanges &&
      (!Array.isArray(frozenRanges) ||
        !frozenRanges.length ||
        frozenRanges.length > ids.length ||
        frozenRanges.some((end) => end !== null && (!Number.isSafeInteger(end) || end < offset)))
    )
      throw new Error('INVALID_KNOWLEDGE_READ_BUDGET');
    const items: unknown[] = [];
    const result = () => ({
      items,
      total: ids.length,
      nextIndex: items.length < ids.length ? items.length : null,
    });
    for (const id of args.ids) {
      const resource = scope.find((item) => item.id === id && item.kind === 'lore');
      const entry = (size: number) =>
        !resource
          ? { id, denied: true, error: { code: 'RESOURCE_UNAVAILABLE' } }
          : offset > resource.text.length
            ? { id, denied: true, error: { code: 'INVALID_ARGUMENTS' } }
            : {
                id,
                denied: false,
                read: readResourceRange(
                  resource,
                  offset,
                  size > 0 &&
                    /[\uD800-\uDBFF]/u.test(resource.text[offset + size - 1] ?? '') &&
                    /[\uDC00-\uDFFF]/u.test(resource.text[offset + size] ?? '')
                    ? size - 1
                    : size,
                  role
                ),
              };
      const frozenEnd = frozenRanges?.[items.length];
      if (frozenRanges && items.length === frozenRanges.length) break;
      if (
        frozenRanges &&
        resource &&
        offset <= resource.text.length &&
        (frozenEnd === null ||
          frozenEnd === undefined ||
          frozenEnd > resource.text.length ||
          (limit !== undefined && frozenEnd > offset + limit))
      )
        throw new Error('INVALID_KNOWLEDGE_READ_BUDGET');
      if (frozenRanges && (!resource || offset > resource.text.length) && frozenEnd !== null)
        throw new Error('INVALID_KNOWLEDGE_READ_BUDGET');
      const size = frozenRanges
        ? (frozenEnd ?? offset) - offset
        : resource && offset <= resource.text.length
          ? tokenReadSize(resource.text, offset, limit, tokenLimit)
          : 0;
      if (!frozenRanges && resource && offset < resource.text.length && size === 0)
        return denied('TOKEN_LIMIT_TOO_SMALL');
      items.push(entry(size));
      if (frozenRanges || fits()) continue;
      items.pop();
      if (items.length) break;
      let low = 1;
      let high = size;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        items[0] = entry(middle);
        if (fits()) low = middle;
        else high = middle - 1;
      }
      items[0] = entry(low);
      if (!fits()) return denied('RESULT_METADATA_TOO_LARGE');
      break;
    }
    return {
      ...action,
      args: {
        ids: args.ids,
        offset,
        ...(limit === undefined ? {} : { limit }),
        tokenLimit,
      },
      denied: false,
      result: result(),
      readBudget: {
        ...readBudget,
        ranges: items.map(
          (item) => (item as { read?: KnowledgeReadResult }).read?.range.end ?? null
        ),
      },
    };
  }

  if (
    args.mode !== undefined &&
    (action.name !== 'knowledge.search' || !['search', 'relevant'].includes(args.mode as string))
  )
    return denied('INVALID_ARGUMENTS');
  const search = action.name === 'knowledge.search' || action.name === 'skills.list';
  if (
    Object.keys(args).some(
      (key) =>
        !(
          search
            ? action.name === 'knowledge.search'
              ? ['mode', 'query', 'offset', 'limit']
              : ['query', 'offset', 'limit']
            : ['id', 'offset', 'limit', 'tokenLimit']
        ).includes(key)
    )
  )
    return denied('INVALID_ARGUMENTS');

  if (search) {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 512))
      return denied('INVALID_ARGUMENTS');
    const query = typeof args.query === 'string' ? args.query : '';
    const relevant = action.name === 'knowledge.search' && args.mode === 'relevant';
    if (relevant && !query.trim()) return denied('INVALID_ARGUMENTS');
    const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = pageNumber(args.limit, 20, 100);
    if (offset === null || limit === null || limit === 0) return denied('INVALID_ARGUMENTS');

    const terms = query.toLocaleLowerCase('en').split(/\s+/u).filter(Boolean);
    let matches = scope.filter((item) => {
      if (action.name === 'skills.list' && item.kind !== 'skill') return false;
      if (relevant) return true;
      if (!terms.length) return true;
      const metadataText = `${item.title} ${item.description}`.toLocaleLowerCase('en');
      const body = item.text.toLocaleLowerCase('en');
      return terms.every((term) => metadataText.includes(term) || body.includes(term));
    });
    const literalTerms = relevant
      ? query.normalize('NFC').toLowerCase().split(/\s+/u).filter(Boolean)
      : [];
    const relevantTerms = relevant ? [...new Set([...candidateTerms(query), ...literalTerms])] : [];
    if (relevant) {
      const byId = new Map(scope.map((item) => [item.id, item]));
      const ids = createCandidateSearch(
        scope.map((item) => ({
          id: item.id,
          title: item.title,
          text: `${item.id} ${item.description} ${item.text}`,
        }))
      ).rankMatched([{ text: query, weight: 1 }]);
      const ranked = new Set(ids);
      for (const item of scope) {
        if (ranked.has(item.id)) continue;
        const searchable = `${item.id} ${item.title} ${item.description} ${item.text}`
          .normalize('NFC')
          .toLowerCase();
        if (literalTerms.every((term) => searchable.includes(term))) ids.push(item.id);
      }
      const exact = query.trim().normalize('NFC').toLowerCase();
      matches = ids
        .map((id) => byId.get(id)!)
        .sort((a, b) => {
          const isExact = (item: Resource) =>
            [item.title, item.id].some(
              (value) => value.trim().normalize('NFC').toLowerCase() === exact
            );
          return Number(isExact(b)) - Number(isExact(a));
        });
    }
    const allowedIds = new Set(scope.map((item) => item.id));
    const patterns =
      action.name === 'knowledge.search'
        ? terms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'))
        : [];
    const items: unknown[] = [];
    const result = () => ({
      items,
      total: matches.length,
      nextOffset: offset + items.length < matches.length ? offset + items.length : null,
    });
    for (const item of matches.slice(offset, offset + limit)) {
      const entry: Record<string, unknown> = scopedMetadata(item, allowedIds);
      const nextRead = {
        name: item.kind === 'skill' ? 'skills.load' : 'knowledge.read',
        arguments: {
          ...(item.kind === 'skill' ? { id: item.id } : { ids: [item.id] }),
          offset: 0,
          tokenLimit: KNOWLEDGE_ITEM_TOKENS,
        },
      };
      let index = relevant ? (relevantBodyOffset(item.text, relevantTerms) ?? Infinity) : Infinity;
      for (const pattern of patterns) {
        const found = pattern.exec(item.text);
        if (found) index = Math.min(index, found.index);
      }
      if (Number.isFinite(index)) {
        let start =
          index -
          textTokenExcerpt(item.text.slice(0, index), 30, { side: 'end', marker: '', profile }).text
            .length;
        if (start && /[\uDC00-\uDFFF]/u.test(item.text[start]!)) start--;
        let end =
          start +
          textTokenExcerpt(item.text.slice(start), 120, { marker: '', profile }).text.length;
        if (end < item.text.length && /[\uDC00-\uDFFF]/u.test(item.text[end]!)) end--;
        entry.match = readResourceRange(item, start, end - start, role);
        nextRead.arguments.offset = start;
        entry.nextRead = nextRead;
      }
      if (relevant && !entry.nextRead) entry.nextRead = nextRead;
      if (
        action.name === 'knowledge.search' &&
        countTextTokens(JSON.stringify({ ...result(), items: [entry] }), profile) >
          KNOWLEDGE_SEARCH_TOKENS
      ) {
        const relatedIds = (entry.relatedIds ?? []) as string[];
        entry.description = summary(item.description, profile);
        if (relatedIds.length) entry.relatedIds = relatedIds.slice(0, 20);
        entry.metadataPreview = {
          description: {
            totalChars: item.description.length,
            returnedChars: String(entry.description).length,
          },
          relatedIds: { total: relatedIds.length, returned: Math.min(20, relatedIds.length) },
        };
        entry.nextRead = nextRead;
      }
      items.push(entry);
      if (
        action.name === 'knowledge.search' &&
        countTextTokens(JSON.stringify(result()), profile) > KNOWLEDGE_SEARCH_TOKENS
      ) {
        items.pop();
        if (!items.length) return denied('RESULT_METADATA_TOO_LARGE');
        break;
      }
    }
    return {
      ...action,
      args: { ...(relevant ? { mode: 'relevant' } : {}), query, offset, limit },
      denied: false,
      result: result(),
    };
  }

  if (typeof args.id !== 'string' || !args.id || args.id.length > 200)
    return denied('INVALID_ARGUMENTS');
  const resource = scope.find((item) => item.id === args.id && item.kind === 'skill');
  if (!resource) return denied('RESOURCE_UNAVAILABLE');

  const offset = pageNumber(args.offset, 0, resource.text.length);
  const limit = args.limit === undefined ? undefined : pageNumber(args.limit, 4096, 16384);
  const tokenLimit = pageNumber(args.tokenLimit, KNOWLEDGE_ITEM_TOKENS, 8000);
  if (offset === null || limit === null || limit === 0 || tokenLimit === null || tokenLimit === 0)
    return denied('INVALID_ARGUMENTS');
  const size = tokenReadSize(resource.text, offset, limit, tokenLimit);
  if (offset < resource.text.length && size === 0) return denied('TOKEN_LIMIT_TOO_SMALL');
  return {
    ...action,
    args: { id: resource.id, offset, ...(limit === undefined ? {} : { limit }), tokenLimit },
    denied: false,
    result: readResourceRange(resource, offset, size, role),
  };
}
