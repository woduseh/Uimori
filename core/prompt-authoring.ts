/** Trusted authoring-time helpers. The result is a data-only PromptProgram. */
import { validatePromptProgram, type PromptBlock, type PromptControl, type PromptExpression, type PromptProgram, type PromptRoleName, type PromptTemplate, type PromptValue, type RuntimeValue } from './prompt-program.js';
import { validateRuntimeValue } from './prompt-values.js';

const expressionBrand:unique symbol=Symbol('uimori.prompt-expression');
export type Expression<T extends RuntimeValue = RuntimeValue> = { readonly ast: PromptExpression; readonly valueType?: T; readonly [expressionBrand]: true };
export type Operand<T extends RuntimeValue = RuntimeValue> = T | Expression<T>;
export type Option<T extends PromptValue = PromptValue> = { readonly definition: Omit<PromptControl, 'id'>; readonly valueType?: T };
type Common = { label: string; description?: string };
const ref = <T extends RuntimeValue>(ast: PromptExpression): Expression<T> => ({ ast,[expressionBrand]:true });
const ast = (value: Operand): PromptExpression => value !== null && typeof value === 'object' ? expressionBrand in value ? (value as Expression).ast : {literal:validateRuntimeValue(value)} : value;
const operation = <T extends RuntimeValue>(op: Extract<PromptExpression, { op: string }>['op'], args: Operand[]): Expression<T> => ref({ op, args: args.map(ast) });

export const option = {
  boolean: (input: Common & { default: boolean | null }): Option<boolean | null> => ({ definition: { ...input, type: 'boolean' } }),
  number: (input: Common & { default: number | null; min?: number; max?: number }): Option<number | null> => ({ definition: { ...input, type: 'number' } }),
  text: (input: Common & { default: string | null }): Option<string | null> => ({ definition: { ...input, type: 'text' } }),
  select: <const T extends Exclude<PromptValue, null>>(input: Common & { options: readonly { label: string; value: T }[]; default: NoInfer<T> | null }): Option<T | null> => ({ definition: { ...input, type: 'select', options: input.options.map(value => ({ ...value })) } }),
};

export const expr = {
  literal: <T extends RuntimeValue>(value: T): Expression<T> => ref(ast(value)),
  context: <T extends RuntimeValue=RuntimeValue>(...path:string[]):Expression<T>=>ref({context:path}),
  local: <T extends RuntimeValue=RuntimeValue>(name:string,...path:string[]):Expression<T>=>ref({local:name,...(path.length?{path}:{})}),
  equal: <T extends PromptValue>(left: Operand<T>, right: Operand<NoInfer<T>>): Expression<boolean> => operation('equal', [left, right]),
  notEqual: <T extends PromptValue>(left: Operand<T>, right: Operand<NoInfer<T>>): Expression<boolean> => operation('notEqual', [left, right]),
  greater: (left: Operand<number | null>, right: Operand<number | null>): Expression<boolean> => operation('greater', [left, right]),
  greaterEqual: (left: Operand<number | null>, right: Operand<number | null>): Expression<boolean> => operation('greaterEqual', [left, right]),
  less: (left: Operand<number | null>, right: Operand<number | null>): Expression<boolean> => operation('greater', [right, left]),
  lessEqual: (left: Operand<number | null>, right: Operand<number | null>): Expression<boolean> => operation('greaterEqual', [right, left]),
  all: (...args: Operand<boolean | null>[]): Expression<boolean> => operation('all', args),
  any: (...args: Operand<boolean | null>[]): Expression<boolean> => operation('any', args),
  not: (value: Operand<boolean | null>): Expression<boolean> => operation('not', [value]),
  length: (value: Operand<string | null>): Expression<number> => operation('length', [value]),
  replace: (value: Operand<string | null>, from: Operand<string>, to: Operand<string>): Expression<string> => operation('replace', [value, from, to]),
  add:(a:Operand<number|null>,b:Operand<number|null>):Expression<number>=>operation('add',[a,b]),
  subtract:(a:Operand<number|null>,b:Operand<number|null>):Expression<number>=>operation('subtract',[a,b]),
  multiply:(a:Operand<number|null>,b:Operand<number|null>):Expression<number>=>operation('multiply',[a,b]),
  divide:(a:Operand<number|null>,b:Operand<number|null>):Expression<number>=>operation('divide',[a,b]),
  mod:(a:Operand<number|null>,b:Operand<number|null>):Expression<number>=>operation('mod',[a,b]),
  pow:(a:Operand<number|null>,b:Operand<number|null>):Expression<number>=>operation('pow',[a,b]),
  clamp:(value:Operand<number|null>,min:Operand<number|null>,max:Operand<number|null>):Expression<number>=>operation('clamp',[value,min,max]),
  round:(value:Operand<number|null>,digits?:Operand<number>):Expression<number>=>operation('round',digits===undefined?[value]:[value,digits]),
  floor:(value:Operand<number|null>):Expression<number>=>operation('floor',[value]),
  ceil:(value:Operand<number|null>):Expression<number>=>operation('ceil',[value]),
  abs:(value:Operand<number|null>):Expression<number>=>operation('abs',[value]),
  min:(values:Operand<number[]>):Expression<number|null>=>operation('min',[values]),
  max:(values:Operand<number[]>):Expression<number|null>=>operation('max',[values]),
  sum:(values:Operand<number[]>):Expression<number>=>operation('sum',[values]),
  average:(values:Operand<number[]>):Expression<number|null>=>operation('average',[values]),
  gt:(a:Operand<number|null>,b:Operand<number|null>):Expression<boolean>=>operation('gt',[a,b]),
  gte:(a:Operand<number|null>,b:Operand<number|null>):Expression<boolean>=>operation('gte',[a,b]),
  lt:(a:Operand<number|null>,b:Operand<number|null>):Expression<boolean>=>operation('lt',[a,b]),
  lte:(a:Operand<number|null>,b:Operand<number|null>):Expression<boolean>=>operation('lte',[a,b]),
  contains:(value:Operand<string>,part:Operand<string>):Expression<boolean>=>operation('contains',[value,part]),
  startsWith:(value:Operand<string>,part:Operand<string>):Expression<boolean>=>operation('startsWith',[value,part]),
  endsWith:(value:Operand<string>,part:Operand<string>):Expression<boolean>=>operation('endsWith',[value,part]),
  trim:(value:Operand<string>):Expression<string>=>operation('trim',[value]),
  lower:(value:Operand<string>):Expression<string>=>operation('lower',[value]),
  upper:(value:Operand<string>):Expression<string>=>operation('upper',[value]),
  split:(value:Operand<string>,separator:Operand<string>):Expression<string[]>=>operation('split',[value,separator]),
  join:(value:Operand<string[]>,separator:Operand<string>):Expression<string>=>operation('join',[value,separator]),
  get:<T extends RuntimeValue=RuntimeValue>(value:Operand,key:Operand<string|number>):Expression<T|null>=>operation('get',[value,key]),
  size:(value:Operand<string|RuntimeValue[]|{[key:string]:RuntimeValue}>):Expression<number>=>operation('size',[value]),
  slice:<T extends string|RuntimeValue[]>(value:Operand<T>,from:Operand<number>,to?:Operand<number>):Expression<T>=>operation('slice',to===undefined?[value,from]:[value,from,to]),
  range:(start:Operand<number>,end?:Operand<number>,step?:Operand<number>):Expression<number[]>=>operation('range',end===undefined?[start]:step===undefined?[start,end]:[start,end,step]),
  unique:<T extends RuntimeValue>(values:Operand<T[]>):Expression<T[]>=>operation('unique',[values]),
  append:<T extends RuntimeValue>(values:Operand<T[]>,value:Operand<T>):Expression<T[]>=>operation('append',[values,value]),
  concatArrays:<T extends RuntimeValue>(...values:Operand<T[]>[]):Expression<T[]>=>operation('concatArrays',values),
  setAt:<T extends RuntimeValue>(values:Operand<T[]>,index:Operand<number>,value:Operand<T>):Expression<T[]>=>operation('setAt',[values,index,value]),
  merge:(left:Operand<Record<string,RuntimeValue>>,right:Operand<Record<string,RuntimeValue>>):Expression<Record<string,RuntimeValue>>=>operation('merge',[left,right]),
  exists:(value:Operand):Expression<boolean>=>operation('exists',[value]),
  coalesce:<T extends RuntimeValue>(value:Operand<T|null>,fallback:Operand<T>):Expression<T>=>operation('coalesce',[value,fallback]),
  typedIf:<T extends RuntimeValue>(condition:Operand<boolean|null>,yes:Operand<T>,no:Operand<T>):Expression<T>=>operation('typedIf',[condition,yes,no]),
  typedEqual:(a:Operand,b:Operand):Expression<boolean>=>operation('typedEqual',[a,b]),
  array:<T extends RuntimeValue>(...values:Operand<T>[]):Expression<T[]>=>operation('array',values),
  object:(fields:Record<string,Operand>):Expression<Record<string,RuntimeValue>>=>operation('object',Object.entries(fields).flatMap(([key,value])=>[key,value])),
  map:<T extends RuntimeValue,U extends RuntimeValue>(source:Operand<T[]>,as:string,project:(value:Expression<T>,index:Expression<number>)=>Operand<U>,index=`${as}_index`):Expression<U[]>=>ref({op:'map',as,index,args:[ast(source),ast(project(ref({local:as}),ref({local:index})))]}),
  filter:<T extends RuntimeValue>(source:Operand<T[]>,as:string,predicate:(value:Expression<T>,index:Expression<number>)=>Operand<boolean|null>,index=`${as}_index`):Expression<T[]>=>ref({op:'filter',as,index,args:[ast(source),ast(predicate(ref({local:as}),ref({local:index})))]}),
  datePart:(iso:Operand<string>,part:Operand<'year'|'month'|'day'|'weekday'|'hour'|'minute'>):Expression<number>=>operation('datePart',[iso,part]),
  dateAddDays:(iso:Operand<string>,days:Operand<number>):Expression<string>=>operation('dateAddDays',[iso,days]),
  dateFormat:(iso:Operand<string>,format:Operand<'date'|'time'|'iso'>):Expression<string>=>operation('dateFormat',[iso,format]),
};

type Body = string | PromptTemplate;
const body = (value: Body): PromptTemplate => typeof value === 'string' ? [{ kind: 'text', text: value }] : structuredClone(value);

/** Values and slots are AST nodes, never interpolated source code or parsed delimiters. */
export function text(parts: TemplateStringsArray, ...values: (PromptValue | Expression | PromptTemplate)[]): PromptTemplate {
  const nodes: PromptTemplate = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) nodes.push({ kind: 'text', text: parts[i] });
    if (i < values.length) { const value = values[i]; if (Array.isArray(value)) nodes.push(...structuredClone(value)); else nodes.push({ kind: 'value', expression: structuredClone(ast(value)) }); }
  }
  return nodes;
}
export const slotText = (name: string): PromptTemplate => [{ kind: 'slot', name }];
export function choose(condition: Operand<boolean | null>, yes: Body, no?: Body, options: { trimLines?: boolean } = {}): PromptTemplate {
  return [{ kind: 'if', condition: structuredClone(ast(condition)), then: body(yes), ...(no === undefined ? {} : { else: body(no) }), ...options }];
}
export function each<T extends RuntimeValue>(source:Operand<T[]>,as:string,content:(value:Expression<T>,index:Expression<number>)=>Body,options:{index?:string;otherwise?:Body}={}):PromptTemplate {
  const index=options.index??`${as}_index`;return [{kind:'each',source:ast(source),as,index,body:body(content(ref({local:as}),ref({local:index}))),...(options.otherwise===undefined?{}:{else:body(options.otherwise)})}];
}
export function letValue<T extends RuntimeValue>(name:string,value:Operand<T>,content:(bound:Expression<T>)=>Body):PromptTemplate {
  return [{kind:'let',name,value:ast(value),body:body(content(ref({local:name})))}];
}
export const system = (id: string, template: Body, title = id): PromptBlock => ({ id, title, kind: 'message', role: 'system', template: body(template) });
export const user = (id: string, template: Body, title = id): PromptBlock => ({ id, title, kind: 'message', role: 'user', template: body(template) });
export const assistant = (id: string, template: Body, options: { title?: string; completion?: 'complete' | 'prefill' } = {}): PromptBlock => ({ id, title: options.title ?? id, kind: 'message', role: 'assistant', template: body(template), ...(options.completion ? { completion: options.completion } : {}) });
export const history = (id = 'history', from = 0, to: number | 'end' = 'end'): PromptBlock => ({ id, title: id, kind: 'history', from, to });
export const current = (id = 'current'): PromptBlock => ({ id, title: id, kind: 'current' });
export const slot = (id: string, name: string, options: { role?: PromptRoleName; title?: string; template?: Body } = {}): PromptBlock => ({ id, title: options.title ?? id, kind: 'slot', role: options.role ?? 'system', slot: name, ...(options.template === undefined ? {} : { template: body(options.template) }) });
export const cache = (id: string, options: { depth?: number; role?: 'all' | 'user' | 'assistant'; policy?: 'prefer' | 'require'; title?: string } = {}): PromptBlock => ({ id, title: options.title ?? id, kind: 'cache', depth: options.depth ?? 1, role: options.role ?? 'all', policy: options.policy ?? 'prefer' });
/** Combines with an existing block condition instead of silently replacing it. */
export function when(condition: Operand<boolean | null>, block: PromptBlock): PromptBlock {
  return { ...structuredClone(block), when: block.when === undefined ? structuredClone(ast(condition)) : { op: 'all', args: [structuredClone(block.when), structuredClone(ast(condition))] } };
}

type OptionExpressions<C extends Record<string, Option>> = { readonly [K in keyof C]: Expression<C[K] extends Option<infer T> ? T : never> };
export function definePrompt<const C extends Record<string, Option>>(input: {
  controls: C;
  compose: (context: { options: OptionExpressions<C> }) => PromptBlock[];
  provenance?: PromptProgram['provenance'];
}): PromptProgram {
  const controls = Object.entries(input.controls).map(([id, value]) => ({ ...structuredClone(value.definition), id }));
  const options = Object.fromEntries(controls.map(control => [control.id, ref({ control: control.id })])) as OptionExpressions<C>;
  // This callback executes once, explicitly during trusted artifact authoring. It is never persisted.
  const blocks = input.compose({ options });
  return validatePromptProgram({ version: 1, controls, blocks, ...(input.provenance === undefined ? {} : { provenance: input.provenance }) });
}
