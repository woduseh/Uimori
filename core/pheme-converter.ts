import { resolvePromptValues, validatePromptProgram, type PromptBlock, type PromptCombination, type PromptControl, type PromptExpression, type PromptProgram, type PromptTemplate, type PromptValue } from './prompt-program.js';

/** Structural import only. No binary decoding, model settings, script execution or network access. */
export class PhemeConversionError extends Error {
  constructor(readonly code: string, readonly itemId?: string, readonly offset?: number) {
    super(`${code}${itemId ? ` (${itemId})` : ''}${offset === undefined ? '' : ` at ${offset}`}`);
    this.name = 'PhemeConversionError';
  }
}
const fail = (code: string, itemId?: string, offset?: number): never => { throw new PhemeConversionError(code, itemId, offset); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('PHEME_EXPECTED_OBJECT');
const string = (value: unknown, code = 'PHEME_EXPECTED_STRING'): string => typeof value === 'string' ? value : fail(code);
const operation = (op: Extract<PromptExpression, { op: string }>['op'], ...args: PromptExpression[]): PromptExpression => ({ op, args });

/** Splits delimiters only outside nested CBS expressions. */
function argumentsOf(text: string): string[] {
  const result: string[] = []; let depth = 0; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('{{', i)) { depth++; i++; }
    else if (text.startsWith('}}', i)) { if (--depth < 0) fail('PHEME_UNBALANCED_EXPRESSION'); i++; }
    else if (depth === 0 && text.startsWith('::', i)) { result.push(text.slice(start, i)); start = i + 2; i++; }
  }
  if (depth) fail('PHEME_UNBALANCED_EXPRESSION');
  result.push(text.slice(start)); return result;
}
function tokenAt(source: string, start: number, itemId?: string): { body: string; end: number } {
  let depth = 1;
  for (let i = start + 2; i < source.length; i++) {
    if (source.startsWith('{{', i)) { if (++depth > 32) fail('PHEME_NESTING_LIMIT', itemId, i); i++; }
    else if (source.startsWith('}}', i)) { if (--depth === 0) return { body: source.slice(start + 2, i), end: i + 2 }; i++; }
  }
  return fail('PHEME_UNCLOSED_TOKEN', itemId, start);
}
function controlReference(raw: string, controls: Set<string>, itemId?: string): PromptExpression {
  if (!controls.has(raw)) fail('PHEME_UNKNOWN_CONTROL', itemId);
  return { control: raw };
}
function expression(raw: string, controls: Set<string>, itemId?: string, depth = 0): PromptExpression {
  if (depth > 32) fail('PHEME_NESTING_LIMIT', itemId);
  if (!raw.startsWith('{{')) {
    if (raw.includes('{{') || raw.includes('}}')) fail('PHEME_MIXED_EXPRESSION_UNSUPPORTED', itemId);
    return raw;
  }
  const token = tokenAt(raw, 0, itemId);
  if (token.end !== raw.length) fail('PHEME_MIXED_EXPRESSION_UNSUPPORTED', itemId);
  const [name, ...args] = argumentsOf(token.body);
  if (name === 'getglobalvar') {
    if (args.length !== 1 || !args[0]?.startsWith('toggle_')) fail('PHEME_GLOBAL_REFERENCE_UNSUPPORTED', itemId);
    return controlReference(args[0].slice(7), controls, itemId);
  }
  const operators = { and: ['all', 2], any: ['any', -1], equal: ['equal', 2], notequal: ['notEqual', 2], greater: ['greater', 2], greaterequal: ['greaterEqual', 2], length: ['length', 1], replace: ['replace', 3] } as const;
  const spec = operators[name as keyof typeof operators];
  if (!spec) fail('PHEME_EXPRESSION_UNSUPPORTED', itemId);
  if (spec[1] === -1 ? args.length < 2 : args.length !== spec[1]) fail('PHEME_EXPRESSION_ARITY', itemId);
  let converted = args.map(arg => expression(arg, controls, itemId, depth + 1));
  // CBS scalar and/any accept exactly "1", not arbitrary non-empty strings.
  if (name === 'and' || name === 'any') converted = converted.map(arg => operation('equal', arg, '1'));
  return operation(spec[0], ...converted);
}
function condition(raw: string, controls: Set<string>, itemId?: string): PromptExpression {
  const args = argumentsOf(raw);
  if (args.length === 1) { const value = expression(raw, controls, itemId); return operation('any', operation('equal', value, '1'), operation('equal', value, 'true')); }
  if (args.length === 2 && args[0] === 'toggle') {
    const value = controlReference(args[1]!, controls, itemId);
    return operation('any', operation('equal', value, '1'), operation('equal', value, 'true'));
  }
  if (args.length === 3 && (args[1] === 'tis' || args[1] === 'tisnot')) return operation(args[1] === 'tis' ? 'equal' : 'notEqual', controlReference(args[0]!, controls, itemId), args[2]!);
  return fail('PHEME_CONDITION_UNSUPPORTED', itemId);
}

/** Limited CBS parser. Substituted slot/control data is never parsed as a new template. */
export function parsePhemeTemplate(source: string, controlIds: string[], options: { itemId?: string; slot?: string } = {}): PromptTemplate {
  if (source.length > 200_000) fail('PHEME_TEMPLATE_LIMIT', options.itemId);
  const controls = new Set(controlIds); let cursor = 0; let count = 0;
  const parse = (depth: number, nested: boolean): { nodes: PromptTemplate; terminator?: string } => {
    if (depth > 32) fail('PHEME_NESTING_LIMIT', options.itemId);
    const nodes: PromptTemplate = [];
    while (cursor < source.length) {
      if (++count > 10_000) fail('PHEME_TEMPLATE_LIMIT', options.itemId);
      const open = source.indexOf('{{', cursor);
      if (open === -1) { const rest = source.slice(cursor); if (rest.includes('}}')) fail('PHEME_UNEXPECTED_CLOSE', options.itemId, cursor); nodes.push({ kind: 'text', text: rest }); cursor = source.length; break; }
      if (open > cursor) { const text = source.slice(cursor, open); if (text.includes('}}')) fail('PHEME_UNEXPECTED_CLOSE', options.itemId, cursor); nodes.push({ kind: 'text', text }); }
      const token = tokenAt(source, open, options.itemId); cursor = token.end;
      if (token.body === ':else' || token.body === '/when') {
        if (!nested) fail('PHEME_UNEXPECTED_BRANCH', options.itemId, open);
        return { nodes, terminator: token.body };
      }
      if (token.body.startsWith('#when::')) {
        const bodyStart = cursor;
        const yes = parse(depth + 1, true); let no: PromptTemplate | undefined;
        if (yes.terminator === ':else') { const result = parse(depth + 1, true); if (result.terminator !== '/when') fail('PHEME_UNCLOSED_CONDITION', options.itemId, open); no = result.nodes; }
        else if (yes.terminator !== '/when') fail('PHEME_UNCLOSED_CONDITION', options.itemId, open);
        const multiline = source.slice(bodyStart, cursor).includes('\n');
        nodes.push({ kind: 'if', condition: condition(token.body.slice(7), controls, options.itemId), then: yes.nodes, ...(no ? { else: no } : {}), ...(multiline ? { trimLines: true } : {}) });
      } else if (token.body === 'char') nodes.push({ kind: 'slot', name: 'char' });
      else if (token.body === 'slot') { if (!options.slot) fail('PHEME_SLOT_CONTEXT_REQUIRED', options.itemId, open); nodes.push({ kind: 'slot', name: options.slot! }); }
      else nodes.push({ kind: 'value', expression: expression(`{{${token.body}}}`, controls, options.itemId) });
    }
    if (nested) fail('PHEME_UNCLOSED_CONDITION', options.itemId, cursor);
    return { nodes };
  };
  return parse(0, false).nodes;
}

function metadata(input: Record<string, unknown>): Record<string, unknown> {
  if (input.fields === undefined) return input;
  const fields = record(input.fields); const result = record(fields.result);
  if (!Array.isArray(result.items)) fail('PHEME_METADATA_UNSUPPORTED');
  return Object.fromEntries((result.items as unknown[]).map(item => { const data = record(record(item).data); return [string(data.field), data.content]; }));
}
function parseControls(raw: string): PromptControl[] {
  const controls: PromptControl[] = []; const ids = new Set<string>();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith('=')) continue;
    const [id, label, type, options, ...extra] = line.split('=');
    if (!id || !label || extra.length || !/^pheme_[a-z0-9_]+$/u.test(id) || ids.has(id)) fail('PHEME_INVALID_CONTROL'); ids.add(id);
    if (type === undefined) controls.push({ id, label, type: 'boolean', default: null });
    else if (type === 'text' || type === 'textarea') { if (options !== undefined) fail('PHEME_INVALID_CONTROL'); controls.push({ id, label, type: 'text', default: null }); }
    else if (type === 'select' && options !== undefined) controls.push({ id, label, type: 'select', default: null, options: options.split(',').map((label, i) => ({ label, value: String(i) })) });
    else fail('PHEME_CONTROL_TYPE_UNSUPPORTED');
  }
  return controls;
}
const roleOf = (value: unknown): 'system' | 'user' | 'assistant' => value === 'bot' ? 'assistant' : value === 'system' || value === 'user' ? value : fail('PHEME_ROLE_UNSUPPORTED');

export type PhemeConversion = { program: PromptProgram; declaredTemplateDefaults: Record<string, string>; suggestedCombination: PromptCombination };
export function convertPhemePreset(value: unknown, options: { sourceHash: string; variant: 'normal' | 'tool-call' }): PhemeConversion {
  const input = record(value); const fields = metadata(input);
  if (!Array.isArray(input.promptTemplate) || input.promptTemplate.length > 300) fail('PHEME_ITEMS_REQUIRED');
  if (!/^[a-f0-9]{64}$/u.test(options.sourceHash)) fail('PHEME_SOURCE_HASH_REQUIRED');
  const controls = parseControls(string(fields.customPromptTemplateToggle)); const controlIds = controls.map(c => c.id);
  const declaredTemplateDefaults: Record<string, string> = {};
  for (const line of string(fields.templateDefaultVariables ?? '').split(/\r?\n/u)) {
    if (!line.trim()) continue; const index = line.indexOf('='); const key = line.slice(0, index);
    if (index < 1 || !controlIds.includes(key)) fail('PHEME_DEFAULT_UNSUPPORTED'); declaredTemplateDefaults[key] = line.slice(index + 1);
  }
  const blocks: PromptBlock[] = (input.promptTemplate as unknown[]).map(raw => {
    const item = record(raw); const id = string(item.id); const title = string(item.name ?? item.id); const base = { id, title };
    const fieldsByType: Record<string, string[]> = { cache: ['depth','role'], chat: ['rangeStart','rangeEnd'], plain: ['text','type2','role'], persona: ['innerFormat','role2'], description: ['innerFormat','role2'], lorebook: ['innerFormat','role2'], memory: ['innerFormat','role2'], authornote: ['innerFormat','defaultText','role2'], postEverything: ['innerFormat','role2'] };
    const supportedFields = fieldsByType[String(item.type)];
    if (!supportedFields) fail('PHEME_ITEM_TYPE_UNSUPPORTED', id);
    if (Object.keys(item).some(key => !['id','name','type',...supportedFields].includes(key))) fail('PHEME_ITEM_FIELDS_UNSUPPORTED', id);
    if (item.type === 'cache') {
      if (!Number.isSafeInteger(item.depth) || !['all','user','bot'].includes(String(item.role))) fail('PHEME_CACHE_UNSUPPORTED', id);
      return { ...base, kind: 'cache', depth: item.depth as number, role: item.role === 'bot' ? 'assistant' : item.role as 'all' | 'user', policy: 'prefer' };
    }
    if (item.type === 'chat') {
      if (!Number.isSafeInteger(item.rangeStart) || item.rangeEnd !== 'end' && !Number.isSafeInteger(item.rangeEnd) || item.rangeStart === -1000) fail('PHEME_HISTORY_UNSUPPORTED', id);
      return { ...base, kind: 'history', from: item.rangeStart as number, to: item.rangeEnd as number | 'end' };
    }
    if (item.type === 'plain') {
      if (!['normal','main','globalNote'].includes(String(item.type2))) fail('PHEME_PLAIN_POSITION_UNSUPPORTED', id);
      return { ...base, kind: 'message', role: roleOf(item.role), completion: 'complete', template: parsePhemeTemplate(string(item.text), controlIds, { itemId: id, ...(item.type2 === 'globalNote' ? { slot: 'globalNote' } : {}) }) };
    }
    const slots: Record<string, string> = { persona: 'persona', description: 'description', lorebook: 'lorebook', memory: 'memory', authornote: 'authorNote', postEverything: 'postEverything' };
    const slot = slots[String(item.type)]; if (!slot) fail('PHEME_ITEM_TYPE_UNSUPPORTED', id);
    if (item.defaultText !== undefined && item.defaultText !== '') fail('PHEME_NONEMPTY_FALLBACK_UNSUPPORTED', id);
    const role = roleOf(item.role2 ?? 'system'); const wrapper = string(item.innerFormat ?? '');
    if (!wrapper) return { ...base, kind: 'slot', role, slot };
    return { ...base, kind: 'slot', role, slot, template: parsePhemeTemplate(wrapper, controlIds, { itemId: id, slot }) };
  });
  let rawSettings = fields.promptSettings;
  if (typeof rawSettings === 'string') { try { rawSettings = JSON.parse(rawSettings); } catch { fail('PHEME_SETTINGS_UNSUPPORTED'); } }
  const settings = rawSettings === undefined ? {} : record(rawSettings);
  if (settings.assistantPrefill || settings.postEndInnerFormat || settings.sendChatAsSystem || settings.sendName) fail('PHEME_SETTINGS_UNSUPPORTED');
  const suggestedValues: Record<string, PromptValue> = Object.fromEntries(controls.map(c => [c.id, c.type === 'boolean' ? false : c.type === 'select' ? c.options![0]!.value : '']));
  for (const [key, val] of Object.entries(declaredTemplateDefaults)) {
    const control = controls.find(c => c.id === key)!;
    if (control.type === 'boolean') { if (val !== '0' && val !== '1') fail('PHEME_DEFAULT_UNSUPPORTED'); suggestedValues[key] = val === '1'; }
    else suggestedValues[key] = val;
  }
  const program = validatePromptProgram({ version: 1, controls, blocks, provenance: { sourceHash: options.sourceHash, variant: options.variant, conversionVersion: 'pheme-structural-1', notes: [
    'Imported from a user-authorized local structured RisuToki read, without model or connection settings.',
    'Unset imported global toggles default to null (CBS display: literal null); declared template chat defaults are separate metadata, not evidence of global toggle state.',
    'Suggested first-option combination is an explicit native choice, overlaid with declared template defaults; it is never automatically selected.',
    'History includes the current user message and uses clamped, end-exclusive source ranges. Cache markers retain backward matching-role depth.',
    'Reference slots currently contain one text message each; mixed-role or multiple source lore/memory/postEverything messages require upstream explicit adaptation.',
    'CBS is compiled to a restricted data-only language. Inserted user slots and control values are not recursively executed.',
    'Tool-call variant describes an available delivery boundary without naming a concrete tool; runtime must bind its authorized internal delivery capability.',
  ] } });
  resolvePromptValues(program, suggestedValues);
  return { program, declaredTemplateDefaults, suggestedCombination: { id: 'pheme-native-start', title: '명시적 시작 설정', values: suggestedValues } };
}
