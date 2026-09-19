import { createRisuCbs } from '../third_party/risuai/cad8595a/cbs-parser.js';
import { parseKeyValue, type Database } from '../third_party/risuai/cad8595a/cbs-support.js';
import type { character, RisuModule } from '../third_party/risuai/cad8595a/types.js';
import {
  nativeRisuExtension,
  nativeRisuLore,
  type RisuContentSource,
} from '../core/risu-native.js';
import { runNativeRisuWorker } from './risu-native-worker.js';

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
  modelName?: string;
  maxContext?: number;
  mainPrompt?: string;
  jailbreak?: string;
  jailbreakToggle?: boolean;
  templateDefaultVariables?: string;
  globalNote?: string;
  assetUrls?: Record<string, string>;
};
const string = (value: unknown) => (typeof value === 'string' ? value : '');

/** Native CBS runs against an explicit chat view; callers decide whether its writes are committed. */
export function createNativeRisuCbs(context: NativeRisuCbsContext) {
  const { native, variables } = context;
  const card = native.card;
  const extension = nativeRisuExtension(native);
  const defaults = Object.fromEntries([
    ...parseKeyValue(context.templateDefaultVariables),
    ...parseKeyValue(string(extension.defaultVariables)),
  ]);
  const messages = context.messages ?? [];
  const chat = {
    message: messages,
    note: '',
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
    personality: string(card.personality),
    scenario: string(card.scenario),
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
    defaultVariables: string(extension.defaultVariables),
  } as unknown as character;
  const database: Database = {
    characters: [chara],
    mainPrompt: context.mainPrompt ?? '',
    jailbreak: context.jailbreak ?? '',
    globalNote: context.globalNote ?? '',
    jailbreakToggle: context.jailbreakToggle ?? false,
    maxContext: context.maxContext ?? 0,
    aiModel: context.modelName ?? 'uimori',
    subModel: context.modelName ?? 'uimori',
    language: 'ko',
    globalChatVariables: context.globalVariables ?? {},
    templateDefaultVariables: context.templateDefaultVariables ?? '',
  };
  const issues: string[] = [];
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
    random: context.random ?? Math.random,
    findCharacterbyId: (id) => (id === native.sourceHash ? chara : null),
    unsupportedNames: new Set(),
    maxOutputChars: 2_000_000,
    checkBudget: () => {
      if (Date.now() > deadline) throw new Error('RISU_NATIVE_CBS_TIMEOUT');
    },
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: 'uimori',
  });
  return {
    issues,
    parse(text: string): string {
      if (text.length > 2_000_000) throw new Error('RISU_NATIVE_TEXT_LIMIT');
      deadline = Date.now() + 500;
      const result = cbs.parse(stripRisuComments(text), {
        chatID: context.messageIndex ?? messages.length - 1,
        chara,
        db: database,
        runVar: true,
        rmVar: false,
        visualize: context.displaying ?? false,
        var: {},
        cbsConditions: { firstmsg: !messages.length, chatRole: messages.at(-1)?.role ?? 'char' },
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
  context: Omit<NativeRisuCbsContext, 'native'>;
}) {
  const context = { ...input.context, native: input.native };
  const cbs = createNativeRisuCbs(context);
  const fields: Record<string, string> = {};
  for (const [key, text] of Object.entries(input.fields))
    Object.defineProperty(fields, key, {
      value: cbs.parse(text),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return { fields, variables: context.variables, issues: cbs.issues };
}

export function evaluateNativeRisuFields(input: {
  native: RisuContentSource;
  fields: Record<string, string>;
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

/** Runtime-facing evaluation is isolated too: CBS itself supports authored regular expressions. */
export async function evaluateRisuNativeCbs(
  text: string,
  context: NativeRisuCbsContext
): Promise<string> {
  const result = await runNativeRisuWorker<{ text: string; variables: Record<string, string> }>(
    new URL('./risu-native-cbs.js', import.meta.url),
    'evaluateNativeRisuCbsInWorker',
    { text, context }
  );
  for (const [key, value] of Object.entries(result.variables))
    Object.defineProperty(context.variables, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result.text;
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
