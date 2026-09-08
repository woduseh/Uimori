export { compileTranslationPrompt } from './translation-prompt.js';
import { imageCatalogPage, imageMetadata, type ImageMetadata } from './image-catalog.js';
import { createHash } from 'node:crypto';
import { executeTool, type ToolAction } from './provider.js';
import { createToolCorrectionPolicy } from './tool-outcome.js';
import type { Resource, RunSnapshot, ToolEvent } from './types.js';
import {
  parseSourceSegments,
  type SegmentKnowledge,
  type SegmentRange,
  type SourceSegmentPolicy,
} from './source-segments.js';
import { STORY_READ_NAMES } from './story-context.js';
import { TRANSLATION_READ_NAMES } from './translation-context.js';
import {
  compiledPackages,
  packageContext,
  packageContextFromCompiled,
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
function identity(value: Record<string, unknown>, sourceRevision: string, sourceHash: string) {
  if (value.sourceRevision !== sourceRevision || value.sourceHash !== sourceHash)
    throw new Error('SOURCE_DEPENDENCY_MISMATCH');
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
export type AuxiliaryInput = {
  role: 'translation' | 'status' | 'presentation';
  contract: string;
  customPrompt?: boolean;
  sourceRevision: string;
  sourceHash: string;
  context: SourceTimeContext;
  catalog: CatalogEntry[];
  tools: string[];
  results: ToolEvent[];
  outputSchema: Record<string, unknown>;
  blocks: { anchor: string; text: string }[];
  sourceText?: string;
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
/** The source is sent once, verbatim. The host owns identity; prose is not a schema. */
export function translationInput(
  source: AuxiliarySource,
  context: SourceTimeContext,
  snapshot: RunSnapshot
): AuxiliaryInput {
  validateSourceIdentity(source);
  if (snapshot.chatId !== source.chatId) throw new Error('SOURCE_SCOPE_MISMATCH');
  const document = parseSourceSegments(
    { sourceRevision: source.id, sourceHash: source.hash, text: source.text },
    context.sourceSegments
  );
  const base = baseInput(source.id, source.hash, context, snapshot);
  const compiled = compiledPackages(snapshot, 'translation');
  const packages = packageContextFromCompiled(compiled);
  if (packages) {
    const ids = new Set(base.catalog.map((r) => r.id));
    for (const pack of compiled)
      for (const { text: _text, chatId: _chatId, ...r } of pack.resources)
        if (!ids.has(r.id)) {
          base.catalog.push(structuredClone(r));
          ids.add(r.id);
        }
  }
  return {
    ...base,
    role: 'translation',
    sourceText: source.text,
    blocks: [],
    tools: [...base.tools, ...STORY_READ_NAMES, ...TRANSLATION_READ_NAMES],
    context: {
      ...base.context,
      ...(packages ? { packages } : {}),
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
    },
    contract: '',
    referencePolicy:
      'Optional story.search/read retrieves frozen prior originals; memory.search/read retrieves typed source-time evidence; translation.search/read retrieves prior wording, never new facts. Search names, forms of address and speaker register when useful, then read only needed ranges. Current source and source-time references take precedence over prior translations, beliefs and summaries. Hidden viewpoints remain distinct: reference knowledge does not become a character’s knowledge. Empty search needs no retry; translation remains possible without tools. Total tool result budget is 96000 UTF-8 bytes per job.',
    ...(snapshot.profile?.promptPresets?.translation ? { customPrompt: true } : {}),
    outputSchema: {},
  };
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
  const correction = createToolCorrectionPolicy();
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
      const decision = correction(event, action.args);
      if (decision === 'exhausted') throw new Error('TOOL_CORRECTION_EXHAUSTED');
      if (decision === 'denied') throw new Error('Auxiliary read tool denied');
    }
  }
}

/** Explicit deterministic local adapter: validates plumbing, never semantic quality. */
export const scriptedAuxiliary: AuxiliaryRequest = async (input) => {
  if (input.role === 'translation') return input.sourceText ?? '';
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
