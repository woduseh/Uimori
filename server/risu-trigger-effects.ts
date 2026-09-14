import { EXTENSION_PROGRAM_API, type ExtensionProgram } from '../core/extension-program.js';
import { HOST_TEXT_PAGE_MAX } from '../core/paging.js';
import type { PromptExpression } from '../core/prompt-program.js';
import { RisuCbs, UnsupportedCbs } from './risu-cbs.js';

/** Risu computes these with JavaScript Number and String, so the guest language is JavaScript. */
const OPERATORS: Record<string, (left: string, right: string) => string> = {
  '=': (_left, right) => right,
  '+=': (left, right) => `String(__num(${left}) + Number(${right}))`,
  '-=': (left, right) => `String(__num(${left}) - Number(${right}))`,
  '*=': (left, right) => `String(__num(${left}) * Number(${right}))`,
  '/=': (left, right) => `String(__num(${left}) / Number(${right}))`,
};
const PRELUDE = `const __read = async (key) => {
  let text = '', offset = 0;
  for (;;) {
    const page = await api.host.call('variables.read', {key, offset, limit: ${HOST_TEXT_PAGE_MAX}});
    if (page.value === null || page.value === undefined) return offset === 0 ? 'null' : text;
    text += page.value;
    if (page.nextOffset === null || page.nextOffset === undefined) return text;
    offset = page.nextOffset;
  }
};
const __num = (value) => { const parsed = Number(value); return Number.isNaN(parsed) ? 0 : parsed; };`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only a literal variable read compiles to a host read; other CBS keeps its unsupported notice. */
function readExpression(expression: PromptExpression): string {
  const coalesce = expression as { op?: string; args?: PromptExpression[] };
  if (coalesce?.op !== 'coalesce' || coalesce.args?.length !== 2 || coalesce.args[1] !== 'null')
    throw new UnsupportedCbs('트리거 효과에서 지원하지 않는 CBS가 있어요.');
  const get = coalesce.args[0] as { op?: string; args?: PromptExpression[] };
  const collection = get?.args?.[0] as { context?: string[] } | undefined;
  if (
    get?.op !== 'get' ||
    get.args?.length !== 2 ||
    collection?.context?.length !== 1 ||
    collection.context[0] !== 'variables' ||
    typeof get.args[1] !== 'string'
  )
    throw new UnsupportedCbs('트리거 효과에서 지원하지 않는 CBS가 있어요.');
  return `await __read(${JSON.stringify(get.args[1])})`;
}

function template(cbs: RisuCbs, text: string): { source: string; literal?: string } {
  const nodes = cbs.template(text);
  const parts = nodes.map((node) => {
    if (node.kind === 'text') return JSON.stringify(node.text);
    if (node.kind === 'value') return `String(${readExpression(node.expression)})`;
    throw new UnsupportedCbs('트리거 효과의 조건·반복 CBS는 아직 지원하지 않아요.');
  });
  const literal = nodes.every((node) => node.kind === 'text')
    ? nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('')
    : undefined;
  return {
    source: parts.length ? parts.join(' + ') : '""',
    ...(literal === undefined ? {} : { literal }),
  };
}

export type RisuEffectProgram = {
  program: ExtensionProgram;
  /** Statically known variable names this program writes; a dynamic key is reported instead. */
  writes: string[];
  /** True when the program asks for the chat's extra model call permission. */
  usesModel: boolean;
};
export type RisuEffectOptions = {
  /** Risu skips these effects entirely unless the card declares low level access. */
  lowLevelAccess?: boolean;
};

/** Pure source construction for Risu's declarative trigger effects. Nothing is evaluated here. */
export function buildRisuEffectProgram(
  effects: unknown[],
  options: RisuEffectOptions = {}
): RisuEffectProgram {
  if (!effects.length) throw new UnsupportedCbs('효과가 없는 트리거예요.');
  const cbs = new RisuCbs(new Map(), { names: 'context' });
  const writes: string[] = [];
  let usesModel = false;
  const target = (effect: Record<string, unknown>) => {
    if (typeof effect.inputVar !== 'string' || !effect.inputVar)
      throw new UnsupportedCbs('트리거 효과의 결과 변수 이름이 없어요.');
    const key = template(cbs, effect.inputVar);
    if (key.literal === undefined)
      throw new UnsupportedCbs('실행 시점에 정해지는 변수 이름은 아직 지원하지 않아요.');
    writes.push(key.literal);
    return key.source;
  };
  const statements = effects.flatMap((raw) => {
    const effect = record(raw);
    const type = String(effect?.type);
    if (!effect) throw new UnsupportedCbs('트리거 효과가 올바르지 않아요.');
    // Risu leaves these effects unexecuted unless the card declares low level access.
    if (['runLLM', 'extractRegex'].includes(type) && options.lowLevelAccess !== true) return [];
    if (type === 'setvar') {
      const operator = OPERATORS[String(effect.operator)];
      if (!operator) throw new UnsupportedCbs('지원하지 않는 변수 연산자가 있어요.');
      if (typeof effect.var !== 'string' || typeof effect.value !== 'string')
        throw new UnsupportedCbs('트리거 효과의 변수 이름이나 값이 문자열이 아니에요.');
      const key = template(cbs, effect.var),
        value = template(cbs, effect.value);
      if (key.literal === undefined)
        throw new UnsupportedCbs('실행 시점에 정해지는 변수 이름은 아직 지원하지 않아요.');
      writes.push(key.literal);
      return [
        `{
  const __key = ${key.source};
  const __value = ${value.source};
  await api.host.call('variables.set', {key: __key, value: ${operator('await __read(__key)', '__value')}});
}`,
      ];
    }
    if (type === 'runLLM') {
      if (typeof effect.value !== 'string')
        throw new UnsupportedCbs('트리거 효과의 모델 요청 값이 문자열이 아니에요.');
      const prompt = template(cbs, effect.value),
        key = target(effect);
      usesModel = true;
      return [
        `{
  const __prompt = ${prompt.source};
  if (__prompt.trim().startsWith('<|im_start|>')) throw new Error('RISU_TRIGGER_CHATML_UNSUPPORTED');
  const __response = await api.host.call('model.generate', {prompt: __prompt});
  await api.host.call('variables.set', {key: ${key}, value: __response.status === 'completed' ? __response.text : 'Error: ' + String(__response.error)});
}`,
      ];
    }
    if (type === 'extractRegex') {
      if (
        typeof effect.value !== 'string' ||
        typeof effect.regex !== 'string' ||
        typeof effect.flags !== 'string' ||
        typeof effect.result !== 'string'
      )
        throw new UnsupportedCbs('트리거 정규식 효과의 필드가 문자열이 아니에요.');
      const value = template(cbs, effect.value),
        key = target(effect);
      return [
        `{
  const __value = ${value.source};
  const __match = new RegExp(${JSON.stringify(effect.regex)}, ${JSON.stringify(effect.flags)}).exec(__value);
  if (!__match) throw new Error('RISU_TRIGGER_REGEX_NO_MATCH');
  const __result = ${JSON.stringify(effect.result)}
    .replace(/\\$[0-9]+/g, (__token) => String(__match[Number(__token.slice(1))]))
    .replace(/\\$&/g, __match[0])
    .replace(/\\$\\$/g, '$');
  await api.host.call('variables.set', {key: ${key}, value: __result});
}`,
      ];
    }
    throw new UnsupportedCbs('아직 연결하지 않은 트리거 효과 종류가 있어요.');
  });
  if (!statements.length) throw new UnsupportedCbs('실행할 수 있는 효과가 없는 트리거예요.');
  return {
    program: {
      api: EXTENSION_PROGRAM_API,
      capabilities: usesModel
        ? ['variables.read', 'variables.write', 'model.generate']
        : ['variables.read', 'variables.write'],
      source: `${PRELUDE}\n${statements.join('\n')}\nreturn {state: api.state, result: null};`,
    },
    writes: [...new Set(writes)],
    usesModel,
  };
}
