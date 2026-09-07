import type { PromptControl, PromptValue } from './prompt-program.js';

/** Callers obtain sourceHash from the host's verified immutable source. This browser-safe
 * parser preserves that identity; it does not independently recompute SHA-256. */
export type HiddenSource = { sourceRevision: string; sourceHash: string; text: string };
export type HiddenRange = { start: number; end: number };
export type HiddenDiagnostic = { code: string; severity: 'warning' | 'error'; range?: HiddenRange };
export type HiddenKnowledge = { status: 'unknown' | 'explicit'; mode: 'unspecified' | 'current-event' | 'memory' | 'imagination' | 'belief'; perspectiveActorIds: string[] | null; knownByActorIds: string[] | null; evidence: HiddenRange[] };
export type HiddenSegment = {
  id: string; kind: 'main' | 'hidden' | 'evaluation'; range: HiddenRange; bodyRange: HiddenRange;
  title?: string; titleRange?: HiddenRange; markers?: { open: HiddenRange; close: HiddenRange };
  scene?: { range: HiddenRange; place: string; time: string; subjectLabel?: string };
  portrait?: { range: HiddenRange; raw: string };
  knowledge: HiddenKnowledge;
};
export type HiddenDocument = { sourceRevision: string; sourceHash: string; segments: HiddenSegment[]; diagnostics: HiddenDiagnostic[] };
export class HiddenStoryError extends Error { readonly statusCode = 400; constructor(readonly code: string) { super(code); this.name = 'HiddenStoryError'; } }
const fail = (code: string): never => { throw new HiddenStoryError(code); };
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return fail('HIDDEN_INVALID_FIELDS');
  return value as Record<string, unknown>;
};
const unknownKnowledge = (): HiddenKnowledge => ({ status: 'unknown', mode: 'unspecified', perspectiveActorIds: null, knownByActorIds: null, evidence: [] });
function checkSource(source: HiddenSource) {
  if (!source || typeof source.sourceRevision !== 'string' || !source.sourceRevision || source.sourceRevision.length > 200 || !/^[a-f0-9]{64}$/u.test(source.sourceHash) || typeof source.text !== 'string' || source.text.length > 1_000_000) fail('HIDDEN_SOURCE_INVALID');
}
type Line = HiddenRange & { text: string; contentEnd: number };
function lines(text: string): Line[] {
  const result: Line[] = []; let start = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0]) continue;
    const value = match[0].replace(/(?:\r\n|\r|\n)$/u, '');
    result.push({ start, end: start + match[0].length, contentEnd: start + value.length, text: value }); start += match[0].length;
  }
  return result;
}
type Marker = HiddenRange & { kind: 'hidden' | 'evaluation'; side: 'open' | 'close'; tokenRange: HiddenRange; title?: string; titleRange?: HiddenRange };

/** Linear delimiter scanner; malformed or nested blocks remain readable original text. */
export function parseHiddenStory(source: HiddenSource): HiddenDocument {
  checkSource(source);
  const diagnostics: HiddenDiagnostic[] = [], tokens: Marker[] = [];
  let fence: { symbol: string; length: number } | null = null;
  for (const line of lines(source.text)) {
    const fenced = line.text.match(/^\s*(`{3,}|~{3,})/u);
    if (fenced) { if (!fence) fence = { symbol: fenced[1][0], length: fenced[1].length }; else if (fenced[1][0] === fence.symbol && fenced[1].length >= fence.length) fence = null; continue; }
    if (fence) continue;
    const opening = line.text.match(/^[ \t]*@hsTitle:[ \t]*(.*)$/u);
    if (opening) {
      const title = opening[1].trim(), tokenStart = line.start + line.text.indexOf('@hsTitle:');
      const titleStart = tokenStart + 9 + line.text.slice(line.text.indexOf('@hsTitle:') + 9).search(/\S|$/u);
      if (!title || title.length > 512) diagnostics.push({ code: 'HIDDEN_TITLE_INVALID', severity: 'error', range: { start: line.start, end: line.contentEnd } });
      tokens.push({ ...line, kind: 'hidden', side: 'open', tokenRange: { start: tokenStart, end: tokenStart + 9 }, title, titleRange: { start: titleStart, end: titleStart + title.length } });
    } else if (/^[ \t]*@hs[ \t]*$/u.test(line.text)) {
      const start = line.start + line.text.indexOf('@hs'); tokens.push({ ...line, kind: 'hidden', side: 'close', tokenRange: { start, end: start + 3 } });
    } else if (/^[ \t]*@hsTitle/u.test(line.text)) diagnostics.push({ code: 'HIDDEN_OPEN_MARKER_INVALID', severity: 'error', range: { start: line.start, end: line.contentEnd } });
    for (const match of line.text.matchAll(/<\/?Evaluation\s*Report>/gu)) {
      const start = line.start + match.index, end = start + match[0].length;
      tokens.push({ start, end, kind: 'evaluation', side: match[0].startsWith('</') ? 'close' : 'open', tokenRange: { start, end } });
    }
  }
  tokens.sort((a, b) => a.start - b.start);
  if (tokens.length > 2000) fail('HIDDEN_SEGMENT_LIMIT');
  const pairs: { open: Marker; close: Marker }[] = [];
  let stack: Marker[] = [], corrupt = false;
  for (const token of tokens) {
    if (token.side === 'open') {
      if (stack.length) { corrupt = true; diagnostics.push({ code: 'HIDDEN_NESTED_MARKER', severity: 'error', range: token.tokenRange }); }
      stack.push(token); continue;
    }
    const opening = stack.pop();
    if (!opening) { diagnostics.push({ code: 'HIDDEN_ORPHAN_CLOSE', severity: 'error', range: token.tokenRange }); continue; }
    if (opening.kind !== token.kind) { corrupt = true; diagnostics.push({ code: 'HIDDEN_MISMATCHED_CLOSE', severity: 'error', range: token.tokenRange }); }
    if (!stack.length) { if (!corrupt && (opening.kind !== 'hidden' || opening.title)) pairs.push({ open: opening, close: token }); corrupt = false; }
  }
  if (stack.length) diagnostics.push({ code: 'HIDDEN_UNCLOSED_BLOCK', severity: 'error', range: { start: stack[0].start, end: source.text.length } });
  const segments: HiddenSegment[] = [];
  const make = (kind: HiddenSegment['kind'], start: number, end: number): HiddenSegment => ({ id: `hs-${source.sourceHash.slice(0, 24)}-${start}-${end}`, kind, range: { start, end }, bodyRange: { start, end }, knowledge: unknownKnowledge() });
  let cursor = 0;
  for (const pair of pairs) {
    if (pair.open.start > cursor) segments.push(make('main', cursor, pair.open.start));
    const segment = make(pair.open.kind, pair.open.start, pair.close.end);
    segment.bodyRange = { start: pair.open.end, end: pair.close.start };
    segment.markers = { open: pair.open.tokenRange, close: pair.close.tokenRange };
    if (segment.kind === 'hidden') {
      segment.title = pair.open.title; segment.titleRange = pair.open.titleRange;
      for (const line of lines(source.text.slice(pair.open.end, pair.close.start))) {
        if (!line.text.trim()) continue;
        const range = { start: pair.open.end + line.start, end: pair.open.end + line.end };
        const scene = line.text.trim().match(/^⟦([^\r\n]*)⟧$/u);
        if (!segment.scene && !segment.portrait && scene) {
          const fields = scene[1].split('@').map(value => value.trim());
          if (![2, 3].includes(fields.length) || fields.some(value => !value || value.length > 512)) { diagnostics.push({ code: 'HIDDEN_SCENE_INVALID', severity: 'warning', range }); break; }
          segment.scene = { range, place: fields[0], time: fields[1], ...(fields[2] ? { subjectLabel: fields[2] } : {}) }; segment.bodyRange.start = range.end; continue;
        }
        const portrait = line.text.trim().match(/^\[hsPortrait:\s*(.*)\]$/u);
        if (!segment.portrait && portrait) { segment.portrait = { range, raw: portrait[1].trim() }; segment.bodyRange.start = range.end; continue; }
        break;
      }
      if (!source.text.slice(segment.bodyRange.start, segment.bodyRange.end).trim()) diagnostics.push({ code: 'HIDDEN_BODY_EMPTY', severity: 'error', range: segment.bodyRange });
    }
    segments.push(segment); cursor = pair.close.end;
  }
  if (cursor < source.text.length) segments.push(make('main', cursor, source.text.length));
  for (const [index, segment] of segments.entries()) if (segment.kind === 'hidden') {
    if (!segments.slice(0, index).some(item => item.kind === 'main' && source.text.slice(item.range.start, item.range.end).trim())) diagnostics.push({ code: 'HIDDEN_WITHOUT_MAIN_PREFIX', severity: 'warning', range: segment.range });
    if (!segments.slice(index + 1).some(item => item.kind === 'main' && source.text.slice(item.range.start, item.range.end).trim())) diagnostics.push({ code: 'HIDDEN_AT_END', severity: 'warning', range: segment.range });
  }
  return { sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, segments, diagnostics };
}

export function withHiddenKnowledge(document: HiddenDocument, declarations: { segmentId: string; mode: HiddenKnowledge['mode']; perspectiveActorIds?: string[]; knownByActorIds?: string[]; evidence: HiddenRange[] }[]): HiddenDocument {
  const result = structuredClone(document), seen = new Set<string>();
  for (const declaration of declarations) {
    object(declaration, ['segmentId', 'mode', 'perspectiveActorIds', 'knownByActorIds', 'evidence']);
    const segment = result.segments.find(item => item.id === declaration.segmentId);
    if (!segment || seen.has(segment.id) || !['unspecified', 'current-event', 'memory', 'imagination', 'belief'].includes(declaration.mode) || !Array.isArray(declaration.evidence) || !declaration.evidence.length || declaration.evidence.length > 100) return fail('HIDDEN_KNOWLEDGE_INVALID');
    for (const actors of [declaration.perspectiveActorIds, declaration.knownByActorIds]) if (actors !== undefined && (!Array.isArray(actors) || actors.length > 100 || new Set(actors).size !== actors.length || actors.some(actor => typeof actor !== 'string' || !actor || actor.length > 160))) fail('HIDDEN_ACTOR_INVALID');
    for (const range of declaration.evidence) { object(range, ['start', 'end']); if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < segment.range.start || range.end > segment.range.end || range.end <= range.start) fail('HIDDEN_EVIDENCE_INVALID'); }
    segment.knowledge = { status: 'explicit', mode: declaration.mode, perspectiveActorIds: declaration.perspectiveActorIds ? [...declaration.perspectiveActorIds] : null, knownByActorIds: declaration.knownByActorIds ? [...declaration.knownByActorIds] : null, evidence: structuredClone(declaration.evidence) }; seen.add(segment.id);
  }
  return result;
}

/** Stable ASCII identities retain the original 35 controls while labels remain source metadata. */
export const HIDDEN_CONTROL_MAP = [
  ['히든', 'enabled', 'select', 2], ['히든이미지', 'assetMode', 'select', 2], ['히든글로벌', 'scope', 'select', 4], ['히든밸런스', 'portion', 'select', 3], ['히든개수', 'count', 'select', 12], ['히든테마', 'theme', 'select', 11],
  ['커스텀테마', 'customTheme', 'text', 0], ['커스텀히든', 'target', 'text', 0], ['커스텀필터', 'ban', 'text', 0], ['히든제목', 'title', 'select', 3], ['비히든', 'open', 'select', 2], ['히든프로필', 'portrait', 'select', 2], ['히든정보', 'scene', 'select', 4], ['이미지양', 'imageDensity', 'select', 5],
  ['히든리퀘제거', 'excludeHidden', 'boolean', 0], ['히든폴리쉬', 'polish', 'boolean', 0], ['유파', 'excludeGhosts', 'boolean', 0], ['한강', 'korean', 'boolean', 0], ['선부', 'hideDividers', 'boolean', 0],
  ['인풋평가', 'evaluation', 'select', 2], ['리포트리퀘제거', 'excludeReports', 'boolean', 0], ['전지적제어', 'knowledgeIsolation', 'boolean', 0], ['배드전개', 'badOutcomes', 'boolean', 0], ['엔티알', 'covertNtr', 'boolean', 0], ['프로필커터', 'profileStyle', 'select', 4], ['삽화수', 'illustrationCount', 'select', 6], ['wideshot', 'excludeWideShot', 'boolean', 0],
  ['히든스타일', 'style', 'select', 3], ['히든라인', 'border', 'select', 2], ['히든이모지', 'decoration', 'select', 2], ['색', 'color', 'select', 15], ['라운드', 'round', 'select', 3], ['정렬', 'align', 'select', 4], ['배경색', 'background', 'select', 4], ['투명도', 'opacity', 'text', 0],
] as const;
export type HiddenControlId = `hidden.${typeof HIDDEN_CONTROL_MAP[number][1]}`;
export type HiddenStoryConfig = { version: 1; contentPolicy: 'general-fiction' | 'nonsexual'; values: Record<HiddenControlId, PromptValue> };
export function defaultHiddenStoryConfig(contentPolicy: HiddenStoryConfig['contentPolicy'] = 'nonsexual'): HiddenStoryConfig {
  const values = Object.fromEntries(HIDDEN_CONTROL_MAP.map(([, name, kind]) => [`hidden.${name}`, kind === 'boolean' ? false : kind === 'text' ? '' : 0])) as HiddenStoryConfig['values'];
  values['hidden.enabled'] = 1; values['hidden.assetMode'] = 1; values['hidden.portrait'] = 1; values['hidden.theme'] = 1; values['hidden.evaluation'] = 1;
  return { version: 1, contentPolicy, values };
}
export function validateHiddenStoryConfig(input: unknown): HiddenStoryConfig {
  const value = object(input, ['version', 'contentPolicy', 'values']);
  if (value.version !== 1 || !['general-fiction', 'nonsexual'].includes(String(value.contentPolicy))) fail('HIDDEN_CONFIG_VERSION');
  const keys = HIDDEN_CONTROL_MAP.map(([, name]) => `hidden.${name}`), raw = object(value.values, keys);
  const config = defaultHiddenStoryConfig(value.contentPolicy as HiddenStoryConfig['contentPolicy']);
  for (const [, name, kind, optionCount] of HIDDEN_CONTROL_MAP) {
    const key: HiddenControlId = `hidden.${name}`, item = Object.hasOwn(raw, key) ? raw[key] : config.values[key];
    if (kind === 'select' && (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) >= optionCount) || kind === 'boolean' && typeof item !== 'boolean' || kind === 'text' && (typeof item !== 'string' || item.length > 4000)) fail('HIDDEN_CONTROL_INVALID');
    config.values[key] = item as PromptValue;
  }
  const opacity = config.values['hidden.opacity'] as string;
  if (opacity && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(opacity) || opacity.length > 16)) fail('HIDDEN_OPACITY_INVALID');
  if (config.contentPolicy === 'nonsexual' && (config.values['hidden.enabled'] === 0 && [4, 8].includes(Number(config.values['hidden.theme'])) || config.values['hidden.covertNtr'] === true)) fail('HIDDEN_NONSEXUAL_COMBINATION_REQUIRED');
  return config;
}
export const serializeHiddenStoryConfig = (input: unknown): string => JSON.stringify(validateHiddenStoryConfig(input));
export function hiddenConfigIssues(input: unknown): string[] {
  const { values } = validateHiddenStoryConfig(input), issues: string[] = [];
  if (values['hidden.style'] === 1) issues.push('HIDDEN_INVASIVE_CSS_SCOPED');
  if (values['hidden.polish']) issues.push('HIDDEN_EXTERNAL_POLISH_UNSUPPORTED');
  if (Number(values['hidden.illustrationCount']) > 0 || values['hidden.excludeWideShot']) issues.push('HIDDEN_EXTERNAL_ILLUSTRATION_UNSUPPORTED');
  if (Number(values['hidden.scope']) > 1) issues.push('HIDDEN_SOURCE_SCOPE_CONFLICT');
  return issues;
}
export function hiddenControlDefinitions(): PromptControl[] {
  const defaults = defaultHiddenStoryConfig();
  return HIDDEN_CONTROL_MAP.map(([label, name, type, count]) => ({ id: `hidden.${name}`, label, type, default: defaults.values[`hidden.${name}`], ...(type === 'select' ? { options: Array.from({ length: count }, (_, value) => ({ label: String(value), value })) } : {}) }));
}
export type HiddenReaderSettings = { defaultExpanded: boolean; showPortrait: boolean; scene: 'split' | 'top' | 'bottom' | 'none'; styled: boolean; border: boolean; decoration: boolean; color: number; round: 'round' | 'soft' | 'square'; align: 'left' | 'center' | 'right' | 'full'; background: number; opacity: number | null; hideDividers: boolean; showEvaluation: boolean };
export function hiddenReaderSettings(input: unknown): HiddenReaderSettings {
  const { values: v } = validateHiddenStoryConfig(input);
  return { defaultExpanded: v['hidden.open'] === 1, showPortrait: v['hidden.portrait'] === 0 && v['hidden.assetMode'] === 0, scene: (['split', 'top', 'bottom', 'none'] as const)[Number(v['hidden.scene'])], styled: v['hidden.style'] !== 2, border: v['hidden.border'] === 0, decoration: v['hidden.decoration'] === 0, color: Number(v['hidden.color']), round: (['round', 'soft', 'square'] as const)[Number(v['hidden.round'])], align: (['left', 'center', 'right', 'full'] as const)[Number(v['hidden.align'])], background: Number(v['hidden.background']), opacity: v['hidden.opacity'] === '' ? null : Number(v['hidden.opacity']), hideDividers: v['hidden.hideDividers'] === true, showEvaluation: v['hidden.evaluation'] === 0 };
}

export type HiddenRequestView = { ok: boolean; text: string; sourceRevision: string; sourceHash: string; keptRanges: HiddenRange[]; excluded: { segmentId: string; kind: 'hidden' | 'evaluation'; range: HiddenRange; sourceHash: string }[]; diagnostics: HiddenDiagnostic[] };
export function filterHiddenStoryForRequest(source: HiddenSource, input: unknown, context: { messageIndex?: number; lastMessageIndex?: number } = {}): HiddenRequestView {
  const config = validateHiddenStoryConfig(input), document = parseHiddenStory(source);
  const result: HiddenRequestView = { ok: true, text: '', sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, keptRanges: [], excluded: [], diagnostics: [...document.diagnostics] };
  const reportEnabled = config.values['hidden.evaluation'] === 0 && !config.values['hidden.excludeReports'];
  const hasReports = document.segments.some(segment => segment.kind === 'evaluation');
  if (hasReports && reportEnabled && (![context.messageIndex, context.lastMessageIndex].every(value => Number.isSafeInteger(value) && Number(value) >= 0) || Number(context.messageIndex) > Number(context.lastMessageIndex))) result.diagnostics.push({ code: 'HIDDEN_REPORT_INDEX_REQUIRED', severity: 'error' });
  // Do not silently leak malformed hidden text through a requested exclusion filter.
  if (result.diagnostics.some(item => item.severity === 'error') && (config.values['hidden.excludeHidden'] || !reportEnabled || hasReports)) return { ...result, ok: false };
  for (const segment of document.segments) {
    const exclude = segment.kind === 'hidden' && config.values['hidden.excludeHidden'] || segment.kind === 'evaluation' && (!reportEnabled || Number(context.messageIndex) < Number(context.lastMessageIndex) - 5);
    if (exclude && segment.kind !== 'main') result.excluded.push({ segmentId: segment.id, kind: segment.kind, range: { ...segment.range }, sourceHash: source.sourceHash });
    else { result.keptRanges.push({ ...segment.range }); result.text += source.text.slice(segment.range.start, segment.range.end); }
  }
  return result;
}
export const hiddenRangeWasExcluded = (view: HiddenRequestView, range: HiddenRange): boolean => !view.ok || view.excluded.some(item => range.start < item.range.end && range.end > item.range.start);

export type HiddenTranslationMarker = { range: HiddenRange; literal: string; segmentId: string; kind: 'open' | 'close' | 'scene' | 'portrait' | 'report' };
export function hiddenTranslationMarkers(source: HiddenSource): HiddenTranslationMarker[] {
  const document = parseHiddenStory(source), markers: HiddenTranslationMarker[] = [];
  const add = (segment: HiddenSegment, range: HiddenRange, kind: HiddenTranslationMarker['kind']) => markers.push({ range: { ...range }, literal: source.text.slice(range.start, range.end), segmentId: segment.id, kind });
  for (const segment of document.segments) {
    if (!segment.markers) continue;
    add(segment, segment.markers.open, 'open'); add(segment, segment.markers.close, 'close');
    if (segment.portrait) add(segment, segment.portrait.range, 'portrait');
    if (segment.scene) for (const match of source.text.slice(segment.scene.range.start, segment.scene.range.end).matchAll(/[⟦@⟧]/gu)) add(segment, { start: segment.scene.range.start + match.index, end: segment.scene.range.start + match.index + 1 }, 'scene');
    if (segment.kind === 'evaluation') for (const match of source.text.slice(segment.bodyRange.start, segment.bodyRange.end).matchAll(/<(?:Revision|Development)\s*Report>/gu)) add(segment, { start: segment.bodyRange.start + match.index, end: segment.bodyRange.start + match.index + match[0].length }, 'report');
  }
  return markers.sort((a, b) => a.range.start - b.range.start);
}
/** Structural validation only; translation meaning/quality still requires separate evaluation. */
export function validateHiddenTranslation(source: HiddenSource, translatedText: string): { ok: boolean; diagnostics: HiddenDiagnostic[] } {
  const original = parseHiddenStory(source), translated = parseHiddenStory({ ...source, text: translatedText }), diagnostics = [...original.diagnostics.filter(item => item.severity === 'error'), ...translated.diagnostics.filter(item => item.severity === 'error')];
  const shape = (document: HiddenDocument, text: string) => document.segments.filter(segment => text.slice(segment.range.start, segment.range.end).trim()).map(segment => segment.kind);
  if (JSON.stringify(shape(original, source.text)) !== JSON.stringify(shape(translated, translatedText))) diagnostics.push({ code: 'HIDDEN_TRANSLATION_COVERAGE', severity: 'error' });
  const markers = (value: HiddenSource) => hiddenTranslationMarkers(value).map(marker => [marker.kind, marker.literal]);
  if (JSON.stringify(markers(source)) !== JSON.stringify(markers({ ...source, text: translatedText }))) diagnostics.push({ code: 'HIDDEN_TRANSLATION_MARKERS', severity: 'error' });
  return { ok: !diagnostics.some(item => item.severity === 'error'), diagnostics };
}

export const HIDDEN_COLORS = ['#00FFFF', '#FAF0E6', '#696969', '#E6E6FA', '#7FFFD4', '#8FBC8F', '#7CFC00', '#1E90FF', '#DC143C', '#FFA500', '#8000', '#2C3539', '#FF1493', '#FAAFBA', '#F75D59'] as const;
