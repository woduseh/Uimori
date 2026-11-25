import { createRisuCbs } from '../third_party/risuai/cad8595a/cbs-parser.js';
import { registerCBS, type CBSRegisterArg } from '../third_party/risuai/cad8595a/cbs.js';
import type { CbsFunctionCatalog } from '../core/cbs-analysis.js';
import { EXECUTION_INPUT_MAX_CHARS } from '../core/content-limits.js';
import { parseKeyValue, type Database } from '../third_party/risuai/cad8595a/cbs-support.js';
import type { character, RisuModule } from '../third_party/risuai/cad8595a/types.js';
import {
  nativeRisuLore,
  nativeRisuSources,
  normalizeRisuContentSource,
  type RisuContentSource,
} from '../core/risu-native.js';
import { createNativeRisuWorkerSession, runNativeRisuWorker } from './risu-native-worker.js';
import { recordNativeRisuEntropy } from './risu-native-entropy.js';

export type NativeRisuCbsContext = {
  native: RisuContentSource;
  variables: Record<string, string>;
  globalVariables?: Record<string, string>;
  messages?: { role: 'user' | 'char'; data: string }[];
  charName?: string;
  userName?: string;
  persona?: string;
  messageIndex?: number;
  triggerId?: string;
  now?: number;
  random?: () => number;
  displaying?: boolean;
  viewport?: { width: number; height: number };
  modelName?: string;
  maxContext?: number;
  templateDefaultVariables?: string;
  globalNote?: string;
  authorNote?: string;
  assetUrls?: Record<string, string>;
};
const string = (value: unknown) => (typeof value === 'string' ? value : '');

export function createNativeRisuCbs(context: NativeRisuCbsContext) {
  const issues: string[] = [];
  let evaluator: ReturnType<typeof initializeNativeRisuCbs> | undefined;
  return {
    issues,
    parse(text: string, role?: 'system' | 'user' | 'assistant'): string {
      if (text.length > EXECUTION_INPUT_MAX_CHARS) throw new Error('RISU_NATIVE_TEXT_LIMIT');
      if (!/[{}#]|<(?:user|char|bot)>/iu.test(text)) return text;
      evaluator ??= initializeNativeRisuCbs(context, issues);
      return evaluator.parse(text, role);
    },
  };
}

export function nativeRisuVariableDefaults(
  defaultVariables: string,
  templateDefaultVariables?: string
) {
  return Object.fromEntries([
    ...parseKeyValue(templateDefaultVariables),
    ...parseKeyValue(defaultVariables),
  ]);
}

function initializeNativeRisuCbs(context: NativeRisuCbsContext, issues: string[]) {
  const { variables } = context;
  const native = normalizeRisuContentSource(context.native);
  const card = native.card;
  const defaultVariables = nativeRisuSources(native).defaultVariables.text;
  const defaults = nativeRisuVariableDefaults(defaultVariables, context.templateDefaultVariables);
  const messages = context.messages ?? [];
  const chat = {
    message: messages,
    note: context.authorNote ?? '',
    name: 'main',
    localLore: [],
    fmIndex: -1,
    id: native.sourceHash,
    scriptstate: variables,
  };
  const chara = {
    type: 'character',
    name: context.charName ?? string(card.name),
    nickname: '',
    desc: string(card.description),
    personality: '',
    scenario: '',
    exampleMessage: string(card.mes_example),
    firstMessage: string(card.first_mes),
    alternateGreetings: Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [],
    chats: [chat],
    chatPage: 0,
    chaId: native.sourceHash,
    globalLore: nativeRisuLore(native),
    emotionImages: [],
    additionalAssets: native.assets.map((asset) => [
      asset.name,
      asset.uri,
      asset.uri.split('.').pop() ?? 'png',
    ]),
    prebuiltAssetCommand: false,
    prebuiltAssetExclude: [],
    defaultVariables,
  } as unknown as character;
  const database: Database = {
    characters: [chara],
    mainPrompt: '',
    jailbreak: '',
    globalNote: context.globalNote ?? '',
    jailbreakToggle: false,
    maxContext: context.maxContext ?? 0,
    aiModel: context.modelName ?? 'uimori',
    subModel: context.modelName ?? 'uimori',
    language: 'ko',
    globalChatVariables: context.globalVariables ?? {},
    templateDefaultVariables: context.templateDefaultVariables ?? '',
  };
  let deadline = 0;
  const cbs = createRisuCbs({
    getDatabase: () => database,
    getUserName: () => context.userName ?? 'User',
    getPersonaPrompt: () => context.persona ?? '',
    getChatVar: (key) =>
      Object.hasOwn(variables, key)
        ? variables[key]!
        : Object.hasOwn(defaults, key)
          ? defaults[key]!
          : 'null',
    setChatVar: (key, value) => {
      Object.defineProperty(variables, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
    getGlobalChatVar: (key) =>
      Object.hasOwn(context.globalVariables ?? {}, key) ? context.globalVariables![key]! : 'null',
    getModules: () => (native.module ? [native.module as unknown as RisuModule] : []),
    getModuleLorebooks: () => [],
    getModuleAssets: () => native.assets.map((asset) => [asset.name, asset.uri]),
    getSelectedCharID: () => 0,
    getModelInfo: (id) => ({ id, name: id, provider: 0, format: 0, tokenizer: 0 }),
    callInternalFunction: () => '',
    getTriggerId: () => context.triggerId ?? 'null',
    now: () => context.now ?? 0,
    random: () => {
      recordNativeRisuEntropy();
      return (context.random ?? Math.random)();
    },
    getViewport: () => context.viewport,
    findCharacterbyId: (id) => (id === native.sourceHash ? chara : null),
    unsupportedNames: new Set(),
    maxOutputChars: EXECUTION_INPUT_MAX_CHARS,
    checkBudget: () => {
      if (Date.now() > deadline) throw new Error('RISU_NATIVE_CBS_TIMEOUT');
    },
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: 'uimori',
  });
  return {
    parse(text: string, role?: 'system' | 'user' | 'assistant'): string {
      deadline = Date.now() + 500;
      const result = cbs.parse(stripRisuComments(text), {
        chatID: context.messageIndex ?? messages.length - 1,
        chara,
        db: database,
        runVar: true,
        rmVar: false,
        visualize: context.displaying ?? false,
        var: {},
        cbsConditions: {
          firstmsg: !messages.length,
          chatRole: role
            ? role === 'assistant'
              ? 'char'
              : role
            : (messages[context.messageIndex ?? messages.length - 1]?.role ?? 'char'),
        },
      });
      if (result.error) throw new Error(result.error);
      for (const name of result.unsupported) if (!issues.includes(name)) issues.push(name);
      return result.text;
    },
  };
}

export function evaluateNativeRisuCbsInWorker(input: {
  text: string;
  context: NativeRisuCbsContext;
}) {
  const cbs = createNativeRisuCbs(input.context);
  return { text: cbs.parse(input.text), variables: input.context.variables };
}

export function evaluateNativeRisuFieldsInWorker(input: {
  native: RisuContentSource;
  fields: Record<string, string>;
  fieldRoles?: Record<string, 'system' | 'user' | 'assistant'>;
  context: Omit<NativeRisuCbsContext, 'native'>;
}) {
  const context = { ...input.context, native: input.native };
  const cbs = createNativeRisuCbs(context);
  const fields: Record<string, string> = {};
  for (const [key, text] of Object.entries(input.fields))
    Object.defineProperty(fields, key, {
      value: cbs.parse(text, input.fieldRoles?.[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return { fields, variables: context.variables, issues: cbs.issues };
}

export function evaluateNativeRisuFields(input: {
  native: RisuContentSource;
  fields: Record<string, string>;
  fieldRoles?: Record<string, 'system' | 'user' | 'assistant'>;
  context: Omit<NativeRisuCbsContext, 'native'>;
  timeoutMs?: number;
}) {
  return runNativeRisuWorker<{
    fields: Record<string, string>;
    variables: Record<string, string>;
    issues: string[];
  }>(
    new URL('./risu-native-cbs.js', import.meta.url),
    'evaluateNativeRisuFieldsInWorker',
    input,
    input.timeoutMs
  );
}

export function createNativeRisuCbsSession(signal?: AbortSignal) {
  const createWorker = () =>
    createNativeRisuWorkerSession<
      Parameters<typeof evaluateNativeRisuCbsInWorker>[0],
      ReturnType<typeof evaluateNativeRisuCbsInWorker>
    >(
      new URL('./risu-native-cbs.js', import.meta.url),
      'evaluateNativeRisuCbsInWorker',
      undefined,
      signal
    );
  let worker: ReturnType<typeof createWorker> | undefined;
  let evaluating = false,
    closed = false;
  let closing: Promise<void> | undefined;
  return {
    async evaluate(text: string, context: NativeRisuCbsContext): Promise<string> {
      if (closed) throw new Error('RISU_NATIVE_WORKER_CLOSED');
      if (signal?.aborted) throw new Error('CANCELLED');
      if (evaluating) throw new Error('RISU_NATIVE_WORKER_BUSY');
      const current = (worker ??= createWorker());
      evaluating = true;
      try {
        const result = await current.run({ text, context });
        for (const [key, value] of Object.entries(result.variables))
          Object.defineProperty(context.variables, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        return result.text;
      } catch (error) {
        try {
          await current.close();
        } finally {
          worker = undefined;
        }
        throw error;
      } finally {
        evaluating = false;
      }
    },
    close() {
      closed = true;
      return (closing ??= worker?.close() ?? Promise.resolve());
    },
  };
}

let functionCatalog: CbsFunctionCatalog | undefined;

export function nativeRisuCbsFunctionCatalog(): CbsFunctionCatalog {
  if (functionCatalog) return functionCatalog;
  const functions = new Map<string, CbsFunctionCatalog['functions'][number]>();
  const registerFunction: CBSRegisterArg['registerFunction'] = (entry) => {
    functions.delete(entry.name);
    functions.set(entry.name, {
      name: entry.name,
      aliases: entry.alias.filter((alias) => alias !== entry.name),
      description: entry.description,
      ...(entry.deprecated
        ? {
            deprecated: {
              message: entry.deprecated.message,
              ...(entry.deprecated.replacement
                ? { replacement: entry.deprecated.replacement }
                : {}),
            },
          }
        : {}),
      ...(entry.internalOnly ? { internal: true } : {}),
      ...(entry.callback === 'doc_only' ? { documentationOnly: true } : {}),
    });
  };
  registerCBS({ registerFunction } as CBSRegisterArg);
  functionCatalog = { functions: [...functions.values()] };
  return functionCatalog;
}

function stripRisuComments(text: string): string {
  let result = '',
    cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{{//', cursor);
    if (start < 0) return result + text.slice(cursor);
    result += text.slice(cursor, start);
    let depth = 1,
      end = start + 2;
    for (; end < text.length - 1 && depth; end++) {
      const pair = text.slice(end, end + 2);
      if (pair === '{{') {
        depth++;
        end++;
      } else if (pair === '}}') {
        depth--;
        end++;
      }
    }
    if (depth) return result + text.slice(start);
    cursor = end;
  }
  return result;
}
