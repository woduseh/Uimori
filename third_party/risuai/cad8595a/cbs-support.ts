// SPDX-License-Identifier: GPL-3.0-only
// Snapshot of RisuAI (https://github.com/kwaroran/RisuAI) at commit cad8595aa39620df4246f56918f0962c2aa0263a.
// Upstream sources: src/ts/process/infunctions.ts:1-160
//   src/ts/util.ts:503-514,989-1008,1101-1115
//   src/ts/parser/chatVar.svelte.ts:1-38
//   src/ts/polyfill.ts:12-21
//   src/ts/storage/database.svelte.ts:1510-1685 (only the Database members the CBS evaluator reads)
//   src/ts/model/types.ts:104-118
// Copyright (c) Kwaroran and the RisuAI contributors. Licensed under GPL-3.0-only; see ./LICENSE.
// Modifications for Uimori:
//   - calcString: upstream imports getChatVar/getGlobalChatVar from '../parser/chatVar.svelte'. Here
//     createCalcString(accessors) closes over injected accessors and returns the same function; toRPN,
//     calculateRPN and executeRPNCalculation are otherwise copied unchanged.
//   - chatVar.svelte.ts's getChatVar/setChatVar read DBState/selectedCharID and call parseKeyValue on
//     `char.defaultVariables` / `DBState.db.templateDefaultVariables`. Here createChatVarAccessors(store)
//     expresses the same default-variable fallback over injected accessors; the '$' key prefix, the
//     `undefined | null -> default -> 'null'` order and setChatVar's "unchanged returns false" are kept.
//     The `chat.scriptstate ??= {}` initialisation belongs to the store implementation.
//   - safeStructuredClone: the rfdc fallback (an npm dependency) is replaced by a JSON deep copy.
//   - parseKeyValue, sfc32 and pickHashRand are copied verbatim apart from accepting `undefined`
//     (parseKeyValue) and TypeScript annotations.
//   - New, not upstream: base64ToUtf8 / base64ToBytes / bytesToBase64. RisuAI's cbs.ts reaches for Node's
//     `Buffer` in {{file}}, {{xor}} and {{xordecrypt}}; the snapshot may not depend on Node built-ins, so
//     those three call these helpers, which use the standard atob/btoa/TextDecoder globals instead.
//   - New, not upstream: the narrowed `Database` and `LLMModel` interfaces below. Upstream's Database is
//     the whole app-settings root and is deliberately absent from ./types.ts, and LLMModel drags in the
//     model list. Only the members the CBS evaluator actually reads are declared here.
//   - No @ts-nocheck: this file type-checks under `strict`. calculateRPN's `stack.pop()` pair is asserted
//     as `number` (upstream relies on implicit any) and toRPN's operator table carries a Record type.

import type { PromptItem, character, groupChat } from './types.js';

/**
 * The subset of RisuAI's `Database` that the CBS evaluator reads. RisuAI's real Database has hundreds of
 * members; a Uimori facade only has to supply these.
 */
export interface Database {
  characters: (character | groupChat)[];
  mainPrompt: string;
  jailbreak: string;
  globalNote: string;
  jailbreakToggle: boolean;
  maxContext: number;
  aiModel: string;
  subModel: string;
  language: string;
  globalChatVariables: { [key: string]: string };
  templateDefaultVariables?: string;
  promptTemplate?: PromptItem[];
}

/** The subset of RisuAI's `LLMModel` that {{metadata::model*}} reads. */
export interface LLMModel {
  id: string;
  name: string;
  shortName?: string;
  internalID?: string;
  provider: number;
  format: number;
  tokenizer: number;
}

// ---------------------------------------------------------------------------
// src/ts/util.ts:989-1008
// ---------------------------------------------------------------------------

export function parseKeyValue(template: string | undefined | null): [string, string][] {
  try {
    if (!template) {
      return [];
    }

    const keyValue: [string, string][] = [];

    for (const line of template.split('\n')) {
      const [key, value] = line.split('=');
      if (key && value) {
        keyValue.push([key, value]);
      }
    }

    return keyValue;
  } catch (_error) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// src/ts/util.ts:503-514,1101-1115
// ---------------------------------------------------------------------------

export function sfc32(a: number, b: number, c: number, d: number) {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function pickHashRand(cid: number, word: string): number {
  let hashAddress = 5515;
  const rand = (w: string) => {
    for (let counter = 0; counter < w.length; counter++) {
      hashAddress = ((hashAddress << 5) + hashAddress) + w.charCodeAt(counter);
    }
    return hashAddress;
  };
  const randF = sfc32(rand(word), rand(word), rand(word), rand(word));
  const v = cid % 1000;
  for (let i = 0; i < v; i++) {
    randF();
  }
  return randF();
}

// ---------------------------------------------------------------------------
// src/ts/polyfill.ts:12-21
// ---------------------------------------------------------------------------

export function safeStructuredClone<T>(data: T): T {
  try {
    return structuredClone(data);
  } catch (_error) {
    return JSON.parse(JSON.stringify(data)) as T;
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers (Uimori addition, see the header)
// ---------------------------------------------------------------------------

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

// ---------------------------------------------------------------------------
// src/ts/parser/chatVar.svelte.ts:6-38
// ---------------------------------------------------------------------------

/**
 * What createChatVarAccessors needs from the host. `stateKey` is already prefixed with '$', exactly as
 * RisuAI stores it in `Chat.scriptstate`.
 */
export type RisuChatVarStore = {
  hasCharacter: () => boolean;
  getScriptState: (stateKey: string) => string | number | boolean | null | undefined;
  setScriptState: (stateKey: string, value: string) => void;
  getCharacterDefaultVariables: () => string | undefined;
  getTemplateDefaultVariables: () => string | undefined;
};

export function createChatVarAccessors(store: RisuChatVarStore): {
  getChatVar: (key: string) => string;
  setChatVar: (key: string, value: string) => boolean;
} {
  const getChatVar = (key: string): string => {
    if (!store.hasCharacter()) {
      return 'null';
    }
    const state = store.getScriptState(`$${key}`);
    if (state === undefined || state === null) {
      const defaultVariables = parseKeyValue(store.getCharacterDefaultVariables()).concat(
        parseKeyValue(store.getTemplateDefaultVariables())
      );
      const findResult = defaultVariables.find((f) => {
        return f[0] === key;
      });
      if (findResult) {
        return findResult[1];
      }
      return 'null';
    }
    return state.toString();
  };

  const setChatVar = (key: string, value: string): boolean => {
    const stateKey = `$${key}`;
    if (store.getScriptState(stateKey) === value) {
      return false;
    }
    store.setScriptState(stateKey, value);
    return true;
  };

  return { getChatVar, setChatVar };
}

// ---------------------------------------------------------------------------
// src/ts/process/infunctions.ts:3-160
// ---------------------------------------------------------------------------

type RpnOperator = { precedence: number; associativity: 'Left' | 'Right' };

function toRPN(expression: string) {
  let outputQueue = '';
  const operatorStack: string[] = [];
  const operators: Record<string, RpnOperator> = {
    '+': { precedence: 2, associativity: 'Left' },
    '-': { precedence: 2, associativity: 'Left' },
    '*': { precedence: 3, associativity: 'Left' },
    '/': { precedence: 3, associativity: 'Left' },
    '^': { precedence: 4, associativity: 'Left' },
    '%': { precedence: 3, associativity: 'Left' },
    '<': { precedence: 1, associativity: 'Left' },
    '>': { precedence: 1, associativity: 'Left' },
    '|': { precedence: 1, associativity: 'Left' },
    '&': { precedence: 1, associativity: 'Left' },
    '≤': { precedence: 1, associativity: 'Left' },
    '≥': { precedence: 1, associativity: 'Left' },
    '=': { precedence: 1, associativity: 'Left' },
    '≠': { precedence: 1, associativity: 'Left' },
    '!': { precedence: 5, associativity: 'Right' },
  };
  const operatorsKeys = Object.keys(operators);

  expression = expression.replace(/\s+/g, '');
  const expression2: string[] = [];

  let lastToken = '';

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if (
      char === '-' &&
      (i === 0 || operatorsKeys.includes(expression[i - 1]) || expression[i - 1] === '(')
    ) {
      lastToken += char;
    } else if (operatorsKeys.includes(char)) {
      if (lastToken !== '') {
        expression2.push(lastToken);
      } else {
        expression2.push('0');
      }
      lastToken = '';
      expression2.push(char);
    } else {
      lastToken += char;
    }
  }

  if (lastToken !== '') {
    expression2.push(lastToken);
  } else {
    expression2.push('0');
  }

  for (const token of expression2) {
    if (parseFloat(token) || token === '0') {
      outputQueue += `${token} `;
    } else if (operatorsKeys.includes(token)) {
      while (
        operatorStack.length > 0 &&
        ((operators[token].associativity === 'Left' &&
          operators[token].precedence <= operators[operatorStack[operatorStack.length - 1]].precedence) ||
          (operators[token].associativity === 'Right' &&
            operators[token].precedence < operators[operatorStack[operatorStack.length - 1]].precedence))
      ) {
        outputQueue += `${operatorStack.pop()} `;
      }

      operatorStack.push(token);
    }
  }

  while (operatorStack.length > 0) {
    outputQueue += `${operatorStack.pop()} `;
  }

  return outputQueue.trim();
}

function calculateRPN(expression: string) {
  const stack: number[] = [];

  for (const token of expression.split(' ')) {
    if (parseFloat(token) || token === '0') {
      stack.push(parseFloat(token));
    } else {
      const [b, a] = [stack.pop() as number, stack.pop() as number];
      switch (token) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': stack.push(a / b); break;
        case '^': stack.push(a ** b); break;
        case '%': stack.push(a % b); break;
        case '<': stack.push(a < b ? 1 : 0); break;
        case '>': stack.push(a > b ? 1 : 0); break;
        case '|': stack.push(a || b); break;
        case '&': stack.push(a && b); break;
        case '≤': stack.push(a <= b ? 1 : 0); break;
        case '≥': stack.push(a >= b ? 1 : 0); break;
        case '=': stack.push(a === b ? 1 : 0); break;
        case '≠': stack.push(a !== b ? 1 : 0); break;
        case '!': stack.push(b ? 0 : 1); break;
      }
    }
  }

  if (stack.length === 0) {
    return 0;
  }

  return stack.pop() as number;
}

export type CalcStringAccessors = {
  getChatVar: (key: string) => string;
  getGlobalChatVar: (key: string) => string;
};

export function createCalcString(accessors: CalcStringAccessors): (text: string) => number {
  const executeRPNCalculation = (text: string) => {
    text = text
      .replace(/\$([a-zA-Z0-9_]+)/g, (_, p1: string) => {
        const v = accessors.getChatVar(p1);
        const parsed = parseFloat(v);
        if (isNaN(parsed)) {
          return '0';
        }
        return parsed.toString();
      })
      .replace(/\@([a-zA-Z0-9_]+)/g, (_, p1: string) => {
        const v = accessors.getGlobalChatVar(p1);
        const parsed = parseFloat(v);
        if (isNaN(parsed)) {
          return '0';
        }
        return parsed.toString();
      })
      .replace(/&&/g, '&')
      .replace(/\|\|/g, '|')
      .replace(/<=/g, '≤')
      .replace(/>=/g, '≥')
      .replace(/==/g, '=')
      .replace(/!=/g, '≠')
      .replace(/null/gi, '0');
    const expression = toRPN(text);
    const evaluated = calculateRPN(expression);
    return evaluated;
  };

  return (text: string) => {
    const depthText: string[] = [''];

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '(') {
        depthText.push('');
      } else if (text[i] === ')' && depthText.length > 1) {
        const result = executeRPNCalculation(depthText.pop() as string);
        depthText[depthText.length - 1] += result;
      } else {
        depthText[depthText.length - 1] += text[i];
      }
    }

    return executeRPNCalculation(depthText.join(''));
  };
}
