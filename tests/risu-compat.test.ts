import { describe, expect, it } from 'vitest';
import { defaultProfile } from '../core/product.js';
import type { ContentPackage, PackageAttachment } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import { compiledPackages } from '../core/package-context.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import {
  RISU_COMPAT_LIMITS,
  projectRisuCompatReceipt,
  risuCompatFields,
  risuCompatKey,
  validateRisuCompatReceipt,
  type RisuCompatReceipt,
} from '../core/risu-compat.js';
import {
  evaluateRisuCompat,
  prepareRisuCompatReceipt,
  stripRisuComments,
} from '../server/compat/risu/cbs.js';
import { createRisuCbs, type RisuCbsDeps } from '../third_party/risuai/cad8595a/cbs-parser.js';

// The compat evaluator reads nothing but the reserved snapshot. Every expectation below is a value
// that snapshot fixes: the names it selected, the variables it froze, its history and its clock.

const CLOCK = '2026-09-14T09:00:00.000Z';
const ATTACHMENT: PackageAttachment = { id: 'card', revision: 1, role: 'bot' };

function pkg(body: string, fields = ['body']): ContentPackage {
  return {
    version: 1,
    id: 'card',
    revision: 1,
    title: 'Aria',
    description: '',
    body,
    variableDefaults: { values: { mood: 'calm' } },
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    compat: { risuCbs: { fields } },
  };
}

function snapshot(value = pkg('')): RunSnapshot {
  return {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'Where next?',
    history: [{ revision: 'r1', text: 'North of the dunes.' }],
    resources: [],
    executionClock: { iso: CLOCK, unix: Date.parse(CLOCK) },
    profile: {
      ...defaultProfile('chat'),
      contents: [
        {
          id: 'persona',
          revision: 1,
          kind: 'persona',
          title: 'Mira',
          description: '',
          text: 'A traveler',
          loading: 'pinned',
          relatedIds: [],
        },
      ],
      models: {},
      variableState: { revision: 1, values: { hp: '10' } },
      packages: [value],
      packageAttachments: [ATTACHMENT],
    },
  };
}

const evaluate = (text: string, runId = 'run-1', fieldId = 'body') => {
  const value = pkg(text);
  return evaluateRisuCompat(
    { snapshot: snapshot(value), attachment: ATTACHMENT, package: value, runId },
    { fieldId, text }
  );
};

describe('risu compat evaluation', () => {
  it('reads a frozen shared variable, a package default and an unset name', () => {
    const entry = evaluate('{{getvar::hp}}/{{getvar::mood}}/{{getvar::nothing}}');
    expect(entry.text).toBe('10/calm/null');
    expect(entry.key).toBe('card@1:bot:body');
    expect(entry.partial).toBeUndefined();
  });

  it('makes a write visible to a later read in the same text and marks the entry partial', () => {
    const entry = evaluate('{{setvar::hp::7}}{{getvar::hp}}');
    expect(entry.text).toBe('7');
    expect(entry.partial).toBe('variable-write');
    // The write is recorded, never persisted here: the next evaluation still sees the frozen value.
    expect(evaluate('{{getvar::hp}}').text).toBe('10');
  });

  it('substitutes the names the snapshot selected', () => {
    expect(evaluate('{{char}} meets {{user}}').text).toBe('Aria meets Mira');
  });

  it('reads the reserved history and request as the chat', () => {
    expect(evaluate('{{lastmessage}}').text).toBe('Where next?');
    expect(evaluate('{{previous_chat_log::0}}').text).toBe('North of the dunes.');
  });

  it('empties a display function and lists it', () => {
    const entry = evaluate('<{{asset::sunset}}>');
    expect(entry.text).toBe('<>');
    expect(entry.unsupported).toEqual(['asset']);
    expect(entry.partial).toBe('unsupported-names');
  });

  it('drops {{//...}} comments before evaluation instead of reporting them', () => {
    expect(stripRisuComments('a{{//note}}b')).toBe('ab');
    const entry = evaluate('{{//note}}{{char}}');
    expect(entry.text).toBe('Aria');
    expect(entry.unsupported).toEqual([]);
  });

  it('draws the same entropy for one run and key, and different entropy for another run', () => {
    const first = evaluate('{{random::a::b::c::d::e}}{{roll::20}}');
    expect(evaluate('{{random::a::b::c::d::e}}{{roll::20}}').text).toBe(first.text);
    const other = evaluate('{{random::a::b::c::d::e}}{{roll::20}}', 'run-2');
    expect(other.text).not.toBe(first.text);
    expect(other.inputHash).not.toBe(first.inputHash);
  });

  it('reads the frozen clock, and refuses to evaluate without one', () => {
    // Upstream does not zero-pad the month in {{isodate}}; the snapshot keeps that.
    expect(evaluate('{{isodate}}').text).toBe('2026-9-14');
    const value = pkg('{{isodate}}');
    const without = { ...snapshot(value), executionClock: undefined };
    const entry = evaluateRisuCompat(
      { snapshot: without, attachment: ATTACHMENT, package: value, runId: 'run-1' },
      { fieldId: 'body', text: '{{isodate}}' }
    );
    expect(entry).toMatchObject({ partial: 'error', error: 'RISU_COMPAT_NO_CLOCK' });
    expect(entry.text).toBe('{{isodate}}');
  });

  it('aborts an evaluation that outgrows the output limit and keeps the original text', () => {
    const array = JSON.stringify(Array.from({ length: 500 }, (_, index) => index));
    const source = `{{#each ${array} as v}}${'y'.repeat(500)}{{/each}}`;
    const entry = evaluate(source);
    expect(entry.partial).toBe('error');
    expect(entry.error).toBe('RISU_CBS_OUTPUT_LIMIT');
    expect(entry.text).toBe(source);
  });

  it('refuses a source past the size limit without evaluating it', () => {
    const source = 'x'.repeat(RISU_COMPAT_LIMITS.sourceChars + 1);
    expect(evaluate(source)).toMatchObject({ partial: 'error', error: 'RISU_COMPAT_SOURCE_LIMIT' });
  });
});

describe('parser safety hooks', () => {
  const deps = (): RisuCbsDeps => ({
    getDatabase: () => ({
      characters: [],
      mainPrompt: '',
      jailbreak: '',
      globalNote: '',
      jailbreakToggle: false,
      maxContext: 0,
      aiModel: 'uimori',
      subModel: 'uimori',
      language: 'en',
      globalChatVariables: {},
      templateDefaultVariables: '',
    }),
    getUserName: () => 'Mira',
    getPersonaPrompt: () => '',
    getChatVar: () => 'null',
    setChatVar: () => {},
    getGlobalChatVar: () => 'null',
    getModules: () => [],
    getModuleLorebooks: () => [],
    getSelectedCharID: () => 0,
    getModelInfo: () => ({
      id: 'x',
      name: 'x',
      provider: 0,
      format: 0,
      tokenizer: 0,
    }),
    callInternalFunction: () => '',
    getTriggerId: () => '',
    now: () => 0,
    random: () => 0,
    findCharacterbyId: () => null,
    getModuleAssets: () => [],
    unsupportedNames: new Set<string>(),
    isTauri: false,
    isNodeServer: true,
    isMobile: false,
    appVer: 'uimori',
  });

  it('reports a budget abort as a result error with the input text returned unchanged', () => {
    const cbs = createRisuCbs({
      ...deps(),
      checkBudget: () => {
        throw new Error('RISU_COMPAT_BUDGET');
      },
    });
    expect(cbs.parse('{{user}} walks', {})).toEqual({
      text: '{{user}} walks',
      unsupported: [],
      error: 'RISU_COMPAT_BUDGET',
    });
  });

  it('leaves an evaluation under both limits exactly as it was', () => {
    const cbs = createRisuCbs({ ...deps(), maxOutputChars: 1000, checkBudget: () => {} });
    expect(cbs.parse('{{user}} walks', {}).text).toBe('Mira walks');
  });
});

describe('receipt contract', () => {
  const receipt = (): RisuCompatReceipt => ({
    version: 1,
    entries: [{ key: 'card@1:bot:body', inputHash: 'a'.repeat(64), text: 'done', unsupported: [] }],
  });

  it('accepts a well formed receipt and rejects a bad hash or an extra field', () => {
    expect(validateRisuCompatReceipt(receipt())).toEqual(receipt());
    const bad = receipt();
    bad.entries[0].inputHash = 'not-a-hash';
    expect(() => validateRisuCompatReceipt(bad)).toThrow('RISU_COMPAT_INPUT_HASH');
    expect(() => validateRisuCompatReceipt({ ...receipt(), evaluatedAt: CLOCK })).toThrow(
      'RISU_COMPAT_INVALID_FIELDS'
    );
  });

  it('resolves declared field ids to their stored text', () => {
    const value = pkg('BODY', ['body', 'lore:city', 'instruction:style']);
    value.lore = [{ id: 'city', title: 'City', description: '', text: 'LORE', loading: 'pinned' }];
    value.instructions = [{ id: 'style', target: 'main', text: 'STYLE' }];
    expect(risuCompatFields(value)).toEqual([
      { fieldId: 'body', text: 'BODY' },
      { fieldId: 'lore:city', text: 'LORE' },
      { fieldId: 'instruction:style', text: 'STYLE' },
    ]);
  });

  it('projects only the entries belonging to one attachment', () => {
    const projected = projectRisuCompatReceipt(
      {
        version: 1,
        entries: [
          {
            key: risuCompatKey(ATTACHMENT, 'body'),
            inputHash: 'b'.repeat(64),
            text: 'MINE',
            unsupported: [],
          },
          {
            key: risuCompatKey({ id: 'other', revision: 1, role: 'module' }, 'body'),
            inputHash: 'c'.repeat(64),
            text: 'THEIRS',
            unsupported: [],
          },
        ],
      },
      ATTACHMENT
    );
    expect(projected).toEqual({ body: 'MINE' });
  });
});

describe('compiled packages', () => {
  it('uses the frozen text for a declared field and the original text without a receipt', () => {
    const value = pkg('{{getvar::hp}} left', ['body']);
    const withReceipt = compilePackageAttachment(value, ATTACHMENT, {
      chatId: 'chat',
      target: 'main',
      compat: { body: '10 left' },
    });
    expect(withReceipt.resources[0].text).toBe('10 left');
    const without = compilePackageAttachment(value, ATTACHMENT, { chatId: 'chat', target: 'main' });
    expect(without.resources[0].text).toBe('{{getvar::hp}} left');
    expect(without.unavailableTextTemplates).toBeUndefined();
  });

  it('applies a declared instruction field without compiling its template', () => {
    const value = pkg('', ['instruction:style']);
    value.instructions = [{ id: 'style', target: 'main', text: '{{getvar::mood}} tone' }];
    const compiled = compilePackageAttachment(value, ATTACHMENT, {
      chatId: 'chat',
      target: 'main',
      compat: { 'instruction:style': 'calm tone' },
    });
    expect(compiled.instructions.map((item) => item.text)).toEqual(['calm tone']);
  });

  it('projects a receipt stored on the snapshot onto the attachment it belongs to', () => {
    const value = pkg('{{getvar::hp}} left', ['body']);
    const reserved = snapshot(value);
    const receipt = prepareRisuCompatReceipt(reserved, 'run-1');
    expect(receipt?.entries.map((entry) => entry.text)).toEqual(['10 left']);
    expect(compiledPackages(reserved, 'main')[0].resources[0].text).toBe('{{getvar::hp}} left');
    Object.assign(reserved, { risuCompat: receipt });
    expect(compiledPackages(reserved, 'main')[0].resources[0].text).toBe('10 left');
  });

  it('returns no receipt when nothing declares a compat field', () => {
    const value = pkg('plain', []);
    value.compat = undefined;
    expect(prepareRisuCompatReceipt(snapshot(value), 'run-1')).toBeUndefined();
  });
});
