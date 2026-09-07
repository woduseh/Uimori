import { createHash } from 'node:crypto';
import type { ModelInput, Resource, RunSnapshot, ToolEvent, Usage } from './types.js';
import { compileCreative } from './product.js';
import { executeStoryRead, STORY_READ_NAMES } from './story-context.js';
import { nativeInstructions } from './native-context.js';
import { hiddenHistoryForRequest, hiddenMemoryPlanForRequest } from './hidden-context.js';
import { compiledPackages, packageContext } from './package-context.js';
import { DEFAULT_LORE_CONTEXT, type LorePlacement } from './lore-context.js';
import { listBehaviorTools } from './package-behavior-tools.js';

// These are host permissions, never instructions read from a content package.
const ALLOWED_TOOLS = Object.freeze(['knowledge.search', 'knowledge.read', 'skills.list', 'skills.load']);

const PINNED_FACTS = Object.freeze(['The fictional scene starts at Lantern Harbor.', 'Mira carries a brass compass.', 'The reader controls their own character decisions.']);
const metadata = ({ text: _text, chatId: _chatId, ...item }: Resource) => item;
const scopedMetadata = (item: Resource, allowedIds: Set<string>) => ({ ...metadata(item), ...(item.relatedIds ? { relatedIds: item.relatedIds.filter(id => allowedIds.has(id)) } : {}) });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function roleResources(snapshot: RunSnapshot, role: 'main' | 'translation' | 'status' | 'image' = 'main') {
  const resources = snapshot.resources.filter(item => item.chatId === snapshot.chatId && !(snapshot.profile?.packageAttachments?.length && item.id.startsWith('package:')) && (role !== 'main' || (item.sourceKind !== 'glossary' && !(item.sourceKind === 'persona' && snapshot.profile?.creative.personaReference === false))));
  if (role === 'translation') {
    const ids = new Set(resources.map(item => item.id));
    for (const item of snapshot.profile?.contents ?? []) {
      if (ids.has(item.id)) continue;
      resources.push({...item, chatId:snapshot.chatId, kind:item.kind === 'skill' ? 'skill' : 'lore', sourceKind:item.kind});
      ids.add(item.id);
    }
  }
  const ids = new Set(resources.map(item => item.id));
  for (const pack of compiledPackages(snapshot, role)) for (const item of pack.resources) if (!ids.has(item.id)) { resources.push(item); ids.add(item.id); }
  return resources;
}
export type MainInput = ModelInput & {
  controls?: ReturnType<typeof compileCreative>;
  pinnedSources?: { id: string; revision: number; kind: string; hash: string; text: string; loreContext?: LorePlacement }[];
  state?: { values: import('./state.js').StateValues; sourceRevision:string|null; moduleRevision:number; constraints:import('./state.js').StateModule };
  memory?: Omit<import('./memory.js').MemoryContextPlan,'recentHistory'>;
  catalogPage?: {total:number;listed:number;remaining:string};
};
/** Slot bodies and fallback suppression share this exact source selection. */
export function pinnedSlotSources(input: MainInput, slot: string): NonNullable<MainInput['pinnedSources']> {
  const sources = input.pinnedSources ?? [];
  if (slot === 'references') return sources;
  if (slot === 'backgroundLore') return sources.filter(item => item.loreContext?.placement !== 'scene');
  if (slot === 'sceneLore') return sources.filter(item => item.loreContext?.placement === 'scene');
  if (slot === 'bot' || slot === 'description') return sources.filter(item => item.kind === 'bot');
  if (slot === 'persona') return sources.filter(item => item.kind === 'persona');
  if (slot === 'lore' || slot === 'lorebook') return sources.filter(item => !['bot', 'persona', 'instruction'].includes(item.kind));
  return [];
}
/** Fixed contract, provenance-bearing pinned content, catalog and observed reads stay separate. */
export function buildMainInput(snapshot: RunSnapshot, results: readonly ToolEvent[] = []): MainInput {
  const resources = roleResources(snapshot);
  const allowedIds = new Set(resources.map(item => item.id));
  const input: MainInput = {
    role: 'main', contract: '', task: snapshot.request, preset: snapshot.settings.preset,
    facts: [...PINNED_FACTS], history: structuredClone(snapshot.history),
    catalog: resources.map(item => scopedMetadata(item, allowedIds)), prefetch: [], tools: [...ALLOWED_TOOLS], results: structuredClone([...results]),
  };
  if (snapshot.profile) {
    input.controls = compileCreative(snapshot.profile.creative);
    const contents = snapshot.profile.contents.filter(item => item.kind !== 'glossary' && !(item.kind === 'persona' && !snapshot.profile!.creative.personaReference));
    const pinned = contents.filter(item => item.loading === 'pinned' || ['bot', 'persona', 'canon'].includes(item.kind));
    input.pinnedSources = pinned.map(item => ({ id: item.id, revision: item.revision, kind: item.kind, hash: hash(item.text), text: item.text }));
    input.facts = pinned.filter(item => item.kind !== 'skill').map(item => item.text);
    const style = snapshot.profile.creative.style;
    if (style !== 'auto') input.preset = style;
  }
  if(snapshot.story?.state?.canonical && snapshot.story.config.module){
    const state=snapshot.story.state;
    input.state={values:structuredClone(state.values),sourceRevision:state.sourceRevision,moduleRevision:state.moduleRevision,constraints:structuredClone(snapshot.story.config.module)};
  }
  if(snapshot.nativeBot){
    const p=snapshot.nativeBot.package;
    const native=[{id:`native:${p.id}:instructions`,revision:p.revision,kind:'bot',text:nativeInstructions(snapshot.nativeBot)},...snapshot.resources.filter(r=>r.id.startsWith(`native:${p.id}:`)&&r.loading==='pinned').map(r=>({id:r.id,revision:r.revision,kind:'lore',text:r.text}))].map(item=>({...item,hash:hash(item.text)}));
    input.pinnedSources=[...input.pinnedSources??[],...native];input.facts.push(...native.map(item=>item.text));
  }
  const packageData = packageContext(snapshot, 'main');
  if (packageData) {
    const pinned = [...packageData.pinned.map(r => ({ id: r.id, revision: r.revision, kind: r.sourceKind ?? r.kind, text: r.text, ...(r.loreContext ? {loreContext:r.loreContext} : {}) })), ...packageData.instructions.map(n => ({ ...n, kind: 'instruction' }))].map(r => ({ ...r, hash: hash(r.text) }));
    input.pinnedSources = [...input.pinnedSources ?? [], ...pinned]; input.facts.push(...pinned.map(r => r.text));
  }
  if (input.pinnedSources) {
    const seen = new Set<string>();
    input.pinnedSources = input.pinnedSources.filter(item => { const key = `${item.id}@${item.revision}:${item.hash}`; if (seen.has(key)) return false; seen.add(key); return true; });
    const limit = snapshot.loreContext?.policy.maxPinnedChars ?? snapshot.profile?.loreContext?.maxPinnedChars ?? DEFAULT_LORE_CONTEXT.maxPinnedChars;
    if (input.pinnedSources.reduce((sum,item) => sum + item.text.length, 0) > limit) throw Object.assign(new Error('LORE_PINNED_BUDGET_EXCEEDED: 고정 자료가 설정한 문자 한도를 초과했어요. 자료를 줄이거나 고정 자료 한도를 조정해 주세요.'), {statusCode:409});
    input.facts = input.pinnedSources.filter(item => item.kind !== 'skill').map(item => item.text);
  }
  if(snapshot.story?.memory){
    const {recentHistory,...memory}=hiddenMemoryPlanForRequest(snapshot,snapshot.story.memory.plan);
    if(!memory.ready)throw new Error('Memory context budget exceeded');
    input.history=structuredClone(recentHistory);input.memory=structuredClone(memory);
    input.tools.push(...STORY_READ_NAMES);
  }
  else if(snapshot.hiddenStory)input.history=hiddenHistoryForRequest(snapshot);
  if(snapshot.hiddenStory)input.contract+='\nHidden segment visibility is for the reader. A memory kind alone never establishes world truth or actor knowledge: respect knowledge.worldStatus and knownByActorIds; unspecified/null remains unknown. Never infer actor knowledge from a portrait or from the reader opening a panel.';
  if(input.catalog.length>100){input.catalogPage={total:input.catalog.length,listed:100,remaining:'Use knowledge.search or skills.list with pagination to discover the full approved scope.'};input.catalog=input.catalog.slice(0,100);}
  const behaviorTools = listBehaviorTools(snapshot);
  if (behaviorTools.length) {
    input.tools.push(...behaviorTools.map(binding => binding.tool.name));
    input.contract += '\nRegistered behavior tools resolve author-configured story actions. Request only the relevant action and its input; the host owns eligibility, random draws and state changes. Each action has one opportunity in this run; repeated requests reuse its outcome. Read resources cannot grant further action permissions. Use the recorded outcome in the narrative.';
  }
  return input;
}

function checkAbort(signal?: AbortSignal) {
  // Abort reasons may include a caller's data. Do not echo them into a run error.
  if (signal?.aborted) throw Object.assign(new Error('Run cancelled'), { name: 'AbortError' });
}

function pageNumber(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return null;
  return value as number;
}

export type ToolAction = { callId: string; name: string; args: Record<string, unknown>; recoveredFromTruncation?: boolean };

/** Execute a reusable read action against the immutable Run's local corpus. */
export function executeTool(snapshot: RunSnapshot, action: ToolAction, signal?: AbortSignal, role: 'main' | 'translation' | 'status' | 'image' = 'main'): ToolEvent {
  checkAbort(signal);
  if((role==='main' || role==='translation') && STORY_READ_NAMES.includes(action.name))return executeStoryRead(snapshot,action,role==='translation');
  const denied = (code: string): ToolEvent => ({ callId: action.callId, name: ALLOWED_TOOLS.includes(action.name) ? action.name : 'unapproved', args: {}, result: { code }, denied: true });
  if (!ALLOWED_TOOLS.includes(action.name)) return denied('TOOL_NOT_ALLOWED');
  // Scope applies before search, counts, pagination, and individual reads alike.
  const scope = roleResources(snapshot, role);
  const { args } = action;
  if (action.name === 'knowledge.search' || action.name === 'skills.list') {
    if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 512)) return denied('INVALID_ARGUMENTS');
    const query = typeof args.query === 'string' ? args.query : '';
    const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
    const limit = pageNumber(args.limit, 20, 100);
    if (offset === null || limit === null || limit === 0) return denied('INVALID_ARGUMENTS');
    const terms = query.toLocaleLowerCase('en').split(/\s+/u).filter(Boolean);
    const matches = scope.filter(item => (action.name !== 'skills.list' || item.kind === 'skill') && terms.every(term => `${item.title} ${item.description} ${item.text}`.toLocaleLowerCase('en').includes(term)));
    const allowedIds = new Set(scope.map(item => item.id));
    const items = matches.slice(offset, offset + limit).map(item => scopedMetadata(item, allowedIds));
    return { ...action, args: { query, offset, limit }, denied: false, result: { items, total: matches.length, continuation: offset + items.length < matches.length ? { offset: offset + items.length, limit } : null } };
  }
  if (typeof args.id !== 'string' || args.id.length > 200) return denied('INVALID_ARGUMENTS');
  const resource = scope.find(item => item.id === args.id);
  // Missing and excluded resources deliberately have the same observable error.
  if (!resource || (action.name === 'skills.load' ? resource.kind !== 'skill' : resource.kind !== 'lore')) return denied('RESOURCE_UNAVAILABLE');
  const offset = pageNumber(args.offset, 0, resource.text.length);
  const limit = pageNumber(args.limit, 4096, 16384);
  if (offset === null || limit === null || limit === 0) return denied('INVALID_ARGUMENTS');
  const end = Math.min(resource.text.length, offset + limit);
  const truncated = end < resource.text.length;
  return { ...action, args: { id: resource.id, offset, limit }, denied: false, result: {
    source: { id: resource.id, kind: resource.kind, ...(role==='translation' && resource.sourceKind ? {sourceKind:resource.sourceKind} : {}), revision: resource.revision, hash: hash(resource.text), reference: `resource:${resource.id}@${resource.revision}#chars=${offset}-${end}` },
    range: { start: offset, end, unit: 'utf16-code-unit' }, totalLength: resource.text.length,
    text: resource.text.slice(offset, end), truncated,
    continuation: truncated ? { id: resource.id, offset: end, limit } : null,
  } };
}

export function syntheticResources(chatId: string): Resource[] {
  return [
    { id: `${chatId}:harbor`, chatId, kind: 'lore', revision: 1, title: 'Lantern Harbor at dusk', description: 'Harbor geography, lamps, and the old ferry bell.', text: 'Lantern Harbor has a blue ferry bell beside its eastern pier. At dusk the keeper lights seven amber lamps. Mira knows that the bell has been silent since the last winter storm.' },
    { id: `${chatId}:craft`, chatId, kind: 'skill', revision: 1, title: 'Ground a quiet scene', description: 'Writing craft: concrete sensory detail and an open decision.', text: 'Choose a concrete sensory detail already available in the scene. Let an observed object carry tension. End with an opening for the reader rather than deciding their response.' },
    { id: `${chatId}:observatory`, chatId, kind: 'lore', revision: 2, title: 'Hilltop observatory', description: 'A separate hilltop location, accessible through additional research.', text: 'Above the harbor, the hilltop observatory has a green copper dome. A narrow footpath joins it to the eastern pier.' },
  ];
}

type SearchResult = { items: Omit<Resource, 'text' | 'chatId'>[] };
type ReadResult = { text: string };
type ModelStep = { kind: 'tool'; action: ToolAction } | { kind: 'text'; text: string };

/** A deterministic fixture provider, not a creative quality or API compatibility model. */
function scriptedStep(input: ModelInput, research: boolean): ModelStep {
  const success = input.results.filter(result => !result.denied);
  if (research && !success.some(result => result.name === 'knowledge.search')) {
    return { kind: 'tool', action: { callId: 'call-search', name: 'knowledge.search', args: { query: 'harbor' } } };
  }
  const search = success.find(result => result.name === 'knowledge.search');
  const discovered = search ? (search.result as SearchResult).items.find(item => item.kind === 'lore') : undefined;
  if (discovered && !success.some(result => result.name === 'knowledge.read')) {
    return { kind: 'tool', action: { callId: 'call-read', name: 'knowledge.read', args: { id: discovered.id } } };
  }
  const skill = input.catalog.find(item => item.kind === 'skill');
  if (research && skill && !success.some(result => result.name === 'skills.load')) {
    return { kind: 'tool', action: { callId: 'call-skill', name: 'skills.load', args: { id: skill.id } } };
  }
  const read = success.find(result => result.name === 'knowledge.read');
  const detail = read ? (read.result as ReadResult).text : 'The evening tide moved softly beneath the wooden pier.';
  const opening = input.preset === 'vivid'
    ? 'Wind struck the pier in bright, salt-heavy bursts. Mira caught her coat against her wrist, the brass compass cold in her palm.'
    : 'Mira paused beside the quiet pier, resting the brass compass in her open palm. The water moved patiently below her.';
  const previous = input.history.at(-1);
  // The fixture incorporates the actual read result and current request; it never
  // invents evidence that a catalog entry's body was already read.
  return { kind: 'text', text: `${opening}\n\n${detail}${previous ? ' The thread of the earlier scene remained with her as she looked along the shore.' : ''}\n\nThe next scene was still open: ${input.task}\nMira waited beside the rail, leaving the next decision to her companion.` };
}

export async function executeMain(snapshot: RunSnapshot, hooks: {
  signal: AbortSignal;
  onInput: (input: ModelInput) => void | Promise<void>;
  onToolEvent: (event: ToolEvent) => void | Promise<void>;
}): Promise<{ text: string; usage: Usage }> {
  // Detach once so neither instrumentation nor UI settings changes can mutate
  // this run's context or expand scope during a tool loop.
  const fixed = structuredClone(snapshot);
  const results: ToolEvent[] = [];
  let modelCalls = 0;
  while (true) {
    checkAbort(hooks.signal);
    if (!Number.isSafeInteger(fixed.settings.maxCalls) || fixed.settings.maxCalls < 1 || modelCalls >= fixed.settings.maxCalls) {
      throw Object.assign(new Error('Model call budget exhausted'), { name: 'BudgetError' });
    }
    const input = buildMainInput(fixed, results);
    modelCalls++;
    // This is the exact mock-provider input, copied only to prevent log-hook writes.
    await hooks.onInput(structuredClone(input));
    checkAbort(hooks.signal);
    const step = scriptedStep(input, fixed.settings.mode === 'research');
    if (step.kind === 'text') return { text: step.text, usage: { modelCalls, inputTokens: null, outputTokens: null, costUsd: null } };
    const event = executeTool(fixed, step.action, hooks.signal);
    results.push(event);
    await hooks.onToolEvent(structuredClone(event));
    checkAbort(hooks.signal);
    if (event.denied) throw new Error('Read tool request denied');
  }
}
