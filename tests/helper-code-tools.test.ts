import { tokenFit } from '../server/helper-read-fit.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Content } from '../core/product.js';
import { countTextTokens } from '../core/text-tokens.js';
import { invokeHelperCodeTool } from '../server/helper-code-tools.js';
import { invokeHelperGuideTool } from '../server/helper-guide-tools.js';
import { checkNativeRisuLuaSyntax } from '../server/risu-lua-syntax.js';
import {
  RISU_NATIVE_LUA_FUNCTIONS,
  RISU_NATIVE_LUA_UNSUPPORTED_FUNCTIONS,
} from '../server/risu-native-lua.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { CODE_BOT_CARD, saveCodeBot, saveCodePreset } from './fixtures/code-tools.js';
import { nativeContent } from './fixtures/native-content.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-code-tools-'))
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-code-tools-'));
  const store = new Store(join(path, 'test.sqlite'));
  owned.push({ store, path });
  return store;
}
const call = async (
  store: Store,
  name: string,
  args: Record<string, unknown>,
  maxResultTokens?: number
) =>
  (await invokeHelperCodeTool(
    store,
    name,
    args,
    undefined,
    maxResultTokens === undefined ? undefined : tokenFit(maxResultTokens)
  )) as Record<string, any>;

test('code.cbs locates diagnostics, blocks and variables in a text or a saved field', async () => {
  const store = fixture();
  const bot = saveCodeBot(store);
  const field = await call(store, 'code.cbs', {
    kind: 'content',
    id: bot.id,
    path: '/package/nativeRisu/card/description',
  });
  expect(field.source).toEqual({
    kind: 'content',
    id: bot.id,
    revision: bot.revision,
    path: '/package/nativeRisu/card/description',
  });
  expect(field.diagnostics.map((item: any) => [item.code, item.line, item.column])).toEqual([
    ['cbs.unclosed-block', 1, 23],
    ['cbs.unknown-function', 1, 54],
    ['cbs.deprecated-function', 1, 25],
  ]);
  expect(field.blocks).toEqual([{ keyword: '#if', line: 1, column: 23, depth: 0, closed: false }]);
  expect(field.variables).toEqual([
    { scope: 'chat', name: 'mood', reads: 1, writes: 0, line: 1 },
    { scope: 'chat', name: 'open', reads: 1, writes: 0, line: 1 },
  ]);
  const text = await call(store, 'code.cbs', {
    text: '{{setvar::hp::1}}\n{{#when::toggle::dark}}x{{/when}}\n{{/if}}',
  });
  expect(text.diagnostics).toMatchObject([{ code: 'cbs.stray-closer', line: 3, column: 1 }]);
  expect(text.variables).toEqual([
    { scope: 'chat', name: 'hp', reads: 0, writes: 1, line: 1 },
    { scope: 'global', name: 'toggle_dark', reads: 1, writes: 0, line: 2, toggle: 'dark' },
  ]);
  const deprecated = await call(store, 'code.cbs', {
    text: '{{#if 1}}a{{/if}}\n{{#if_pure 1}}b{{/if_pure}}\n{{#pure}}c{{/pure}}\n{{#when 1}}d{{/when}}',
  });
  expect(
    deprecated.diagnostics.map((item: any) => [item.code, item.name, item.line, item.column])
  ).toEqual([
    ['cbs.deprecated-function', '#if', 1, 3],
    ['cbs.deprecated-function', '#if_pure', 2, 3],
    ['cbs.deprecated-function', '#pure', 3, 3],
  ]);
  for (const item of deprecated.diagnostics)
    expect(item.message.match(/ instead\./gu), item.message).toHaveLength(1);
  const many = await call(store, 'code.cbs', { text: '{{nosuch}}\n'.repeat(5000) });
  expect(many.totalDiagnostics).toBe(5000);
  expect(many.diagnostics.length).toBeLessThanOrEqual(100);
  const denseLine = `${'\u0001'.repeat(120)}{{nosuch}}\n`;
  const wide = await call(store, 'code.cbs', { text: denseLine.repeat(100) }, 64_000);
  expect(wide.diagnostics).toHaveLength(100);
  expect(countTextTokens(JSON.stringify(wide))).toBeGreaterThan(12_000);
  const narrow = await call(store, 'code.cbs', { text: denseLine.repeat(100) }, 12_000);
  expect(countTextTokens(JSON.stringify(narrow))).toBeLessThanOrEqual(12_000);
  expect(narrow.diagnostics.length).toBeLessThan(wide.diagnostics.length);
  await expect(call(store, 'code.cbs', { text: 'x', kind: 'content' })).rejects.toThrow(
    'INVALID_ARGUMENTS'
  );
  await expect(
    call(store, 'code.cbs', { kind: 'content', id: bot.id, path: '/package/nativeRisu/card' })
  ).rejects.toThrow('CODE_FIELD_NOT_TEXT');
  await expect(
    call(store, 'code.cbs', { kind: 'content', id: bot.id, path: '/title' })
  ).rejects.toThrow('path must start with /package/nativeRisu/');
});

test('code.references filters the index and points every use at a patchable path', async () => {
  const store = fixture();
  const bot = saveCodeBot(store);
  const all = await call(store, 'code.references', { kind: 'content', id: bot.id });
  expect(all.findings).toEqual(
    expect.arrayContaining([
      { code: 'read-without-default', scope: 'chat', name: 'open', certain: true },
      { code: 'toggle-unused', scope: 'global', name: 'toggle_unused', certain: true },
    ])
  );
  const mood = await call(store, 'code.references', { kind: 'content', id: bot.id, name: 'MOOD' });
  expect(mood.variables).toHaveLength(1);
  expect(mood.variables[0].uses).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: '/package/nativeRisu/card/description',
        line: 1,
        column: 16,
        access: 'read',
      }),
      expect.objectContaining({
        path: '/package/nativeRisu/card/extensions/risuai/customScripts/0/out',
        access: 'read',
      }),
      expect.objectContaining({
        path: '/package/nativeRisu/card/extensions/risuai/defaultVariables',
        line: 1,
        column: 1,
        access: 'default',
      }),
    ])
  );
  const page = await call(store, 'code.references', { kind: 'content', id: bot.id, limit: 1 });
  expect(page).toMatchObject({ nextOffset: 1 });
  expect(page.variables).toHaveLength(1);
  await expect(call(store, 'code.references', { kind: 'theme', id: bot.id })).rejects.toThrow(
    'kind must be content or prompt-preset'
  );
});

test('code.diagnose reports each finding kind of a bot with paths and positions', async () => {
  const store = fixture();
  const bot = saveCodeBot(store);
  const report = await call(store, 'code.diagnose', { kind: 'content', id: bot.id, limit: 100 });
  const found = report.findings.map((item: any) => `${item.section} ${item.code} ${item.path}`);
  const root = '/package/nativeRisu/card';
  const scripts = `${root}/extensions/risuai/customScripts`;
  const triggers = `${root}/extensions/risuai/triggerscript`;
  const lore = `${root}/character_book/entries`;
  expect(found).toEqual(
    expect.arrayContaining([
      `cbs cbs.unclosed-block ${root}/description`,
      `cbs cbs.unknown-function ${root}/description`,
      `assets asset.missing ${root}/first_mes`,
      `regex regex.invalid-entry ${scripts}/4`,
      `regex regex.compile ${scripts}/1/in`,
      `triggers trigger.mixed-lua ${triggers}/2/effect`,
      `lore lore.blank-key ${lore}/0/keys`,
      `lore lore.duplicate-key ${lore}/0/keys`,
      `lore lore.no-keys ${lore}/1`,
      `lua lua.syntax ${triggers}/1/effect/0/code`,
      `compatibility compat.regex-type ${scripts}/2/type`,
      `compatibility compat.regex-command ${scripts}/3/out`,
      `compatibility compat.lore-decorator ${lore}/0/content`,
      `compatibility compat.trigger-condition ${triggers}/2/conditions/0/type`,
      `compatibility compat.trigger-setvar-operator ${triggers}/2/effect/1/operator`,
      `compatibility compat.trigger-effect ${triggers}/3/effect/0/type`,
      `compatibility compat.lua-function ${triggers}/0/effect/0/code`,
      `compatibility compat.lua-low-level-access ${triggers}/0/effect/0/code`,
    ])
  );
  expect(report.findings.find((item: any) => item.code === 'lua.syntax')).toMatchObject({
    line: 2,
    severity: 'error',
  });
  expect(report.findings.filter((item: any) => item.code === 'compat.lua-function')).toMatchObject([
    { name: 'sleep', line: 3, column: 3 },
  ]);
  expect(report.findings.find((item: any) => item.code === 'asset.missing')).toMatchObject({
    name: 'missing-pic',
    line: 3,
    column: 1,
  });
  expect(report.counts.lua).toEqual({ error: 1, warning: 0, info: 0 });
  const errors = await call(store, 'code.diagnose', {
    kind: 'content',
    id: bot.id,
    sections: ['lore'],
    severity: 'warning',
    limit: 1,
  });
  expect(errors).toMatchObject({ sections: ['lore'], total: 1, nextOffset: null });
  expect(errors.counts).toEqual({ lore: { error: 0, warning: 1, info: 2 } });
  await expect(
    call(store, 'code.diagnose', { kind: 'content', id: bot.id, sections: ['spelling'] })
  ).rejects.toThrow('INVALID_ARGUMENTS');
});

test('code.diagnose checks a prompt preset with preset paths', async () => {
  const store = fixture();
  const preset = saveCodePreset(store);
  const report = await call(store, 'code.diagnose', { kind: 'prompt-preset', id: preset.id });
  expect(report.sections).toEqual(['cbs', 'regex', 'compatibility']);
  const root = '/program/nativeRisuPreset/preset';
  expect(report.findings.map((item: any) => `${item.code} ${item.path}`)).toEqual([
    `cbs.unclosed-block ${root}/promptTemplate/0/text`,
    `cbs.deprecated-function ${root}/promptTemplate/0/text`,
    `regex.compile ${root}/regex/0/in`,
    `compat.preset-setting ${root}/promptSettings/utilOverride`,
    `compat.preset-block-skipped ${root}/promptTemplate/1/type`,
  ]);
});

test('the Lua syntax check compiles chunks without running them', async () => {
  const started = Date.now();
  expect(
    await checkNativeRisuLuaSyntax([
      'while true do end',
      "error('top-level side effect ran')",
      'api.host.call("alertInput", {})',
      'local broken = ',
    ])
  ).toEqual([null, null, null, { line: 1, message: 'unexpected symbol near <eof>' }]);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('code.regex traces each changing script of one stage with runtime CBS', async () => {
  const store = fixture();
  const bot = saveCodeBot(store);
  const trace = await call(store, 'code.regex', {
    kind: 'content',
    id: bot.id,
    stage: 'editoutput',
    text: 'hello there, smile',
    variables: { mood: 'sunny' },
  });
  expect(trace.steps).toMatchObject([
    {
      script: {
        index: 0,
        comment: 'Shout',
        path: '/package/nativeRisu/card/extensions/risuai/customScripts/0',
      },
      at: { line: 1, column: 1 },
      before: 'hello there, smile',
      after: 'HELLO sunny there, smile',
    },
  ]);
  const defaults = await call(store, 'code.regex', {
    kind: 'content',
    id: bot.id,
    stage: 'editoutput',
    text: '{{setvar::mood::calm}}{{setvar::mark::new}}',
  });
  expect(defaults.changedVariables).toEqual({ mark: 'new' });
  expect(trace.issues).toEqual([
    { code: 'regex.command-unsupported', script: expect.objectContaining({ index: 3 }) },
  ]);
  expect(trace.result).toEqual({ length: 24, text: 'HELLO sunny there, smile' });
  const display = await call(store, 'code.regex', {
    kind: 'content',
    id: bot.id,
    stage: 'editdisplay',
    text: 'plain',
  });
  expect(display.issues).toEqual([
    { code: 'regex.failed', script: expect.objectContaining({ index: 1, comment: 'Broken' }) },
  ]);
  await expect(
    call(store, 'code.regex', { kind: 'content', id: bot.id, stage: 'edittrans', text: 'a' })
  ).rejects.toThrow('INVALID_ARGUMENTS');
  await expect(
    call(store, 'code.regex', {
      kind: 'content',
      id: bot.id,
      stage: 'editoutput',
      text: 'x'.repeat(20_001),
    })
  ).rejects.toThrow('sample text');
});

test('code.preview renders saved and replacement first messages with toggle values', async () => {
  const store = fixture();
  expect(await call(store, 'code.preview', { id: saveCodeBot(store).id })).toMatchObject({
    greeting: 0,
    failure: expect.stringContaining('RISU_NATIVE'),
  });
  const card = structuredClone(CODE_BOT_CARD);
  card.extensions.risuai.triggerscript = [];
  const bot = store.product.content({
    ...fixtureBotInput('Preview Bot'),
    package: nativeContent(card, { id: 'preview-bot' }),
  }) as Content;
  const named = store.product.content({
    ...fixtureBotInput('Display title'),
    package: nativeContent({ name: 'Card name', first_mes: '{{char}}' }),
  }) as Content;
  const savedName = await call(store, 'code.preview', { id: named.id });
  expect(savedName.html).toContain('Card name');
  expect((await call(store, 'code.preview', { id: named.id, text: '{{char}}' })).html).toBe(
    savedName.html
  );
  const plain = await call(store, 'code.preview', { id: bot.id });
  expect(plain.html).toContain('plain');
  expect(plain.html).not.toContain('fancy');
  const emoji = { id: bot.id, text: '🌙!' };
  const html = (await call(store, 'code.preview', emoji)).html as string;
  const at = html.indexOf('🌙');
  expect(await call(store, 'code.preview', { ...emoji, offset: at, limit: 1 })).toMatchObject({
    html: '🌙',
    nextOffset: at + 2,
  });
  expect(
    (await call(store, 'code.preview', { id: bot.id, text: '{{img::}}' })).issues
  ).toContainEqual({
    code: 'asset.missing',
    name: '',
  });
  const invalidToggles = structuredClone(card);
  invalidToggles.extensions.risuai.toggles = 'same=A\nsame=B';
  const invalid = store.product.content({
    ...fixtureBotInput('Bad toggles'),
    package: nativeContent(invalidToggles),
  }) as Content;
  expect(await call(store, 'code.preview', { id: invalid.id })).toMatchObject({
    failure: expect.stringMatching(/^RISU_NATIVE_PRESET_TOGGLE_KEY: Toggle key "same"/u),
  });
  const fancy = await call(store, 'code.preview', { id: bot.id, toggles: { style: '1' } });
  expect(fancy.html).toContain('fancy');
  expect(fancy.issues).toEqual([
    { code: 'asset.missing', name: 'missing-pic' },
    {
      code: 'regex.failed',
      script: expect.objectContaining({
        path: '/package/nativeRisu/card/extensions/risuai/customScripts/1',
      }),
    },
  ]);
  const replacement = await call(store, 'code.preview', {
    id: bot.id,
    text: 'Try {{getvar::mood}}',
    limit: 10,
  });
  expect(replacement).toMatchObject({ replacement: true, offset: 0 });
  expect(replacement.html).toHaveLength(10);
  expect(replacement.nextOffset).toBe(10);
  expect(
    (await call(store, 'code.preview', { id: bot.id, text: 'Try {{getvar::mood}}' })).html
  ).toContain('Try calm');
  expect((await call(store, 'code.preview', { id: bot.id, greeting: 1 })).html).toContain('Alt');
  await expect(call(store, 'code.preview', { id: bot.id, greeting: 9 })).rejects.toThrow(
    'GREETING_NOT_FOUND'
  );
  await expect(call(store, 'code.preview', { id: bot.id, greeting: 0, text: 'x' })).rejects.toThrow(
    'INVALID_ARGUMENTS'
  );
});

test('the Lua API guide names exactly the functions the Lua host provides', () => {
  const guide = (invokeHelperGuideTool({ name: 'RISU-LUA-API', limit: 20_000 }) as { text: string })
    .text;
  const [supported, unsupported] = guide.split('## 지원하지 않는 함수');
  for (const name of RISU_NATIVE_LUA_FUNCTIONS) expect(supported, name).toContain(`\`${name}`);
  for (const name of RISU_NATIVE_LUA_UNSUPPORTED_FUNCTIONS)
    expect(unsupported, name).toContain(`\`${name}\``);
  const callbacks = ['onInput', 'onStart', 'onOutput', 'onButtonClick', 'onFormSubmit', 'callback'];
  for (const [, name] of supported!.matchAll(/`([A-Za-z_][\w.]*)\(/gu))
    expect(
      [...RISU_NATIVE_LUA_FUNCTIONS, ...callbacks, 'json.encode', 'json.decode', 'math.random'],
      name
    ).toContain(name);
});
