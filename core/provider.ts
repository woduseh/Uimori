import { KNOWLEDGE_SKILL_TOOLS } from './read-tools.js';
import { createHash } from 'node:crypto';
import { conversationSummary } from './context-projection.js';
import type { ModelInput, Resource, RunSnapshot, ToolEvent } from './types.js';
import { executeStoryRead, STORY_READ_NAMES } from './story-context.js';
import { validateSourceHistory } from './source-history.js';
import {
  compiledPackages,
  packageContextFromCompiled,
  type ResolvedPackage,
} from './package-context.js';
import { DEFAULT_LORE_CONTEXT, measureLoreText, type LorePlacement } from './lore-context.js';
import { countTextTokens } from './text-tokens.js';
import { OUTLINE_CONTRACT, type OutlineSnapshot } from './outline.js';
import { AUTHOR_NOTE_GUIDANCE } from './notes.js';
import { PROMPT_COMPILER_VERSIONS, type PromptCompilerVersion } from './risu-prompt.js';

// These are host permissions, never instructions read from a content package.
const ALLOWED_TOOLS = KNOWLEDGE_SKILL_TOOLS.map((tool) => tool.name);
/** Per-entry summary length in the main catalog; the body stays behind the read tools. */
export const CATALOG_SUMMARY_CHARS = 160;
/** Serialized length budget for the whole catalog list, which rides in every main request. */
export const CATALOG_CHARS = 24_000;
export const CATALOG_READ_GUIDANCE =
  'Relevant references may already be included in the input; do not read them again. The catalog contains summaries of additional references. If the reply needs missing detail, fetch known ids with knowledge.read({ids:[...]}), using a one-item array for a single reference. Use knowledge.search only when the needed entry is not identifiable from the catalog. Retrieval is optional when the supplied context is sufficient.';

const metadata = ({ text: _text, chatId: _chatId, ...item }: Resource) => item;
const scopedMetadata = (item: Resource, allowedIds: Set<string>) => ({
  ...metadata(item),
  ...(item.relatedIds ? { relatedIds: item.relatedIds.filter((id) => allowedIds.has(id)) } : {}),
});
const summary = (text: string) =>
  text.length > CATALOG_SUMMARY_CHARS ? text.slice(0, CATALOG_SUMMARY_CHARS - 1) + '…' : text;
/** Discovery metadata only: identity, a short summary and the scoped relations. */
const catalogEntry = (
  item: Resource,
  allowedIds: Set<string>
): Omit<Resource, 'text' | 'chatId'> => {
  const pinned = item.loading === 'pinned';
  return {
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    title: item.title,
    // A pinned body already reaches the request; its summary would only repeat it.
    description: pinned ? '' : summary(item.description),
    ...(item.sourceKind ? { sourceKind: item.sourceKind } : {}),
    ...(pinned ? { loading: 'pinned' as const } : {}),
    ...(item.relatedIds ? { relatedIds: item.relatedIds.filter((id) => allowedIds.has(id)) } : {}),
  };
};
/** Entries that fit the serialized budget; the first entry is always listed. */
const budgetedCatalogLength = (catalog: MainInput['catalog']) => {
  let used = 1, // the enclosing brackets, less the separator the first entry does not need
    listed = 0;
  for (const item of catalog) {
    used += JSON.stringify(item).length + 1;
    if (listed && used > CATALOG_CHARS) break;
    listed++;
  }
  return listed;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function roleResources(
  snapshot: RunSnapshot,
  role: 'main' | 'translation' | 'status' | 'image' = 'main'
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
/** Slot bodies and fallback suppression share this exact source selection. */
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
/** Fixed contract, provenance-bearing pinned content, catalog and observed reads stay separate. */
export function buildMainInput(
  snapshot: RunSnapshot,
  results: readonly ToolEvent[] = [],
  options: { compilerVersion?: PromptCompilerVersion } = {}
): MainInput {
  if (
    options.compilerVersion !== undefined &&
    !PROMPT_COMPILER_VERSIONS.has(options.compilerVersion)
  )
    throw new Error('PROMPT_INVALID_COMPILED');
  const packages = compiledPackages(snapshot, 'main'),
    resources = collectRoleResources(snapshot, packages);
  const allowedIds = new Set(resources.map((item) => item.id));
  const input: MainInput = {
    role: 'main',
    contract: '',
    task: snapshot.nativeRisuExecution?.request ?? snapshot.request,
    facts: [],
    history: structuredClone(snapshot.history),
    catalog: resources.map((item) => catalogEntry(item, allowedIds)),
    prefetch: [],
    tools: [...ALLOWED_TOOLS],
    results: structuredClone([...results]),
  };
  const packageData = packageContextFromCompiled(packages);
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
  input.history = validateSourceHistory(snapshot);
  input.tools.push(...STORY_READ_NAMES);
  if (snapshot.contextPlan) {
    const kept = new Set(snapshot.contextPlan.recentSourceRevisions);
    input.history = structuredClone(input.history.filter((entry) => kept.has(entry.revision)));
    input.contextSummary = conversationSummary(snapshot);
  }
  if (snapshot.outline) {
    input.outline = structuredClone(snapshot.outline);
    input.contract += `\n${OUTLINE_CONTRACT}`;
  }
  // The catalog rides uncached in every request, so a large library is listed only up to a
  // character budget. The rest stays reachable through the read tools.
  const total = input.catalog.length,
    listed = budgetedCatalogLength(input.catalog);
  if (listed < total) {
    input.catalogPage = {
      total,
      listed,
      remaining:
        'Use knowledge.search or skills.list with pagination to discover the full approved scope.',
    };
    input.catalog = input.catalog.slice(0, listed);
  }
  return input;
}

function checkAbort(signal?: AbortSignal) {
  // Abort reasons may include a caller's data. Do not echo them into a run error.
  if (signal?.aborted) throw Object.assign(new Error('Run cancelled'), { name: 'AbortError' });
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    return null;
  return value as number;
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
/** Callers verify the full event against executeTool before treating these as durable receipts. */
export function knowledgeReadResults(event: ToolEvent): KnowledgeReadResult[] {
  if (event.denied || event.name !== 'knowledge.read') return [];
  const data = event.result as { items?: unknown[] };
  if (!Array.isArray(data.items)) return [];
  return data.items.flatMap((item) => {
    const entry = item as { denied?: boolean; read?: KnowledgeReadResult };
    return entry.denied === false && entry.read ? [entry.read] : [];
  });
}

/** Execute a reusable read action against the immutable Run's local corpus. */
export function executeTool(
  snapshot: RunSnapshot,
  action: ToolAction,
  signal?: AbortSignal,
  role: 'main' | 'translation' | 'status' | 'image' = 'main'
): ToolEvent {
  checkAbort(signal);
  if ((role === 'main' || role === 'translation') && STORY_READ_NAMES.includes(action.name))
    return executeStoryRead(snapshot, action);
  const denied = (code: string): ToolEvent => ({
    callId: action.callId,
    name: ALLOWED_TOOLS.includes(action.name) ? action.name : 'unapproved',
    args: {},
    result: { code },
    denied: true,
    ...(['INVALID_ARGUMENTS', 'RESOURCE_UNAVAILABLE'].includes(code)
      ? { errorKind: 'recoverable' as const }
      : {}),
  });
  if (!ALLOWED_TOOLS.includes(action.name)) return denied('TOOL_NOT_ALLOWED');
  // Scope applies before search, counts, pagination, and individual reads alike.
  const scope = roleResources(snapshot, role);
  const { args } = action;

  if (action.name === 'knowledge.read') {
    if (
      Object.keys(args).some((key) => !['ids', 'offset', 'limit'].includes(key)) ||
      !Array.isArray(args.ids) ||
      args.ids.length < 1 ||
      args.ids.length > 16 ||
      args.ids.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
      new Set(args.ids).size !== args.ids.length
    )
      return denied('INVALID_ARGUMENTS');

    const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = pageNumber(args.limit, 4096, 4096);
    if (offset === null || limit === null || limit === 0) return denied('INVALID_ARGUMENTS');

    const items = args.ids.map((id) => {
      const resource = scope.find((item) => item.id === id && item.kind === 'lore');
      if (!resource) return { id, denied: true, error: { code: 'RESOURCE_UNAVAILABLE' } };
      if (offset > resource.text.length)
        return { id, denied: true, error: { code: 'INVALID_ARGUMENTS' } };

      return { id, denied: false, read: readResourceRange(resource, offset, limit, role) };
    });
    return { ...action, args: { ids: args.ids, offset, limit }, denied: false, result: { items } };
  }

  const search = action.name === 'knowledge.search' || action.name === 'skills.list';
  if (
    Object.keys(args).some(
      (key) => !(search ? ['query', 'offset', 'limit'] : ['id', 'offset', 'limit']).includes(key)
    )
  )
    return denied('INVALID_ARGUMENTS');

  if (search) {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 512))
      return denied('INVALID_ARGUMENTS');
    const query = typeof args.query === 'string' ? args.query : '';
    const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = pageNumber(args.limit, 20, 100);
    if (offset === null || limit === null || limit === 0) return denied('INVALID_ARGUMENTS');

    const terms = query.toLocaleLowerCase('en').split(/\s+/u).filter(Boolean);
    const matches = scope.filter(
      (item) =>
        (action.name !== 'skills.list' || item.kind === 'skill') &&
        terms.every((term) =>
          `${item.title} ${item.description} ${item.text}`.toLocaleLowerCase('en').includes(term)
        )
    );
    const allowedIds = new Set(scope.map((item) => item.id));
    const items = matches
      .slice(offset, offset + limit)
      .map((item) => scopedMetadata(item, allowedIds));
    return {
      ...action,
      args: { query, offset, limit },
      denied: false,
      result: {
        items,
        total: matches.length,
        nextOffset: offset + items.length < matches.length ? offset + items.length : null,
      },
    };
  }

  if (typeof args.id !== 'string' || !args.id || args.id.length > 200)
    return denied('INVALID_ARGUMENTS');
  const resource = scope.find((item) => item.id === args.id && item.kind === 'skill');
  if (!resource) return denied('RESOURCE_UNAVAILABLE');

  const offset = pageNumber(args.offset, 0, resource.text.length);
  const limit = pageNumber(args.limit, 4096, 16384);
  if (offset === null || limit === null || limit === 0) return denied('INVALID_ARGUMENTS');
  return {
    ...action,
    args: { id: resource.id, offset, limit },
    denied: false,
    result: readResourceRange(resource, offset, limit, role),
  };
}
