import { beforeEach, describe, expect, test } from 'vitest';
import {
  type RisuCbs,
  type RisuCbsParseArg,
  createRisuCbs,
} from '../third_party/risuai/cad8595a/cbs-parser.js';
import {
  type Database,
  type LLMModel,
  createChatVarAccessors,
} from '../third_party/risuai/cad8595a/cbs-support.js';
import type { Chat, character } from '../third_party/risuai/cad8595a/types.js';

// Pins the snapshotted RisuAI CBS evaluator against fake dependencies. Every expected string here was
// derived by reading RisuAI at cad8595a (src/ts/cbs.ts and src/ts/parser/parser.svelte.ts), not by
// running RisuAI.

const NOW_MS = 1_700_000_000_000;
const FIXED_RANDOM = 0.5;

type Fixture = {
  db: Database;
  chat: Chat;
};

function makeFixture(): Fixture {
  const chat = {
    message: [
      { role: 'user', data: 'Where now?' },
      { role: 'char', data: 'North.' },
    ],
    note: '',
    name: 'main',
    localLore: [],
    fmIndex: -1,
    id: 'chat-1',
    scriptstate: { $hp: '10', $flag: '1', $off: '0' },
  } as unknown as Chat;

  const chara = {
    type: 'character',
    name: 'Aria',
    firstMessage: 'Hello there.',
    desc: 'A guide for {{user}}.',
    personality: 'Calm and precise.',
    scenario: 'A dune at dusk.',
    exampleMessage: '',
    alternateGreetings: [],
    chats: [chat],
    chatPage: 0,
    chaId: 'chara-1',
    emotionImages: [],
    additionalAssets: [],
    globalLore: [],
    defaultVariables: 'mood=calm',
  } as unknown as character;

  const db: Database = {
    characters: [chara],
    mainPrompt: 'Be brief.',
    jailbreak: '',
    globalNote: '',
    jailbreakToggle: false,
    maxContext: 4000,
    aiModel: 'gpt-4',
    subModel: 'gpt-4',
    language: 'en',
    globalChatVariables: { toggle_dark: '1' },
    templateDefaultVariables: 'tone=dry',
  };

  return { db, chat };
}

let fixture: Fixture;

function makeCbs(unsupportedNames: Set<string> = new Set()): RisuCbs {
  const { db, chat } = fixture;
  const { getChatVar, setChatVar } = createChatVarAccessors({
    hasCharacter: () => Boolean(db.characters[0]),
    getScriptState: (stateKey) => chat.scriptstate?.[stateKey],
    setScriptState: (stateKey, value) => {
      chat.scriptstate ??= {};
      chat.scriptstate[stateKey] = value;
    },
    getCharacterDefaultVariables: () => (db.characters[0] as character).defaultVariables,
    getTemplateDefaultVariables: () => db.templateDefaultVariables,
  });

  return createRisuCbs({
    getDatabase: () => db,
    getUserName: () => 'Jae',
    getPersonaPrompt: () => 'A traveler.',
    getChatVar,
    setChatVar: (key, value) => {
      setChatVar(key, value);
    },
    getGlobalChatVar: (key) => db.globalChatVariables[key] ?? 'null',
    getModules: () => [],
    getModuleLorebooks: () => [],
    getSelectedCharID: () => 0,
    getModelInfo: () =>
      ({
        id: 'gpt-4',
        name: 'GPT-4',
        shortName: 'GPT4',
        internalID: 'gpt-4',
        provider: 0,
        format: 0,
        tokenizer: 0,
      }) satisfies LLMModel,
    callInternalFunction: () => '',
    getTriggerId: () => 'null',
    now: () => NOW_MS,
    random: () => FIXED_RANDOM,
    findCharacterbyId: () => null,
    getModuleAssets: () => [],
    unsupportedNames,
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: '1.2.3',
  });
}

function run(text: string, arg: RisuCbsParseArg = {}) {
  return makeCbs().parse(text, arg);
}

beforeEach(() => {
  fixture = makeFixture();
});

describe('names and arguments', () => {
  test('{{char}} and {{user}} resolve through the injected database and user name', () => {
    expect(run('{{char}} meets {{user}}').text).toBe('Aria meets Jae');
  });

  test('<char> and <user> are rewritten to CBS tags before evaluation', () => {
    expect(run('<char> meets <user>').text).toBe('Aria meets Jae');
  });

  test('names are normalized: case, underscores and single-colon arguments', () => {
    expect(run('{{Get_Var::mood}}').text).toBe('calm');
    expect(run('{{getvar:mood}}').text).toBe('calm');
  });
});

describe('variables', () => {
  test('{{getvar}} reads a stored value, a default variable, then falls back to null', () => {
    expect(run('{{getvar::hp}}').text).toBe('10');
    expect(run('{{getvar::mood}}').text).toBe('calm');
    expect(run('{{getvar::tone}}').text).toBe('dry');
    expect(run('{{getvar::nothing}}').text).toBe('null');
  });

  test('{{setvar}} writes only with runVar, and the write is visible to a later {{getvar}}', () => {
    expect(run('{{setvar::hp::7}}{{getvar::hp}}', { runVar: true }).text).toBe('7');
    expect(fixture.chat.scriptstate?.$hp).toBe('7');
  });

  test('{{setvar}} without runVar is left literal and writes nothing', () => {
    expect(run('{{setvar::hp::7}}').text).toBe('{{setvar::hp::7}}');
    expect(fixture.chat.scriptstate?.$hp).toBe('10');
  });
});

describe('arithmetic and entropy', () => {
  test('{{calc}} and {{? }} both go through calcString', () => {
    expect(run('{{calc::1+2}}').text).toBe('3');
    expect(run('{{? 1+2}}').text).toBe('3');
  });

  test('{{random}} and {{roll}} draw from the injected random()', () => {
    expect(run('{{random}}').text).toBe('0.5');
    expect(run('{{random::a::b::c}}').text).toBe('b');
    expect(run('{{roll::1d6}}').text).toBe('4');
  });

  test('{{unixtime}} reads the injected clock', () => {
    expect(run('{{unixtime}}').text).toBe('1700000000');
  });
});

describe('conditional blocks', () => {
  test('{{#if}} trims its body, {{#if_pure}} keeps it, and a falsy condition drops it', () => {
    expect(run('{{#if 1}}\n  yes\n{{/if}}').text).toBe('yes');
    expect(run('{{#if_pure 1}}\n  yes\n{{/if_pure}}').text).toBe('\n  yes\n');
    expect(run('{{#if 0}}\n  yes\n{{/if}}').text).toBe('');
  });

  test('{{#when::var::x}} branches on a chat variable, with {{:else}} on its own line', () => {
    expect(run('{{#when::var::flag}}\non\n{{:else}}\noff\n{{/when}}').text).toBe('on');
    expect(run('{{#when::var::off}}\non\n{{:else}}\noff\n{{/when}}').text).toBe('off');
  });

  test('{{#when}} supports > and <, with a single-line {{:else}}', () => {
    expect(run('{{#when::10::>::3}}big{{/when}}').text).toBe('big');
    expect(run('{{#when::10::<::3}}big{{:else}}small{{/when}}').text).toBe('small');
  });

  test('the keep operator stops {{#when}} from stripping blank lines', () => {
    expect(run('{{#when::1}}\n  spaced  \n{{/when}}').text).toBe('  spaced  ');
    expect(run('{{#when::keep::1}}\n  spaced  \n{{/when}}').text).toBe('\n  spaced  \n');
  });
});

describe('loops and functions', () => {
  test('{{#each}} expands {{slot}} once per array element', () => {
    expect(run('{{#each ["a","b"] as v}}[{{slot::v}}]{{/each}}').text).toBe('[a][b]');
  });

  test('{{#func}} defines a body that {{call}} runs with {{arg}} substitution', () => {
    expect(run('{{#func greet}}Hi {{arg::1}}!{{/func}}{{call::greet::Bob}}').text).toBe('Hi Bob!');
  });

  test('the call stack limit stops runaway recursion with its exact message', () => {
    expect(run('{{user}}', { callStack: 20 }).text).toBe('ERROR: Call stack limit reached');
    expect(run('{{user}}', { callStack: 19 }).text).toBe('Jae');
  });
});

describe('chat and character data', () => {
  test('{{lastmessage}} and {{previous_chat_log}} read the selected chat', () => {
    expect(run('{{lastmessage}}').text).toBe('North.');
    expect(run('{{previous_chat_log::1}}').text).toBe('North.');
    expect(run('{{previous_chat_log::9}}').text).toBe('Out of range');
  });

  test('{{history}} prepends the first message and JSON-encodes every entry', () => {
    const result = run('{{history}}');
    expect(JSON.parse(result.text)).toEqual([
      '{"role":"char","data":"Hello there."}',
      '{"role":"user","data":"Where now?"}',
      '{"role":"char","data":"North."}',
    ]);
  });

  test('{{description}} and {{personality}} are re-parsed as CBS', () => {
    expect(run('{{description}}').text).toBe('A guide for Jae.');
    expect(run('{{personality}}').text).toBe('Calm and precise.');
  });
});

describe('comments', () => {
  test('{{comment}} is dropped outside display mode', () => {
    expect(run('a{{comment::hidden}}b').text).toBe('ab');
  });

  test('{{//...}} has no registration upstream, so it stays literal and is reported', () => {
    const result = run('a{{//note}}b');
    expect(result.text).toBe('a{{//note}}b');
    expect(result.unsupported).toEqual(['//note']);
  });
});

describe('unsupported names', () => {
  test('a name in unsupportedNames evaluates to an empty string and is reported', () => {
    const result = makeCbs(new Set(['asset'])).parse('<{{asset::sunset}}>', {});
    expect(result.text).toBe('<>');
    expect(result.unsupported).toEqual(['asset']);
  });

  test('a name with no registration is reported and left literal', () => {
    const result = run('a{{nosuchthing}}b');
    expect(result.text).toBe('a{{nosuchthing}}b');
    expect(result.unsupported).toEqual(['nosuchthing']);
  });

  test('a supported text reports nothing', () => {
    expect(run('{{char}}').unsupported).toEqual([]);
  });

  test('two evaluators do not share their matcher maps', () => {
    const strict = makeCbs(new Set(['char']));
    const plain = makeCbs();
    expect(strict.parse('{{char}}', {}).text).toBe('');
    expect(plain.parse('{{char}}', {}).text).toBe('Aria');
  });
});
