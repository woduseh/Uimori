/** A data-only prompt language. Content cannot create tools, wire objects or executable code. */
export type PromptValue = string | number | boolean | null;
export type PromptRoleName = 'system' | 'user' | 'assistant';
export type PromptExpression = PromptValue | { control: string } | { op: 'all' | 'any' | 'not' | 'equal' | 'notEqual' | 'greater' | 'greaterEqual' | 'length' | 'replace'; args: PromptExpression[] };
export type PromptTemplate = ({ kind: 'text'; text: string } | { kind: 'value'; expression: PromptExpression } | { kind: 'slot'; name: string } | { kind: 'if'; condition: PromptExpression; then: PromptTemplate; else?: PromptTemplate; trimLines?: boolean })[];
export type PromptControl = { id: string; label: string; type: 'select' | 'boolean' | 'number' | 'text'; default: PromptValue; options?: { label: string; value: PromptValue }[]; min?: number; max?: number; description?: string };
export type PromptBlock = { id: string; title: string; enabled?: boolean; when?: PromptExpression } & (
  { kind: 'message'; role: PromptRoleName; template: PromptTemplate; completion?: 'complete' | 'prefill' } |
  { kind: 'slot'; role: PromptRoleName; slot: string; template?: PromptTemplate } |
  { kind: 'history'; from: number; to: number | 'end' } |
  { kind: 'current' } |
  { kind: 'cache'; depth: number; role: 'all' | 'user' | 'assistant'; policy: 'prefer' | 'require' }
);
export type PromptProgram = { version: 1; controls: PromptControl[]; blocks: PromptBlock[]; provenance?: { sourceHash: string; variant: string; conversionVersion: string; notes: string[] } };
export type PromptCombination = { id: string; title: string; values: Record<string, PromptValue> };
export type ChatPromptControls = { values: Record<string, PromptValue>; combinations: PromptCombination[]; selectedCombinationId?: string };
export type LogicalMessage = { id: string; role: PromptRoleName; content: { type: 'text'; text: string }[]; completion: 'complete' | 'prefill'; provenance: { blockId: string; origin: 'prompt' | 'history' | 'current'; sourceRevision?: string; sourceHash?: string; runId?: string } };
export type PromptCacheAnchor = { blockId: string; afterMessageId: string; policy: 'prefer' | 'require' };
export type PromptCompilation = { compilerVersion: 'uimori-prompt-1'; values: Record<string, PromptValue>; messages: LogicalMessage[]; cachePlan: PromptCacheAnchor[]; trace: { blockId: string; included: boolean; messageIds: string[]; reason?: string }[]; historyScope: 'm2-recent-or-full'; warnings: string[] };
export type PromptHistoryMessage = { id: string; role: 'user' | 'assistant'; text: string; sourceRevision?: string; sourceHash?: string; runId?: string; current?: boolean };
export type ProviderPrompt = Pick<PromptCompilation,'compilerVersion'|'messages'|'cachePlan'|'values'>;
export class PromptProgramError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string, readonly blockId?: string) { super(`${code}${blockId ? ` (${blockId})` : ''}`); this.name = 'PromptProgramError'; }
}
function fail(code: string, blockId?: string): never { throw new PromptProgramError(code, blockId); }
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail('PROMPT_INVALID_FIELDS');
  return value;
}
function str(value: unknown, max = 200): asserts value is string { if (typeof value !== 'string' || value.length > max) fail('PROMPT_INVALID_STRING'); }
function id(value: unknown): asserts value is string { str(value, 160); if (!value || !/^[a-zA-Z0-9_.:-]+$/u.test(value)) fail('PROMPT_INVALID_ID'); }
function primitive(value: unknown): asserts value is PromptValue { if (value !== null && !['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 200_000) fail('PROMPT_INVALID_VALUE'); }
export function validateProviderPrompt(value:unknown):ProviderPrompt{
  const p=object(value,['compilerVersion','messages','cachePlan','values']);if(p.compilerVersion!=='uimori-prompt-1'||!Array.isArray(p.messages)||p.messages.length<1||p.messages.length>1000||!Array.isArray(p.cachePlan)||p.cachePlan.length>100||!isObject(p.values))fail('PROMPT_INVALID_COMPILED');
  const ids=new Set<string>();for(const raw of p.messages){const m=object(raw,['id','role','content','completion','provenance']);id(m.id);if(ids.has(m.id))fail('PROMPT_DUPLICATE_MESSAGE');ids.add(m.id);if(!['system','user','assistant'].includes(String(m.role))||!['complete','prefill'].includes(String(m.completion))||!Array.isArray(m.content)||m.content.length<1||m.content.length>100)fail('PROMPT_INVALID_MESSAGE');for(const part of m.content){const c=object(part,['type','text']);if(c.type!=='text')fail('PROMPT_TEXT_ONLY');str(c.text,500_000);}const provenance=object(m.provenance,['blockId','origin','sourceRevision','sourceHash','runId']);id(provenance.blockId);if(!['prompt','history','current'].includes(String(provenance.origin)))fail('PROMPT_INVALID_PROVENANCE');for(const key of ['sourceRevision','sourceHash','runId'])if(provenance[key]!==undefined)str(provenance[key]);}
  for(const raw of p.cachePlan){const a=object(raw,['blockId','afterMessageId','policy']);id(a.blockId);id(a.afterMessageId);if(!ids.has(a.afterMessageId)||!['prefer','require'].includes(String(a.policy)))fail('PROMPT_INVALID_CACHE');}
  for(const [key,value]of Object.entries(p.values)){id(key);primitive(value);}
  if(JSON.stringify(value).length>1_500_000)fail('PROMPT_COMPILED_LIMIT');return structuredClone(value)as ProviderPrompt;
}
function expression(value: unknown, controls: Set<string>, depth = 0): void {
  if (depth > 32) fail('PROMPT_NESTING_LIMIT');
  if (!isObject(value)) { primitive(value); return; }
  if ('control' in value) { object(value,['control']); id(value.control); if (!controls.has(value.control)) fail('PROMPT_UNKNOWN_CONTROL'); return; }
  object(value,['op','args']);
  if (!['all','any','not','equal','notEqual','greater','greaterEqual','length','replace'].includes(String(value.op)) || !Array.isArray(value.args) || value.args.length > 100) fail('PROMPT_INVALID_EXPRESSION');
  const counts: Record<string, number> = {not:1,length:1,equal:2,notEqual:2,greater:2,greaterEqual:2,replace:3};
  if (counts[String(value.op)] !== undefined && value.args.length !== counts[String(value.op)]) fail('PROMPT_EXPRESSION_ARITY');
  value.args.forEach(arg => expression(arg, controls, depth + 1));
}
function template(value: unknown, controls: Set<string>, depth = 0): void {
  if (depth > 32 || !Array.isArray(value) || value.length > 5000) fail('PROMPT_TEMPLATE_LIMIT');
  for (const raw of value) {
    if (!isObject(raw)) fail('PROMPT_INVALID_TEMPLATE');
    if (raw.kind === 'text') { object(raw,['kind','text']); str(raw.text, 200_000); }
    else if (raw.kind === 'value') { object(raw,['kind','expression']); expression(raw.expression, controls); }
    else if (raw.kind === 'slot') { object(raw,['kind','name']); id(raw.name); }
    else if (raw.kind === 'if') { object(raw,['kind','condition','then','else','trimLines']); if(raw.trimLines!==undefined&&typeof raw.trimLines!=='boolean')fail('PROMPT_INVALID_TEMPLATE'); expression(raw.condition, controls); template(raw.then, controls, depth+1); if (raw.else !== undefined) template(raw.else, controls, depth+1); }
    else fail('PROMPT_INVALID_TEMPLATE');
  }
}
export function validatePromptProgram(value: unknown): PromptProgram {
  const raw = object(value,['version','controls','blocks','provenance']);
  if (raw.version !== 1 || !Array.isArray(raw.controls) || raw.controls.length > 150 || !Array.isArray(raw.blocks) || raw.blocks.length > 300) fail('PROMPT_PROGRAM_LIMIT');
  const controls = new Set<string>();
  for (const item of raw.controls) {
    const c = object(item,['id','label','type','default','options','min','max','description']); id(c.id); str(c.label); primitive(c.default);
    if (controls.has(c.id) || !['select','boolean','number','text'].includes(String(c.type))) fail('PROMPT_INVALID_CONTROL'); controls.add(c.id);
    if (c.description !== undefined) str(c.description,4000);
    if (c.options !== undefined) { if (!Array.isArray(c.options) || c.options.length > 100) fail('PROMPT_INVALID_OPTIONS'); for (const option of c.options) { const o=object(option,['label','value']); str(o.label); primitive(o.value); } }
    for (const key of ['min','max']) if (c[key] !== undefined && (typeof c[key] !== 'number' || !Number.isFinite(c[key]))) fail('PROMPT_INVALID_RANGE');
    if (c.min !== undefined && c.max !== undefined && Number(c.min)>Number(c.max)) fail('PROMPT_INVALID_RANGE');
    validateControlValue(c as PromptControl,c.default);
  }
  const ids=new Set<string>();
  for (const item of raw.blocks) {
    const b=object(item,['id','title','enabled','when','kind','role','template','completion','slot','from','to','depth','policy']); id(b.id); str(b.title); if(ids.has(b.id)) fail('PROMPT_DUPLICATE_BLOCK',b.id); ids.add(b.id);
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') fail('PROMPT_INVALID_ENABLED',b.id);
    if (b.when !== undefined) expression(b.when,controls);
    if (b.kind==='message' || b.kind==='slot') { if (!['system','user','assistant'].includes(String(b.role))) fail('PROMPT_INVALID_ROLE',b.id); }
    if (b.kind==='message') { template(b.template,controls); if(b.completion!==undefined && !['complete','prefill'].includes(String(b.completion))) fail('PROMPT_INVALID_COMPLETION',b.id); if(b.completion==='prefill'&&b.role!=='assistant') fail('PROMPT_PREFILL_ROLE',b.id); }
    else if(b.kind==='slot') { id(b.slot); if(b.template!==undefined)template(b.template,controls); }
    else if(b.kind==='history') { if(!Number.isSafeInteger(b.from) || (b.to!=='end'&&!Number.isSafeInteger(b.to))) fail('PROMPT_INVALID_HISTORY_RANGE',b.id); }
    else if(b.kind==='cache') { if(!Number.isSafeInteger(b.depth)||Number(b.depth)<1||Number(b.depth)>4||!['all','user','assistant'].includes(String(b.role))||!['prefer','require'].includes(String(b.policy))) fail('PROMPT_INVALID_CACHE',b.id); }
    else if(b.kind!=='current') fail('PROMPT_INVALID_BLOCK',b.id);
  }
  if(raw.provenance!==undefined){const p=object(raw.provenance,['sourceHash','variant','conversionVersion','notes']);str(p.sourceHash,64);str(p.variant);str(p.conversionVersion);if(!Array.isArray(p.notes)||p.notes.length>100)fail('PROMPT_INVALID_PROVENANCE');p.notes.forEach(n=>str(n,4000));}
  if (JSON.stringify(value).length > 1_000_000) fail('PROMPT_PROGRAM_LIMIT');
  return structuredClone(value) as PromptProgram;
}
function validateControlValue(control: PromptControl, value: unknown): asserts value is PromptValue {
  primitive(value);
  // null records an unset imported global toggle; it is not silently coerced to option zero.
  if(value===null)return;
  if(control.type==='select' && !control.options?.some(o=>o.value===value) || control.type==='boolean'&&typeof value!=='boolean' || control.type==='text'&&typeof value!=='string' || control.type==='number'&&(typeof value!=='number'||control.min!==undefined&&value<control.min||control.max!==undefined&&value>control.max)) fail('PROMPT_INVALID_CONTROL_VALUE',control.id);
}
export function resolvePromptValues(program: PromptProgram, values: Record<string, PromptValue> = {}): Record<string, PromptValue> {
  if(!isObject(values)||Object.keys(values).some(key=>!program.controls.some(c=>c.id===key)))fail('PROMPT_UNKNOWN_CONTROL');
  return Object.fromEntries(program.controls.map(c=>{const value=Object.hasOwn(values,c.id)?values[c.id]:c.default;validateControlValue(c,value);return[c.id,value];}));
}
export function validateChatPromptControls(value: unknown): ChatPromptControls {
  const raw=object(value,['values','combinations','selectedCombinationId']);
  const values=(v:unknown)=>{if(!isObject(v)||Object.keys(v).length>150)fail('PROMPT_INVALID_VALUES');for(const [key,item]of Object.entries(v)){id(key);primitive(item);}return structuredClone(v) as Record<string,PromptValue>;};
  const current=values(raw.values);if(!Array.isArray(raw.combinations)||raw.combinations.length>50)fail('PROMPT_COMBINATION_LIMIT');const ids=new Set<string>();
  const combinations=raw.combinations.map(item=>{const c=object(item,['id','title','values']);id(c.id);str(c.title);if(ids.has(c.id))fail('PROMPT_DUPLICATE_COMBINATION');ids.add(c.id);return{id:c.id,title:c.title,values:values(c.values)};});
  if(raw.selectedCombinationId!==undefined){id(raw.selectedCombinationId);if(!ids.has(raw.selectedCombinationId))fail('PROMPT_UNKNOWN_COMBINATION');}
  return {values:current,combinations,...(raw.selectedCombinationId!==undefined?{selectedCombinationId:raw.selectedCombinationId as string}:{})};
}
const truth=(v:PromptValue)=>v!==null&&v!==false&&v!==0&&v!==''&&v!=='0'&&v!=='false'&&v!=='null';
const display=(v:PromptValue)=>v===null?'null':typeof v==='boolean'?(v?'1':'0'):String(v);
export function evaluatePromptExpression(expr:PromptExpression,values:Record<string,PromptValue>):PromptValue {
  if(!isObject(expr))return expr;
  if('control'in expr)return values[expr.control]??null;
  const args=expr.args.map(arg=>evaluatePromptExpression(arg,values));
  switch(expr.op){
    case'all':return args.every(truth);case'any':return args.some(truth);case'not':return!truth(args[0]);
    case'equal':return display(args[0])===display(args[1]);case'notEqual':return display(args[0])!==display(args[1]);
    case'greater':return Number(display(args[0]))>Number(display(args[1]));case'greaterEqual':return Number(display(args[0]))>=Number(display(args[1]));
    case'length':return display(args[0]).length;case'replace':return display(args[0]).replaceAll(display(args[1]),display(args[2]));
  }
}
function render(nodes:PromptTemplate,values:Record<string,PromptValue>,slots:Record<string,string>):string{
  const trimLines=(value:string)=>{const lines=value.split('\n');while(lines.length&&lines[0].trim()==='')lines.shift();while(lines.length&&lines.at(-1)!.trim()==='')lines.pop();return lines.join('\n');};
  return nodes.map(node=>{if(node.kind==='text')return node.text;if(node.kind==='value')return display(evaluatePromptExpression(node.expression,values));if(node.kind==='slot')return Object.hasOwn(slots,node.name)?slots[node.name]:fail('PROMPT_UNKNOWN_SLOT',node.name);const value=render(truth(evaluatePromptExpression(node.condition,values))?node.then:node.else??[],values,slots);return node.trimLines?trimLines(value):value;}).join('');
}
/** History includes the current user turn. Slices are half-open with clamped negative offsets. */
export function compilePromptProgram(program:PromptProgram,context:{values?:Record<string,PromptValue>;slots:Record<string,string>;history:PromptHistoryMessage[]}):PromptCompilation{
  validatePromptProgram(program);const values=resolvePromptValues(program,context.values);const messages:LogicalMessage[]=[];const cachePlan:PromptCacheAnchor[]=[];const trace:PromptCompilation['trace']=[];const warnings:string[]=[];const used=new Set<string>();
  const appendHistory=(item:PromptHistoryMessage,blockId:string)=>{if(used.has(item.id))fail('PROMPT_DUPLICATE_HISTORY',blockId);used.add(item.id);messages.push({id:`${blockId}:${item.id}`,role:item.role,content:[{type:'text',text:item.text}],completion:'complete',provenance:{blockId,origin:item.current?'current':'history',...(item.sourceRevision?{sourceRevision:item.sourceRevision}:{}),...(item.sourceHash?{sourceHash:item.sourceHash}:{}),...(item.runId?{runId:item.runId}:{})}});};
  for(const block of program.blocks){
    const start=messages.length;const included=block.enabled!==false&&(block.when===undefined||truth(evaluatePromptExpression(block.when,values)));
    if(!included){trace.push({blockId:block.id,included:false,messageIds:[],reason:block.enabled===false?'disabled':'condition'});continue;}
    if(block.kind==='message'||block.kind==='slot'){
      const slot=block.kind==='slot'?(Object.hasOwn(context.slots,block.slot)?context.slots[block.slot]:fail('PROMPT_UNKNOWN_SLOT',block.id)):'';
      const text=block.kind==='message'?render(block.template,values,context.slots):slot.length?(block.template?render(block.template,values,{...context.slots,slot}):slot):'';
      if(text.length)messages.push({id:block.id,role:block.role,content:[{type:'text',text}],completion:block.kind==='message'?block.completion??'complete':'complete',provenance:{blockId:block.id,origin:'prompt'}});
    }else if(block.kind==='history'){
      const size=context.history.length;const offset=(n:number)=>Math.min(size,Math.max(0,n<0?size+n:n));const from=offset(block.from),to=block.to==='end'?size:offset(block.to);
      if(from>to)fail('PROMPT_REVERSED_HISTORY',block.id);context.history.slice(from,to).forEach(item=>appendHistory(item,block.id));
    }else if(block.kind==='current')context.history.filter(h=>h.current).forEach(item=>appendHistory(item,block.id));
    else{
      const anchors=messages.filter(m=>block.role==='all'||m.role===block.role).slice(-block.depth);
      if(!anchors.length){if(block.policy==='require')fail('PROMPT_EMPTY_CACHE_ANCHOR',block.id);warnings.push(`PROMPT_EMPTY_CACHE_ANCHOR (${block.id})`);}
      anchors.forEach(m=>cachePlan.push({blockId:block.id,afterMessageId:m.id,policy:block.policy}));
    }
    trace.push({blockId:block.id,included:true,messageIds:messages.slice(start).map(m=>m.id)});
  }
  if(context.history.filter(h=>h.current).length!==1)fail('PROMPT_CURRENT_INPUT_REQUIRED');
  if(context.history.some(h=>!used.has(h.id)))fail('PROMPT_HISTORY_OMITTED');
  if(messages.some((m,i)=>m.completion==='prefill'&&i!==messages.length-1))fail('PROMPT_PREFILL_MUST_BE_LAST');
  if(messages.length>1000||JSON.stringify(messages).length>1_500_000)fail('PROMPT_COMPILED_LIMIT');
  return{compilerVersion:'uimori-prompt-1',values,messages,cachePlan,trace,historyScope:'m2-recent-or-full',warnings};
}
