import { imageCatalogPage, imageMetadata, type ImageMetadata } from './image-catalog.js';
import { createDefaultPromptProgram } from './prompt-defaults.js';
import { createHash } from 'node:crypto';
import { executeTool, type ToolAction } from './provider.js';
import type { Resource, RunSnapshot, ToolEvent } from './types.js';
import { DEFAULT_TRANSLATION_PROMPT } from './prompts.js';
import {
  segmentTranslationMarkers,
  parseSourceSegments,
  type SegmentKnowledge,
  type SegmentRange,
  type SourceSegmentPolicy,
} from './source-segments.js';
import { compilePromptProgram, type PromptCompilation } from './prompt-program.js';
import { executionContext } from './execution-context.js';
import { STORY_READ_NAMES } from './story-context.js';
import { TRANSLATION_READ_NAMES } from './translation-context.js';
import {
  compiledPackages,
  packageContext,
  packageSlots,
  type PackageRoleContext,
} from './package-context.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export type AuxiliarySource = { id: string; chatId: string; text: string; hash: string };
export type VersionedText = { id: string; revision: string | number; text: string };
/** Host projects the originating Run snapshot here, never the currently selected chat. */
export type SourceTimeContext = {
  sourceSegments?: SourceSegmentPolicy;
  packages?: PackageRoleContext;
  revision: string;
  bot: VersionedText | null;
  persona: VersionedText | null;
  references: VersionedText[];
  scene: string;
  previousSources: { revision: string; text: string }[];
  instructionRevision: string;
  modelPresetRevision: string;
  protectedLiterals?: string[];
  segmentKnowledge?: {
    sourceRevision: string;
    sourceHash: string;
    provenance: 'source-markers';
    segments: {
      id: string;
      kind: 'main' | 'aside' | 'annotation';
      range: SegmentRange;
      readerExposure: 'present-in-source';
      actorKnowledge: SegmentKnowledge;
      worldTruth: 'unknown';
    }[];
  };
};
export type SourceBlock = {
  anchor: string;
  index: number;
  start: number;
  end: number;
  text: string;
};
export type ProtectedSpan = {
  token: string;
  literal: string;
  anchor: string;
  start: number;
  end: number;
};
export type TranslationChunk = {
  id: string;
  index: number;
  anchors: string[];
  blocks: { anchor: string; text: string }[];
  protectedSpans: ProtectedSpan[];
};
export type TranslationPlan = {
  maxChunkChars: number | null;
  sourceRevision: string;
  sourceHash: string;
  chatId: string;
  context: SourceTimeContext;
  blocks: SourceBlock[];
  chunks: TranslationChunk[];
};
export type TranslationSegment = { anchors: string[]; text: string };
export type TranslationResult = {
  sourceRevision: string;
  sourceHash: string;
  chunkId: string;
  segments: TranslationSegment[];
};

export function validateSourceIdentity(source: AuxiliarySource) {
  if (!source.id || !source.chatId || !source.text.trim() || digest(source.text) !== source.hash)
    throw new Error('SOURCE_IDENTITY_INVALID');
}
/** Blank-line paragraph anchors are revision-scoped and preserve exact UTF-16 offsets. */
export function splitSource(source: AuxiliarySource): SourceBlock[] {
  validateSourceIdentity(source);
  const blocks: SourceBlock[] = [];
  // Fenced code may itself contain blank lines, so a fence is one source block.
  const lines = source.text.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  let offset = 0;
  let start: number | null = null;
  let end = 0;
  let fence: string | null = null;
  const emit = () => {
    if (start === null) return;
    const text = source.text.slice(start, end);
    if (text.trim())
      blocks.push({
        anchor: `b-${digest(source.id).slice(0, 10)}-${blocks.length}-${digest(text).slice(0, 10)}`,
        index: blocks.length,
        start,
        end,
        text,
      });
    start = null;
  };
  for (const line of lines) {
    const body = line.replace(/(?:\r\n|\n|\r)$/, '');
    const marker = body.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (!fence && !body.trim()) emit();
    else {
      if (start === null) start = offset;
      end = offset + body.length;
      if (marker && !fence) fence = marker;
      else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
    }
    offset += line.length;
  }
  emit();
  return blocks;
}

// Deliberately lexical protection. Extra enum/identifier literals can be supplied
// by the typed module; this does not claim arbitrary programming-language parsing.
const syntax =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`]*`+|\[\[p_[a-f0-9]+_\d+\]\]|"(?:[^"\\]|\\.)+"(?=\s*:)|(?<="(?:status|state|mode|kind|type|enum|id|assetRef)"\s*:\s*)"(?:[^"\\]|\\.)*"|\b(?:asset|resource):[\w.:/@#-]+|\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[A-Z][A-Z0-9_]{1,}\b|(?<![\w])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?(?![\w])/gu;
function protect(
  block: SourceBlock,
  sourceHash: string,
  literals: string[],
  sequence: { value: number }
) {
  const ranges: { start: number; end: number }[] = [...block.text.matchAll(syntax)].map(
    (match) => ({ start: match.index, end: match.index + match[0].length })
  );
  for (const literal of literals) {
    if (!literal) continue;
    for (
      let index = block.text.indexOf(literal);
      index >= 0;
      index = block.text.indexOf(literal, index + literal.length)
    )
      ranges.push({ start: index, end: index + literal.length });
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const spans: ProtectedSpan[] = merged.map((range) => ({
    ...range,
    anchor: block.anchor,
    literal: block.text.slice(range.start, range.end),
    token: `[[p_${sourceHash.slice(0, 16)}_${sequence.value++}]]`,
  }));
  let cursor = 0;
  let text = '';
  for (const span of spans) {
    text += block.text.slice(cursor, span.start) + span.token;
    cursor = span.end;
  }
  return { text: text + block.text.slice(cursor), spans };
}

export function createTranslationPlan(
  source: AuxiliarySource,
  context: SourceTimeContext,
  maxChunkChars: number | null = 3000
): TranslationPlan {
  if (
    maxChunkChars !== null &&
    (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 100 || maxChunkChars > 24000)
  )
    throw new Error('INVALID_CHUNK_LIMIT');
  const blocks = splitSource(source);
  const sequence = { value: 0 };
  const chunks: TranslationChunk[] = [];
  const segmentSource = { sourceRevision: source.id, sourceHash: source.hash, text: source.text };
  const document = parseSourceSegments(segmentSource, context.sourceSegments);
  if (
    document.segments.some((segment) => segment.kind !== 'main') ||
    document.diagnostics.some((item) => item.severity === 'error')
  ) {
    // Translation receives every source segment. Reader visibility does not establish
    // actor knowledge or world truth, and generated prose cannot supply declarations.
    context = {
      ...context,
      protectedLiterals: [
        ...new Set([
          ...(context.protectedLiterals ?? []),
          ...segmentTranslationMarkers(segmentSource, context.sourceSegments).flatMap((marker) => [
            marker.literal,
            marker.literal.replace(/[\r\n]+$/u, ''),
          ]),
        ]),
      ],
      segmentKnowledge: {
        sourceRevision: source.id,
        sourceHash: source.hash,
        provenance: 'source-markers',
        segments: document.segments.map((segment) => ({
          id: segment.id,
          kind: segment.kind,
          range: { ...segment.range },
          readerExposure: 'present-in-source',
          actorKnowledge: structuredClone(segment.knowledge),
          worldTruth: 'unknown',
        })),
      },
    };
  }
  let size = 0;
  for (const block of blocks) {
    let chunk = chunks.at(-1);
    // Whole paragraphs remain intact; an oversized paragraph is a single chunk.
    if (!chunk || (maxChunkChars !== null && size && size + block.text.length > maxChunkChars)) {
      chunk = {
        id: `t-${source.hash.slice(0, 12)}-${chunks.length}`,
        index: chunks.length,
        anchors: [],
        blocks: [],
        protectedSpans: [],
      };
      chunks.push(chunk);
      size = 0;
    }
    const protectedBlock = protect(block, source.hash, context.protectedLiterals ?? [], sequence);
    chunk.anchors.push(block.anchor);
    chunk.blocks.push({ anchor: block.anchor, text: protectedBlock.text });
    chunk.protectedSpans.push(...protectedBlock.spans);
    size += block.text.length;
  }
  return structuredClone({
    maxChunkChars,
    sourceRevision: source.id,
    sourceHash: source.hash,
    chatId: source.chatId,
    context,
    blocks,
    chunks,
  });
}
/** Persisted/imported plans are derived data: recheck them against the actual source. */
export function validateTranslationPlan(
  source: AuxiliarySource,
  context: SourceTimeContext,
  value: unknown
): TranslationPlan {
  try {
    const plan = value as TranslationPlan;
    if (!plan || !Object.hasOwn(plan, 'maxChunkChars')) throw new Error();
    const expected = createTranslationPlan(source, context, plan.maxChunkChars);
    if (
      !plan ||
      plan.sourceRevision !== source.id ||
      plan.sourceHash !== source.hash ||
      plan.chatId !== source.chatId ||
      JSON.stringify(plan.context) !== JSON.stringify(expected.context) ||
      JSON.stringify(plan.blocks) !== JSON.stringify(expected.blocks) ||
      !Array.isArray(plan.chunks) ||
      !plan.chunks.length
    )
      throw new Error();
    for (const [index, chunk] of plan.chunks.entries()) {
      if (
        chunk.index !== index ||
        chunk.id !== `t-${source.hash.slice(0, 12)}-${index}` ||
        !Array.isArray(chunk.blocks) ||
        !chunk.blocks.length ||
        !Array.isArray(chunk.protectedSpans) ||
        JSON.stringify(chunk.anchors) !== JSON.stringify(chunk.blocks.map((block) => block.anchor))
      )
        throw new Error();
    }
    if (
      plan.maxChunkChars !== expected.maxChunkChars ||
      JSON.stringify(plan.chunks) !== JSON.stringify(expected.chunks)
    )
      throw new Error();
    return structuredClone(plan);
  } catch {
    throw new Error('SOURCE_TRANSLATION_PLAN_INVALID');
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OUTPUT_SCHEMA_INVALID');
  return value as Record<string, unknown>;
};
const parsed = (value: unknown) => {
  try {
    return object(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    throw new Error('OUTPUT_SCHEMA_INVALID');
  }
};
const only = (value: Record<string, unknown>, fields: string[]) => {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error('OUTPUT_SCHEMA_INVALID');
};
const textField = (value: unknown, maximum = 50000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error('OUTPUT_SCHEMA_INVALID');
  return value;
};
const strings = (value: unknown) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new Error('OUTPUT_SCHEMA_INVALID');
  return value as string[];
};
function identity(value: Record<string, unknown>, sourceRevision: string, sourceHash: string) {
  if (value.sourceRevision !== sourceRevision || value.sourceHash !== sourceHash)
    throw new Error('SOURCE_DEPENDENCY_MISMATCH');
}

/** Validate the actual returned mapping, not a copied count of requested blocks. */
export function validateTranslationChunk(
  plan: TranslationPlan,
  chunkId: string,
  output: unknown
): TranslationResult {
  const chunk = plan.chunks.find((item) => item.id === chunkId);
  if (!chunk) throw new Error('CHUNK_UNAVAILABLE');
  const value = parsed(output);
  only(value, ['sourceRevision', 'sourceHash', 'chunkId', 'segments']);
  identity(value, plan.sourceRevision, plan.sourceHash);
  if (value.chunkId !== chunkId || !Array.isArray(value.segments) || !value.segments.length)
    throw new Error('CHUNK_COVERAGE_INVALID');
  const segments = value.segments.map((segment) => {
    const item = object(segment);
    only(item, ['anchors', 'text']);
    const anchors = strings(item.anchors);
    if (!anchors.length) throw new Error('CHUNK_COVERAGE_INVALID');
    return { anchors: [...anchors], text: textField(item.text) };
  });
  if (
    JSON.stringify(segments.flatMap((segment) => segment.anchors)) !== JSON.stringify(chunk.anchors)
  )
    throw new Error('CHUNK_COVERAGE_INVALID');
  for (const segment of segments) {
    const spans = chunk.protectedSpans.filter((span) => segment.anchors.includes(span.anchor));
    const returnedTokens = segment.text.match(/\[\[p_[a-f0-9]+_\d+\]\]/g) ?? [];
    if (JSON.stringify(returnedTokens) !== JSON.stringify(spans.map((span) => span.token)))
      throw new Error('PROTECTED_SPAN_INVALID');
    let humanText = segment.text;
    for (const span of spans) humanText = humanText.replace(span.token, '');
    if (humanText.includes('[[p_') || [...humanText.matchAll(syntax)].length)
      throw new Error('UNPROTECTED_SYNTAX_RETURNED');
    for (const span of spans) segment.text = segment.text.replace(span.token, () => span.literal);
  }
  return { sourceRevision: plan.sourceRevision, sourceHash: plan.sourceHash, chunkId, segments };
}
/** Completed siblings are retained; only missing/failed logical chunk IDs retry. */
export function aggregateTranslation(plan: TranslationPlan, results: TranslationResult[]) {
  const byId = new Map<string, TranslationResult>();
  for (const result of results) {
    if (byId.has(result.chunkId)) throw new Error('DUPLICATE_CHUNK_RESULT');
    const chunk = plan.chunks.find((item) => item.id === result.chunkId);
    if (
      !chunk ||
      result.sourceRevision !== plan.sourceRevision ||
      result.sourceHash !== plan.sourceHash ||
      JSON.stringify(result.segments.flatMap((segment) => segment.anchors)) !==
        JSON.stringify(chunk.anchors)
    )
      throw new Error('SOURCE_DEPENDENCY_MISMATCH');
    byId.set(result.chunkId, structuredClone(result));
  }
  const retryChunkIds = plan.chunks.filter((chunk) => !byId.has(chunk.id)).map((chunk) => chunk.id);
  return {
    status:
      retryChunkIds.length === 0
        ? ('completed' as const)
        : results.length
          ? ('partial' as const)
          : ('incomplete' as const),
    completedChunks: results.length,
    totalChunks: plan.chunks.length,
    retryChunkIds,
    segments: plan.chunks.flatMap((chunk) => byId.get(chunk.id)?.segments ?? []),
  };
}

type CatalogEntry = Omit<Resource, 'text' | 'chatId'>;
export type BlockScene = {
  anchor: string;
  actorIds: string[];
  clothing: string[];
  location: string | null;
};
export type AssetEntry = {
  ref: string;
  revision: number;
  hash: string;
  url: string;
  alt: string;
  caption: string;
  actorId: string | null;
  clothing: string | null;
  location: string | null;
  uses: ('profile' | 'inline')[];
};
export type DisplayAnnotation = {
  sourceRevision: string;
  sourceHash: string;
  kind: 'display-only';
  entries: { anchor: string; summary: string; mood: string }[];
};
export type PresentationAnnotation = {
  sourceRevision: string;
  sourceHash: string;
  entries: {
    blockAnchor: string;
    assetRef: string;
    assetRevision: number;
    assetHash: string;
    presentationIntent: 'inline' | 'profile';
  }[];
};
export type PreviousTranslation = {
  sourceRevision: string;
  sourceHash: string;
  chunks: { chunkId: string; text: string; truncated: boolean }[];
};
export type AuxiliaryInput = {
  role: 'translation' | 'status' | 'presentation';
  contract: string;
  customPrompt?: boolean;
  sourceRevision: string;
  sourceHash: string;
  context: SourceTimeContext & { previousTranslation?: PreviousTranslation };
  catalog: CatalogEntry[];
  tools: string[];
  results: ToolEvent[];
  outputSchema: Record<string, unknown>;
  blocks: { anchor: string; text: string }[];
  chunkId?: string;
  neighborBlocks?: { anchor: string; text: string }[];
  assets?: ImageMetadata[];
  assetPage?: { total: number; nextOffset: number | null };
  scenes?: BlockScene[];
  referencePolicy?: string;
};
const baseInput = (
  sourceRevision: string,
  sourceHash: string,
  context: SourceTimeContext,
  snapshot: RunSnapshot
) => ({
  sourceRevision,
  sourceHash,
  context: structuredClone(context),
  catalog: snapshot.resources
    .filter((item) => item.chatId === snapshot.chatId)
    .map(({ text: _text, chatId: _chatId, ...item }) => item),
  tools: ['knowledge.search', 'knowledge.read', 'skills.list', 'skills.load'],
  results: [] as ToolEvent[],
});
/** Completed translations are request-local wording references, never a change to the frozen plan. */
function previousTranslation(
  plan: TranslationPlan,
  current: TranslationChunk,
  completed: readonly TranslationResult[]
): PreviousTranslation | undefined {
  aggregateTranslation(plan, [...completed]); // Recheck source identity, chunk IDs and ordered anchor coverage.
  const byId = new Map(completed.map((result) => [result.chunkId, result]));
  const prior = plan.chunks
    .filter((chunk) => chunk.index < current.index && byId.has(chunk.id))
    .slice(-2);
  if (!prior.length) return undefined;
  const maximum = Math.floor(6000 / prior.length);
  const chunks = prior.map((chunk) => {
    const result = byId.get(chunk.id)!;
    const full = result.segments.map((segment) => textField(segment.text)).join('\n\n');
    let start = Math.max(0, full.length - maximum);
    // Keep the UTF-16 bound without starting in the middle of a surrogate pair.
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(full[start])) start++;
    return { chunkId: chunk.id, text: full.slice(start), truncated: start > 0 };
  });
  return { sourceRevision: plan.sourceRevision, sourceHash: plan.sourceHash, chunks };
}
export function translationInput(
  plan: TranslationPlan,
  chunkId: string,
  snapshot: RunSnapshot,
  completed: readonly TranslationResult[] = []
): AuxiliaryInput {
  if (snapshot.chatId !== plan.chatId) throw new Error('SOURCE_SCOPE_MISMATCH');
  const chunk = plan.chunks.find((item) => item.id === chunkId);
  if (!chunk) throw new Error('CHUNK_UNAVAILABLE');
  const base = baseInput(plan.sourceRevision, plan.sourceHash, plan.context, snapshot);
  const previous = previousTranslation(plan, chunk, completed);
  const prompt = snapshot.profile?.promptPresets?.translation;
  const packages = packageContext(snapshot, 'translation');
  if (packages) {
    const ids = new Set(base.catalog.map((r) => r.id));
    for (const pack of compiledPackages(snapshot, 'translation'))
      for (const { text: _text, chatId: _chatId, ...r } of pack.resources)
        if (!ids.has(r.id)) {
          base.catalog.push(r);
          ids.add(r.id);
        }
  }
  return {
    ...base,
    role: 'translation',
    chunkId,
    tools: [...base.tools, ...STORY_READ_NAMES, ...TRANSLATION_READ_NAMES],
    context: {
      ...base.context,
      ...(packages ? { packages } : {}),
      ...(previous ? { previousTranslation: previous } : {}),
    },
    contract: '',
    referencePolicy:
      'Optional story.search/read retrieves frozen prior originals; memory.search/read retrieves typed source-time evidence; translation.search/read retrieves prior wording, never new facts. Search names, forms of address and speaker register when useful, then read only needed ranges. Current source and source-time references take precedence over prior translations, beliefs and summaries. Hidden viewpoints remain distinct: reference knowledge does not become a character’s knowledge. Empty search needs no retry; translation remains possible without tools. Total tool result budget is 96000 UTF-8 bytes per job.',
    ...(prompt ? { customPrompt: true } : {}),
    blocks: structuredClone(chunk.blocks),
    neighborBlocks: [
      plan.chunks[chunk.index - 1]?.blocks.at(-1),
      plan.chunks[chunk.index + 1]?.blocks[0],
    ].filter((item) => item !== undefined),
    outputSchema: {
      sourceRevision: 'exact input value',
      sourceHash: 'exact input value',
      chunkId: 'exact input value',
      segments: [
        {
          anchors: ['ordered source anchors'],
          text: prompt
            ? 'Translated prose with protected tokens unchanged'
            : 'Korean prose with protected tokens unchanged',
        },
      ],
    },
  };
}
/** A translation job compiles its own frozen preset and values, never main-turn messages. */
export function compileTranslationPrompt(
  input: AuxiliaryInput,
  snapshot: RunSnapshot,
  task: string
): PromptCompilation | undefined {
  if (input.role !== 'translation') return undefined;
  const preset = snapshot.profile?.promptPresets?.translation;
  if (
    preset &&
    (preset.role !== 'translation' ||
      input.context.instructionRevision !== `prompt:${preset.id}@${preset.revision}`)
  )
    throw new Error('SOURCE_PROMPT_REVISION_MISMATCH');
  const contents = snapshot.profile?.contents ?? [];
  const description = input.context.bot?.text ?? '';
  const lore = [
    ...contents
      .filter((item) => item.kind === 'module' && item.loading === 'pinned')
      .map((item) => item.text),
  ].join('\n\n');
  const slots: Record<string, string> = {
    char: contents.find((item) => item.kind === 'bot')?.title ?? 'Character',
    bot: description,
    description,
    persona: input.context.persona?.text ?? '',
    lore,
    lorebook: lore,
    memory: snapshot.story?.memory ? JSON.stringify(snapshot.story.memory) : '',
    state: snapshot.story?.state ? JSON.stringify(snapshot.story.state) : '',
    source: JSON.stringify(input.blocks),
    context: JSON.stringify(input.context),
    outputSchema: JSON.stringify(input.outputSchema),
    catalog: JSON.stringify(input.catalog),
    controls: '{}',
    globalNote: '',
    authorNote: '',
    authornote: '',
    postEverything: '',
    slot: '',
  };
  const packageSlot = packageSlots(snapshot, 'translation');
  if (packageSlot.char) slots.char = packageSlot.char;
  for (const key of ['bot', 'persona', 'lore'] as const)
    if (packageSlot[key]) slots[key] = [slots[key], packageSlot[key]].filter(Boolean).join('\n\n');
  slots.description = slots.bot;
  slots.lorebook = slots.lore;
  return compilePromptProgram(
    preset?.program ?? createDefaultPromptProgram(DEFAULT_TRANSLATION_PROMPT, 'translation'),
    {
      runtime: {
        ...executionContext(snapshot, 'translation'),
        source: {
          id: input.sourceRevision,
          hash: input.sourceHash,
          blocks: input.blocks as unknown as import('./prompt-program.js').RuntimeValue,
        },
      },
      values: preset
        ? snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
        : undefined,
      slots,
      history: [
        {
          id: `translation-current:${input.chunkId ?? input.sourceRevision}`,
          role: 'user',
          text: task,
          sourceRevision: input.sourceRevision,
          sourceHash: input.sourceHash,
          current: true,
        },
      ],
    }
  );
}
export function displayInput(
  source: AuxiliarySource,
  context: SourceTimeContext,
  snapshot: RunSnapshot
): AuxiliaryInput {
  if (source.chatId !== snapshot.chatId) throw new Error('SOURCE_SCOPE_MISMATCH');
  const packages = packageContext(snapshot, 'status');
  return {
    ...baseInput(source.id, source.hash, packages ? { ...context, packages } : context, snapshot),
    role: 'status',
    blocks: splitSource(source),
    contract:
      'Create optional display-only scene summaries and mood annotations grounded in the specified source blocks. Do not invent inner motives or new events. These interpretations never become authoritative state, canon, or next-turn evidence. Return structured data; do not rewrite the source or add HTML.',
    outputSchema: {
      sourceRevision: 'exact input value',
      sourceHash: 'exact input value',
      kind: 'display-only',
      entries: [
        {
          anchor: 'existing source anchor',
          summary: 'brief grounded description',
          mood: 'interpretive display label',
        },
      ],
    },
  };
}
export function validateDisplayAnnotation(
  source: AuxiliarySource,
  output: unknown
): DisplayAnnotation {
  const blocks = splitSource(source);
  const value = parsed(output);
  only(value, ['sourceRevision', 'sourceHash', 'kind', 'entries']);
  identity(value, source.id, source.hash);
  if (
    value.kind !== 'display-only' ||
    !Array.isArray(value.entries) ||
    value.entries.length > blocks.length
  )
    throw new Error('OUTPUT_SCHEMA_INVALID');
  const seen = new Set<string>();
  const entries = value.entries.map((raw) => {
    const item = object(raw);
    only(item, ['anchor', 'summary', 'mood']);
    const anchor = textField(item.anchor, 200);
    if (seen.has(anchor) || !blocks.some((block) => block.anchor === anchor))
      throw new Error('ANNOTATION_ANCHOR_INVALID');
    seen.add(anchor);
    return { anchor, summary: textField(item.summary, 600), mood: textField(item.mood, 100) };
  });
  return { sourceRevision: source.id, sourceHash: source.hash, kind: 'display-only', entries };
}

export function presentationInput(
  source: AuxiliarySource,
  context: SourceTimeContext,
  snapshot: RunSnapshot,
  assets: readonly AssetEntry[] = [],
  scenes: BlockScene[] = []
): AuxiliaryInput {
  if (source.chatId !== snapshot.chatId) throw new Error('SOURCE_SCOPE_MISMATCH');
  const packages = packageContext(snapshot, 'image');
  const page = imageCatalogPage(assets);
  return {
    ...baseInput(source.id, source.hash, packages ? { ...context, packages } : context, snapshot),
    catalog: [],
    role: 'presentation',
    blocks: splitSource(source),
    assets: page.items,
    assetPage: { total: page.total, nextOffset: page.nextOffset },
    scenes: structuredClone(scenes),
    tools: ['assets.search', 'assets.inspect'],
    contract:
      'Select optional existing images for the corresponding source block. Choose from the authored names and optional descriptions using the source meaning. Do not require literal actor, clothing or location strings in a block. Assets metadata is an authored description, not a claim that you viewed image bytes. The initial catalog is a bounded page. Use assets.search with offset/limit and follow nextOffset when useful; assets.inspect reads an exact ref. Never invent a name-to-ID mapping. No suitable image means an empty entries list, which is successful. Return source-bound annotations only; never HTML or rewritten narrative. The host validates source, anchor, asset revision/hash and allowed use. Image interpretation never changes story canon or state.',
    outputSchema: {
      sourceRevision: 'exact input value',
      sourceHash: 'exact input value',
      entries: [
        {
          blockAnchor: 'existing source anchor',
          assetRef: 'existing host manifest ref',
          assetRevision: 'exact manifest revision',
          assetHash: 'exact manifest hash',
          presentationIntent: 'inline or profile',
        },
      ],
    },
  };
}
export function validatePresentation(
  source: AuxiliarySource,
  output: unknown,
  assets: readonly AssetEntry[] = [],
  maximum = 4
): PresentationAnnotation {
  const blocks = splitSource(source);
  const value = parsed(output);
  only(value, ['sourceRevision', 'sourceHash', 'entries']);
  identity(value, source.id, source.hash);
  if (!Array.isArray(value.entries) || value.entries.length > maximum)
    throw new Error('PRESENTATION_LIMIT_INVALID');
  const seen = new Set<string>();
  const entries = value.entries.map((raw) => {
    const item = object(raw);
    only(item, ['blockAnchor', 'assetRef', 'assetRevision', 'assetHash', 'presentationIntent']);
    const anchor = textField(item.blockAnchor, 200);
    const ref = textField(item.assetRef, 200);
    const candidates = assets.filter((asset) => asset.ref === ref);
    const selected = candidates.length === 1 ? candidates[0] : undefined;
    if (!blocks.some((block) => block.anchor === anchor))
      throw new Error('ANNOTATION_ANCHOR_INVALID');
    if (
      !selected ||
      selected.revision !== item.assetRevision ||
      selected.hash !== item.assetHash ||
      !['inline', 'profile'].includes(String(item.presentationIntent)) ||
      !selected.uses.includes(item.presentationIntent as 'inline' | 'profile')
    )
      throw new Error('ASSET_REFERENCE_INVALID');
    if (seen.has(`${anchor}:${ref}`)) throw new Error('DUPLICATE_PRESENTATION');
    seen.add(`${anchor}:${ref}`);
    return {
      blockAnchor: anchor,
      assetRef: ref,
      assetRevision: selected.revision,
      assetHash: selected.hash,
      presentationIntent: item.presentationIntent as 'inline' | 'profile',
    };
  });
  return { sourceRevision: source.id, sourceHash: source.hash, entries };
}

export type AuxiliaryRequest = (input: AuxiliaryInput, signal?: AbortSignal) => Promise<unknown>;
export async function executeAuxiliary(
  input: AuxiliaryInput,
  snapshot: RunSnapshot,
  request: AuxiliaryRequest,
  hooks: {
    signal?: AbortSignal;
    maxCalls?: number;
    onInput?: (input: AuxiliaryInput) => void | Promise<void>;
    onToolEvent?: (event: ToolEvent) => void | Promise<void>;
    assetCatalog?: readonly AssetEntry[];
    localTools?: {
      names: readonly string[];
      execute: (action: ToolAction) => ToolEvent | { event: ToolEvent; terminalOutput: unknown };
    };
  } = {}
): Promise<{
  output: unknown;
  modelCalls: number;
  inputs: AuxiliaryInput[];
  toolEvents: ToolEvent[];
}> {
  const assetCatalog = structuredClone(hooks.assetCatalog ?? input.assets ?? []);
  const fixedInput = structuredClone(input);
  const fixedScope = structuredClone(snapshot);
  const inputs: AuxiliaryInput[] = [];
  const toolEvents: ToolEvent[] = [];
  const limit = hooks.maxCalls ?? snapshot.settings.maxCalls;
  const check = () => {
    if (hooks.signal?.aborted)
      throw Object.assign(new Error('Auxiliary cancelled'), { name: 'AbortError' });
  };
  while (true) {
    check();
    if (!Number.isSafeInteger(limit) || limit < 1 || inputs.length >= limit)
      throw Object.assign(new Error('Auxiliary call budget exhausted'), { name: 'BudgetError' });
    const current = { ...structuredClone(fixedInput), results: structuredClone(toolEvents) };
    inputs.push(structuredClone(current));
    await hooks.onInput?.(structuredClone(current));
    check();
    const output = await request(structuredClone(current), hooks.signal);
    check();
    if (
      !output ||
      typeof output !== 'object' ||
      !['tool', 'tools'].includes(String((output as { kind?: string }).kind))
    )
      return {
        output:
          output && typeof output === 'object' && (output as { kind?: string }).kind === 'output'
            ? (output as { output?: unknown }).output
            : output,
        modelCalls: inputs.length,
        inputs,
        toolEvents,
      };
    const actions =
      (output as { kind: string }).kind === 'tools'
        ? (output as { actions?: ToolAction[] }).actions
        : [(output as { action?: ToolAction }).action];
    if (!Array.isArray(actions) || !actions.length || actions.length > 32)
      throw new Error('TOOL_CALL_INVALID');
    for (const action of actions) {
      check();
      if (
        !action ||
        typeof action.callId !== 'string' ||
        !action.callId ||
        typeof action.name !== 'string' ||
        !action.args ||
        typeof action.args !== 'object' ||
        Array.isArray(action.args) ||
        toolEvents.some((event) => event.callId === action.callId)
      )
        throw new Error('TOOL_CALL_INVALID');
      let event: ToolEvent;
      if (!fixedInput.tools.includes(action.name))
        event = {
          callId: action.callId,
          name: 'unapproved',
          args: {},
          result: { code: 'TOOL_NOT_ALLOWED' },
          denied: true,
        };
      else if (hooks.localTools?.names.includes(action.name)) {
        const local = hooks.localTools.execute(structuredClone(action));
        if ('terminalOutput' in local) {
          event = local.event;
          toolEvents.push(structuredClone(event));
          await hooks.onToolEvent?.(structuredClone(event));
          check();
          return { output: local.terminalOutput, modelCalls: inputs.length, inputs, toolEvents };
        }
        event = local;
        if (event.callId !== action.callId || event.name !== action.name)
          throw new Error('TOOL_CALL_INVALID');
      } else if (action.name === 'assets.search' || action.name === 'assets.inspect') {
        const assets = assetCatalog;
        if (action.name === 'assets.search') {
          if (Object.keys(action.args).some((key) => !['query', 'offset', 'limit'].includes(key)))
            throw new Error('TOOL_CALL_INVALID');
          const query = action.args.query ?? '',
            offset = action.args.offset ?? 0,
            limit = action.args.limit ?? 20;
          const page = imageCatalogPage(assets, query as string, offset as number, limit as number);
          event = { ...action, args: { query, offset, limit }, result: page, denied: false };
        } else {
          if (
            Object.keys(action.args).some((key) => key !== 'ref') ||
            typeof action.args.ref !== 'string' ||
            action.args.ref.length > 200
          )
            throw new Error('TOOL_CALL_INVALID');
          const found = assets.find((asset) => asset.ref === action.args.ref);
          event = found
            ? {
                ...action,
                args: { ref: found.ref },
                result: { asset: imageMetadata(found), bytesProvided: false },
                denied: false,
              }
            : {
                callId: action.callId,
                name: action.name,
                args: {},
                result: { code: 'ASSET_UNAVAILABLE' },
                denied: true,
              };
        }
      } else
        event = executeTool(
          fixedScope,
          action,
          hooks.signal,
          fixedInput.role === 'presentation' ? 'image' : fixedInput.role
        );
      toolEvents.push(structuredClone(event));
      await hooks.onToolEvent?.(structuredClone(event));
      check();
      if (event.denied) throw new Error('Auxiliary read tool denied');
    }
  }
}

/** Explicit deterministic local adapter: validates plumbing, never semantic quality. */
export const scriptedAuxiliary: AuxiliaryRequest = async (input) => {
  if (input.role === 'translation')
    return {
      sourceRevision: input.sourceRevision,
      sourceHash: input.sourceHash,
      chunkId: input.chunkId,
      segments: input.blocks.map((block) => ({
        anchors: [block.anchor],
        // Hidden markers are protected tokens here. An inline mock prefix would move
        // their restored opening delimiter off column zero and orphan the closing tag.
        // Echo this structured source unchanged; the job result still declares mock:true.
        text: input.context.segmentKnowledge
          ? block.text
          : `[모의 번역 · 의미 품질 미검증] ${block.text}`,
      })),
    };
  if (input.role === 'status')
    return {
      sourceRevision: input.sourceRevision,
      sourceHash: input.sourceHash,
      kind: 'display-only',
      entries: input.blocks.slice(0, 1).map((block) => ({
        anchor: block.anchor,
        summary: '모의 표시 상태 · 원문 보존됨 · 정사에 반영하지 않음',
        mood: '합성 표시',
      })),
    };
  const entries: PresentationAnnotation['entries'] = [];
  for (const scene of input.scenes ?? [])
    for (const asset of input.assets ?? []) {
      if (entries.length >= 4) break;
      if (
        (asset.actorId && !scene.actorIds.includes(asset.actorId)) ||
        (asset.clothing && !scene.clothing.includes(asset.clothing)) ||
        (asset.location && scene.location !== asset.location)
      )
        continue;
      entries.push({
        blockAnchor: scene.anchor,
        assetRef: asset.ref,
        assetRevision: asset.revision,
        assetHash: asset.hash,
        presentationIntent: asset.uses[0],
      });
    }
  return { sourceRevision: input.sourceRevision, sourceHash: input.sourceHash, entries };
};
