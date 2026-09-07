import { validatePromptProgram, type PromptProgram, type PromptTemplate, type PromptExpression, type PromptControl, type PromptValue } from './prompt-program.js';
import { HIDDEN_CONTROL_MAP, HiddenStoryError, defaultHiddenStoryConfig, validateHiddenStoryConfig, hiddenConfigIssues, type HiddenStoryConfig, type HiddenControlId } from './hidden-story.js';

export type HiddenConversionIssue = { code: string; disposition: 'unsupported' | 'changed' | 'source-conflict'; sourceIndex?: number; detail: string };
export type HiddenConversion = {
  format: 'uimori-hidden-story-v1'; status: 'partial'; source: { hash: string; moduleId: string; name: string };
  program: PromptProgram; nonsexualProgram: PromptProgram;
  controlMap: { sourceKey: string; nativeId: HiddenControlId; sourceType: string }[];
  picks: { slot: string; choices: string[] }[]; requiredSlots: string[];
  loreMapping: { sourceIndex: number; blockId: string; insertOrder: number; depth: number | null; enabled: boolean }[];
  issues: HiddenConversionIssue[];
};
const fail = (code: string): never => { throw new HiddenStoryError(code); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, maximum = 200_000): string => typeof value === 'string' && value.length <= maximum ? value : fail('HIDDEN_IMPORT_STRING_INVALID');
type Token = { inner: string; end: number };
function token(text: string, start: number): Token {
  let depth = 1, cursor = start + 2;
  while (cursor < text.length) {
    if (text.startsWith('{{', cursor)) { depth++; cursor += 2; }
    else if (text.startsWith('}}', cursor)) { depth--; cursor += 2; if (!depth) return { inner: text.slice(start + 2, cursor - 2), end: cursor }; }
    else cursor++;
    if (depth > 32) fail('HIDDEN_CBS_NESTING_LIMIT');
  }
  return fail('HIDDEN_CBS_UNCLOSED');
}
function splitArguments(text: string): string[] {
  const result: string[] = []; let start = 0, cursor = 0;
  while (cursor < text.length) {
    if (text.startsWith('{{', cursor)) { cursor = token(text, cursor).end; continue; }
    if (text.startsWith('::', cursor)) { result.push(text.slice(start, cursor)); cursor += 2; start = cursor; } else cursor++;
  }
  result.push(text.slice(start)); return result;
}
const boolIds = new Set(HIDDEN_CONTROL_MAP.filter(item => item[2] === 'boolean').map(item => `hidden.${item[1]}`));
function comparison(op: string, left: PromptExpression, right: PromptExpression): PromptExpression {
  const booleanValue = (item: PromptExpression, other: PromptExpression): PromptExpression => typeof other === 'object' && other !== null && 'control' in other && boolIds.has(other.control) && (item === 0 || item === 1) ? item === 1 : item;
  const l = booleanValue(left, right), r = booleanValue(right, left);
  if (op === '<') return { op: 'greater', args: [r, l] };
  if (op === '<=') return { op: 'greaterEqual', args: [r, l] };
  return { op: ({ '=': 'equal', '==': 'equal', '!=': 'notEqual', '>': 'greater', '>=': 'greaterEqual' } as const)[op as '='] ?? fail('HIDDEN_CBS_OPERATOR_UNSUPPORTED'), args: [l, r] };
}
function expression(value: string, map: Map<string, HiddenControlId>): PromptExpression {
  let text = value.trim();
  if (text.startsWith('{{')) { const parsed = token(text, 0); if (parsed.end !== text.length) fail('HIDDEN_CBS_EXPRESSION_UNSUPPORTED'); text = parsed.inner.trim(); }
  if (text.startsWith('?')) {
    text = text.slice(1).trim(); let cursor = 0;
    while (cursor < text.length) {
      if (text.startsWith('{{', cursor)) { cursor = token(text, cursor).end; continue; }
      const operator = text.slice(cursor).match(/^(>=|<=|!=|==|=|>|<)/u);
      if (operator) return comparison(operator[0], expression(text.slice(0, cursor), map), expression(text.slice(cursor + operator[0].length), map));
      cursor++;
    }
    return expression(text, map);
  }
  const args = splitArguments(text), name = args.shift()!;
  if (name === 'getglobalvar') {
    if (args.length !== 1 || !args[0].startsWith('toggle_')) fail('HIDDEN_CBS_GLOBAL_UNSUPPORTED');
    const control = map.get(args[0].slice(7)); if (!control) return fail('HIDDEN_CBS_CONTROL_UNKNOWN'); return { control };
  }
  if (['and', 'all', 'any', 'or', 'not', 'length', 'equal', 'not_equal', 'greater_equal', 'greater'].includes(name)) {
    const values = args.map(arg => expression(arg, map));
    if (['equal', 'not_equal'].includes(name) && values.length === 2) return comparison(name === 'equal' ? '=' : '!=', values[0], values[1]);
    return { op: ({ and: 'all', all: 'all', any: 'any', or: 'any', not: 'not', length: 'length', greater_equal: 'greaterEqual', greater: 'greater' } as const)[name as 'and'] ?? fail('HIDDEN_CBS_OPERATOR_UNSUPPORTED'), args: values };
  }
  if (args.length) fail('HIDDEN_CBS_FUNCTION_UNSUPPORTED');
  if (text === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(text) && Number.isFinite(Number(text))) return Number(text);
  if (text === 'true' || text === 'false') return text === 'true';
  return text;
}
function convertTemplate(text: string, map: Map<string, HiddenControlId>, picks: HiddenConversion['picks'], sourceIndex: number): PromptTemplate {
  let position = 0;
  const parse = (inside = false, depth = 0): { nodes: PromptTemplate; boundary: 'end' | 'else' | 'close' } => {
    if (depth > 32) fail('HIDDEN_CBS_NESTING_LIMIT');
    const nodes: PromptTemplate = [];
    while (position < text.length) {
      const next = text.indexOf('{{', position);
      if (next < 0) { nodes.push({ kind: 'text', text: text.slice(position) }); position = text.length; break; }
      if (next > position) nodes.push({ kind: 'text', text: text.slice(position, next) });
      const parsed = token(text, next), inner = parsed.inner.trim(); position = parsed.end;
      if (inner === '/if' || inner === ':else') { if (!inside) fail('HIDDEN_CBS_ORPHAN_CLOSE'); return { nodes, boundary: inner === '/if' ? 'close' : 'else' }; }
      const condition = inner.match(/^#if(?:_pure)?\s+([\s\S]+)$/u);
      if (condition) {
        const branch = parse(true, depth + 1); if (branch.boundary === 'end') fail('HIDDEN_CBS_UNCLOSED');
        const node: Extract<PromptTemplate[number], { kind: 'if' }> = { kind: 'if', condition: expression(condition[1], map), then: branch.nodes };
        if (branch.boundary === 'else') { const alternate = parse(true, depth + 1); if (alternate.boundary !== 'close') fail('HIDDEN_CBS_UNCLOSED'); node.else = alternate.nodes; }
        nodes.push(node); continue;
      }
      if (inner.startsWith('comment:') || inner.startsWith('comment::')) continue;
      if (inner === 'user') { nodes.push({ kind: 'slot', name: 'hidden.user' }); continue; }
      if (inner.startsWith('pick::')) {
        const choices = splitArguments(inner).slice(1);
        if (!choices.length || choices.length > 20 || choices.some(choice => !['zero', 'one', 'two', 'three', 'four', 'five'].includes(choice))) fail('HIDDEN_PICK_UNSUPPORTED');
        const slot = `hidden.pick.${sourceIndex}.${picks.length}`; picks.push({ slot, choices }); nodes.push({ kind: 'slot', name: slot }); continue;
      }
      if (inner.startsWith('#') || inner.startsWith('/')) fail('HIDDEN_CBS_BLOCK_UNSUPPORTED');
      if (!/^(?:getglobalvar::|\?|and::|all::|any::|or::|not::|length::|equal::|not_equal::|greater_equal::|greater::)/u.test(inner)) fail('HIDDEN_CBS_FUNCTION_UNSUPPORTED');
      nodes.push({ kind: 'value', expression: expression(`{{${parsed.inner}}}`, map) });
    }
    return { nodes, boundary: 'end' };
  };
  return parse().nodes;
}

/** Reads the structured MCP snapshot, never a binary container, script or HTML runtime. */
export function convertHiddenStoryModule(input: unknown): HiddenConversion {
  if (!isObject(input) || !isObject(input.source) || !isObject(input.module)) return fail('HIDDEN_IMPORT_FORMAT');
  const sourceHash = str(input.source.sha256, 64); if (!/^[a-f0-9]{64}$/u.test(sourceHash)) fail('HIDDEN_IMPORT_HASH');
  const module = input.module, moduleId = str(module.id, 200), name = str(module.name, 200), rawControls = str(module.customModuleToggle, 20_000);
  if (!Array.isArray(module.lorebook) || module.lorebook.length > 100 || !Array.isArray(module.regex) || module.regex.length > 100 || !Array.isArray(module.triggers) || module.triggers.length > 100 || typeof module.lua !== 'string') return fail('HIDDEN_IMPORT_SURFACES');
  if (JSON.stringify(input).length > 500_000) fail('HIDDEN_IMPORT_LIMIT');
  const issues: HiddenConversionIssue[] = [], controls: PromptControl[] = [], map = new Map<string, HiddenControlId>(), controlMap: HiddenConversion['controlMap'] = [];
  const defaults = defaultHiddenStoryConfig();
  for (const line of rawControls.split(/\r?\n/u).filter(line => line.trim() && !line.startsWith('='))) {
    const [key, label, kind = 'boolean', rawOptions] = line.split('='), spec = HIDDEN_CONTROL_MAP.find(item => item[0] === key);
    if (!spec || map.has(key) || kind !== spec[2]) return fail('HIDDEN_IMPORT_CONTROL_UNSUPPORTED');
    const nativeId: HiddenControlId = `hidden.${spec[1]}`; map.set(key, nativeId); controlMap.push({ sourceKey: key, nativeId, sourceType: kind });
    const options = kind === 'select' ? (rawOptions ?? '').split(',').map((label, value) => ({ label, value })) : undefined;
    if (options && options.length !== spec[3]) fail('HIDDEN_IMPORT_OPTIONS_CHANGED');
    controls.push({ id: nativeId, label, type: kind as PromptControl['type'], default: defaults.values[nativeId], ...(options ? { options } : {}) });
  }
  if (controls.length !== 35) fail('HIDDEN_IMPORT_CONTROL_COVERAGE');
  const picks: HiddenConversion['picks'] = [], loreMapping: HiddenConversion['loreMapping'] = [], blocks: PromptProgram['blocks'] = [];
  for (const [index, raw] of module.lorebook.entries()) {
    if (!isObject(raw)) return fail('HIDDEN_IMPORT_LORE_INVALID');
    if (raw.mode === 'folder') continue;
    const content = str(raw.content), title = str(raw.comment, 200), sourceIndex = Number.isSafeInteger(raw.sourceIndex) ? Number(raw.sourceIndex) : index;
    const depth = content.match(/^@@depth\s+(\d+)\s*\r?\n/u), body = content.replace(/^@@depth\s+\d+\s*\r?\n/u, '');
    if (/^@@/mu.test(body)) fail('HIDDEN_IMPORT_DECORATOR_UNSUPPORTED');
    const blockId = `hidden.lore.${sourceIndex}`;
    let enabled = raw.alwaysActive === true;
    if (!enabled) issues.push({ code: 'HIDDEN_EXTERNAL_LORE_ACTIVATION', disposition: 'unsupported', sourceIndex, detail: '비상시·빈 키 로어의 외부 활성화는 재현하지 않으며 해당 fragment는 꺼져 있어요.' });
    let template: PromptTemplate;
    try { template = convertTemplate(body, map, picks, sourceIndex); }
    catch (error) { enabled = false; template = [{ kind: 'text', text: body }]; issues.push({ code: error instanceof HiddenStoryError ? error.code : 'HIDDEN_IMPORT_TEMPLATE_FAILED', disposition: 'unsupported', sourceIndex, detail: '변환하지 못한 원본 지침은 보존하지만 실행 fragment에서 제외해요.' }); }
    blocks.push({ id: blockId, title, kind: 'message', role: 'system', enabled, template });
    loreMapping.push({ sourceIndex, blockId, insertOrder: typeof raw.insertorder === 'number' ? raw.insertorder : 0, depth: depth ? Number(depth[1]) : null, enabled });
  }
  issues.push(
    { code: 'HIDDEN_MAIN_PLACEMENT', disposition: 'changed', detail: '상시 로어를 main 창작 message fragment로 변환해요. 파일 순서와 원본 insertorder/depth 메타를 보존하며 호스트가 프롬프트에 명시 배치해요.' },
    { code: 'HIDDEN_SCOPE_CONFLICT', disposition: 'source-conflict', sourceIndex: 0, detail: '원본 global/world-wide 및 테마 인물 확장과 absent-character 금지가 공존해요. 지침을 임의 해결하지 않았어요.' },
    { code: 'HIDDEN_INVASIVE_CSS_SCOPED', disposition: 'changed', detail: '침범 스타일과 bare details selectors는 자기 리더 범위로 제한해요. 다른 패널의 스타일은 바꾸지 않아요.' },
    { code: 'HIDDEN_REGEX_RUNTIME_NOT_IMPORTED', disposition: 'unsupported', detail: 'Risu 정규식 파이프라인·불명확한 order flags·임의 HTML은 실행하지 않아요. 알려진 source tags를 native parser/reader로 표시해요.' },
    { code: 'HIDDEN_EXTERNAL_POLISH_UNSUPPORTED', disposition: 'unsupported', detail: '@hs:와 @hsTitle: 불일치 및 외부 %s 문맥을 필요로 하는 POLISH 연동은 제공하지 않아요.' },
    { code: 'HIDDEN_IMAGE_DENSITY_ZERO_TEMPLATE', disposition: 'source-conflict', sourceIndex: 0, detail: '제어안함 옵션은 원본 template의 숫자가 비어 있어요. wire 지침에서 무제어임을 명시해요.' },
    { code: 'HIDDEN_KOREAN_UNREACHABLE_BRANCH', disposition: 'source-conflict', sourceIndex: 0, detail: 'checkbox에 없는 값2의 hidden-only 한국어 분기는 선택 가능하다고 주장하지 않아요.' },
    { code: 'HIDDEN_REPORT_BRACKETS', disposition: 'source-conflict', sourceIndex: 2, detail: '원본의 bracket 2줄 요구와 bracket 1개의 예제가 달라요. native report는 원문을 바꾸지 않고 구조만 식별해요.' },
    { code: 'HIDDEN_READER_VISIBILITY', disposition: 'changed', detail: '생성 기능을 꺼도 과거 hidden 원문을 지우거나 읽지 못하게 하지 않아요. reader의 접힘은 인물 지식이나 요청 제외와 별개예요.' },
    { code: 'HIDDEN_SAFE_COMBINATION_DEFAULTS', disposition: 'changed', detail: '현재 기본 조합은 비성적 일상·생성OFF·이미지OFF·평가OFF예요. 원본에 저장되지 않은 사용자 선택값을 추정하지 않아요.' },
  );
  if (module.lua.trim()) issues.push({ code: 'HIDDEN_LUA_UNSUPPORTED', disposition: 'unsupported', detail: 'Lua는 실행하지 않아요.' });
  for (const [sourceIndex, trigger] of module.triggers.entries()) {
    const effects = isObject(trigger) && Array.isArray(trigger.effect) ? trigger.effect : [];
    if (effects.some(effect => !isObject(effect) || effect.type !== 'v2Header' || effect.code)) issues.push({ code: 'HIDDEN_TRIGGER_UNSUPPORTED', disposition: 'unsupported', sourceIndex, detail: '동작이 있는 trigger는 native 계약이 없으므로 실행하지 않아요.' });
  }
  const program: PromptProgram = { version: 1, controls, blocks, provenance: { sourceHash, variant: 'hidden-story-general-fiction', conversionVersion: 'uimori-hidden-story-1', notes: issues.map(issue => issue.code) } };
  const nonsexualProgram = structuredClone(program);
  const transform = (nodes: PromptTemplate) => {
    for (const node of nodes) {
      if (node.kind === 'text') {
        node.text = node.text.replace('IF a sexual event occurs, describe it vividly & explicitly without skipping.', 'Keep this attached Hinano combination nonsexual; do not create sexual scenes.');
        node.text = node.text.replace('Prioritize sexual positions.', 'Use nonsexual scene-appropriate images only for this attached combination.');
      } else if (node.kind === 'if') { transform(node.then); if (node.else) transform(node.else); }
    }
  };
  for (const block of nonsexualProgram.blocks) if (block.kind === 'message') transform(block.template);
  nonsexualProgram.provenance!.variant = 'hidden-story-nonsexual-combination';
  issues.push({ code: 'HIDDEN_NONSEXUAL_COMBINATION', disposition: 'changed', detail: 'Hinano와 결합하는 비성적 정책에서만 원본의 성적 장면/이미지 우선 지시를 비성적 범위로 명시 변환해요. 일반 성인 fiction 모듈 전체를 미지원으로 취급하지 않아요.' });
  return { format: 'uimori-hidden-story-v1', status: 'partial', source: { hash: sourceHash, moduleId, name }, program: validatePromptProgram(program), nonsexualProgram: validatePromptProgram(nonsexualProgram), controlMap, picks, requiredSlots: ['hidden.user', ...picks.map(pick => pick.slot)], loreMapping, issues };
}

// Stable per-run choice; not cryptographic randomness. Duplicated entries preserve source weights.
function pickIndex(seed: string, length: number): number { let hash = 2166136261; for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); } return (hash >>> 0) % length; }
export function wireHiddenStoryInstructions(conversion: HiddenConversion, input: unknown, context: { seed: string; userLabel: string }): { program: PromptProgram; values: HiddenStoryConfig['values']; slots: Record<string, string>; choices: Record<string, string>; issues: string[] } {
  const config = validateHiddenStoryConfig(input), issues = hiddenConfigIssues(config);
  if (conversion.format !== 'uimori-hidden-story-v1' || typeof context.seed !== 'string' || !context.seed || context.seed.length > 200 || typeof context.userLabel !== 'string' || !context.userLabel || context.userLabel.length > 200) fail('HIDDEN_WIRE_CONTEXT_INVALID');
  if (issues.includes('HIDDEN_EXTERNAL_POLISH_UNSUPPORTED') || issues.includes('HIDDEN_EXTERNAL_ILLUSTRATION_UNSUPPORTED')) fail(issues.find(issue => issue.endsWith('UNSUPPORTED'))!);
  const program = validatePromptProgram(config.contentPolicy === 'nonsexual' ? conversion.nonsexualProgram : conversion.program), choices: Record<string, string> = {}, slots: Record<string, string> = { 'hidden.user': context.userLabel };
  if (!Array.isArray(conversion.picks) || conversion.picks.length > 50) fail('HIDDEN_PICK_UNSUPPORTED');
  for (const pick of conversion.picks) { if (!/^hidden\.pick\.[0-9]+\.[0-9]+$/u.test(pick.slot) || !Array.isArray(pick.choices) || !pick.choices.length || pick.choices.length > 20 || pick.choices.some(choice => typeof choice !== 'string' || choice.length > 20)) fail('HIDDEN_PICK_UNSUPPORTED'); const value = pick.choices[pickIndex(`${context.seed}:${pick.slot}`, pick.choices.length)]; choices[pick.slot] = value; slots[pick.slot] = value; }
  program.blocks.push({ id: 'hidden.host-contract', title: '히든 창작과 지식 경계', kind: 'message', role: 'system', template: [{ kind: 'text', text: [
    'Hidden stories are creative narrative produced by the main author, not new events invented by auxiliary extraction. Preserve @hsTitle: and @hs delimiters and place hidden stories between main paragraphs. Reader expansion never grants a character knowledge. Unknown actor/knownBy metadata stays unknown; remembered, imagined or believed events are not automatically present world facts. Translate all segments regardless of folding. Never use HTML, CSS or image details as canonical narrative evidence.',
    'Sexual content involving minors is not permitted under any control combination.',
    config.contentPolicy === 'nonsexual' ? 'This attached character combination is nonsexual. Keep narrative, custom themes and imagery nonsexual. Do not convert characters into adults to bypass this boundary.' : 'This is the general-fiction module policy; the separate nonsexual restriction applies only when selected or required by the attached character package.',
    config.values['hidden.imageDensity'] === 4 ? 'Image density is uncontrolled: do not interpret an empty source number as a quota.' : '',
  ].filter(Boolean).join('\n') }] });
  return { program: validatePromptProgram(program), values: structuredClone(config.values), slots, choices, issues: [...conversion.issues.map(issue => issue.code), ...issues] };
}
