import { expect, test } from 'vitest';
import { EXTENSION_PROGRAM_MAX_SOURCE_BYTES } from '../core/extension-program.js';
import {
  RISU_PLUGIN_LOCAL_PREFIX,
  RISU_PLUGIN_LOCALSTORAGE_PREFIX,
  RISU_PLUGIN_STORAGE_PREFIX,
  adaptRisuPlugin,
  buildRisuPluginProgram,
} from '../server/risu-plugin-adapter.js';
import { readRisuPlugin, readRisuPluginFile } from '../server/risu-plugin-import.js';

const header = [
  '//@name synthetic-plugin',
  '//@display-name Synthetic Plugin',
  '//@api 3.0',
  '//@arg prefix string 문장 앞에 붙일 말',
  '//@arg retries int 재시도 횟수',
];
const file = (body: string) => ({
  name: 'synthetic.js',
  base64: Buffer.from([...header, body].join('\n'), 'utf8').toString('base64'),
});
const adapt = (body: string) => {
  const { preview, code, aliases } = readRisuPluginFile(file(body));
  return { preview, source: code, aliases, ...adaptRisuPlugin(preview, code, aliases) };
};

test('a program keeps the prelude, the plugin source and the event dispatcher in that order', () => {
  const body = "risuai.addRisuScriptHandler('input', (text) => text);";
  const preview = readRisuPlugin(file(body));
  const source = [...header, body].join('\n');
  const program = buildRisuPluginProgram(preview, source, 'editInput');
  expect(program.language).toBeUndefined();
  expect(program.capabilities).toEqual([
    'materials.read.self',
    'variables.read',
    'variables.write',
    'model.generate',
    'conversation.read',
    'response.read.current',
  ]);
  const prelude = program.source.indexOf('const __handlers');
  const plugin = program.source.indexOf(body);
  const dispatch = program.source.indexOf('__handlers.input');
  expect(prelude).toBeGreaterThanOrEqual(0);
  expect(plugin).toBeGreaterThan(prelude);
  expect(dispatch).toBeGreaterThan(plugin);
  // The plugin keeps Risu's own wrapper, so its top-level await and declarations stay contained.
  expect(program.source).toContain('await (async () => {');
  expect(program.source).toContain('"synthetic-plugin"');
});

test('a plugin past the shared program source limit is reported instead of connected', () => {
  const body = `// ${'x'.repeat(EXTENSION_PROGRAM_MAX_SOURCE_BYTES)}\nrisuai.addRisuScriptHandler('input', (t) => t);`;
  const adapted = adapt(body);
  expect(adapted.actions).toEqual([]);
  expect(adapted.findings).toContainEqual(
    expect.objectContaining({ code: 'RISU_PLUGIN_SOURCE_LIMIT', level: 'unsupported' })
  );
});

test('each registration becomes the action whose hook and trigger match its Risu phase', () => {
  const adapted = adapt(`
    risuai.addRisuScriptHandler('input', (t) => t);
    risuai.addRisuScriptHandler('output', (t) => t);
    risuai.addRisuScriptHandler('display', (t) => t);
    risuai.addRisuReplacer('beforeRequest', (m) => m);
    risuai.addRisuChatListener('output', () => {});
  `);
  expect(
    adapted.actions.map((action) => [action.id, action.hook ?? null, action.triggers?.[0]])
  ).toEqual([
    ['risu-plugin-editInput', 'edit-input', 'before-turn'],
    ['risu-plugin-editRequest', 'edit-request', 'before-turn'],
    ['risu-plugin-editOutput', 'edit-output', 'after-turn'],
    ['risu-plugin-editDisplay', 'edit-display', 'after-turn'],
    ['risu-plugin-output', null, 'after-turn'],
  ]);
  // Only the chat listener is an ordinary automatic action; the edit hooks take a host-fixed input.
  expect(adapted.actions.map((action) => action.automaticInput !== undefined)).toEqual([
    false,
    false,
    false,
    false,
    true,
  ]);
});

test('literal modes prune the connected phases and a computed mode keeps all of them', () => {
  const pruned = adapt("risuai.addRisuScriptHandler('display', (t) => t);");
  expect(pruned.actions.map((action) => action.id)).toEqual(['risu-plugin-editDisplay']);
  const computed = adapt(`
    const mode = 'input';
    risuai.addRisuScriptHandler(mode, (t) => t);
  `);
  expect(computed.actions.map((action) => action.id)).toEqual([
    'risu-plugin-editInput',
    'risu-plugin-editOutput',
    'risu-plugin-editDisplay',
  ]);
});

test('every declared argument becomes one package option with its Risu type and description', () => {
  const adapted = adapt("risuai.getArgument('prefix');");
  expect(adapted.controls).toEqual([
    { id: 'prefix', label: 'prefix', type: 'text', default: '', description: '문장 앞에 붙일 말' },
    { id: 'retries', label: 'retries', type: 'number', default: 0, description: '재시도 횟수' },
  ]);
});

test('each storage keeps its own key prefix, so the two local stores cannot read each other', () => {
  const prefixes = [
    RISU_PLUGIN_STORAGE_PREFIX,
    RISU_PLUGIN_LOCAL_PREFIX,
    RISU_PLUGIN_LOCALSTORAGE_PREFIX,
  ];
  // A shared or nested prefix would let the string store and the JSON store read the same key.
  for (const one of prefixes)
    for (const other of prefixes) if (one !== other) expect(other.startsWith(one)).toBe(false);
  const preview = readRisuPlugin(file("risuai.safeLocalStorage.getItem('k');"));
  const program = buildRisuPluginProgram(preview, 'risuai.log("ready");', 'editInput');
  expect(program.source).toContain(
    `safeLocalStorage: __store("${RISU_PLUGIN_LOCALSTORAGE_PREFIX}"`
  );
  expect(program.source).toContain(
    `getLocalPluginStorage: async () => __store("${RISU_PLUGIN_LOCAL_PREFIX}"`
  );
});

test('an unresolved alias connects every phase instead of leaving the module without actions', () => {
  const adapted = adapt('const api = risuai;\napi.addRisuScriptHandler("input", (t) => t);');
  expect(adapted.aliases).toEqual(['api']);
  // Nothing is judged used through the alias, so without this rule the module would carry no action.
  expect(adapted.preview.apis).toEqual([]);
  expect(adapted.actions.map((action) => action.id)).toEqual([
    'risu-plugin-editInput',
    'risu-plugin-editRequest',
    'risu-plugin-editOutput',
    'risu-plugin-editDisplay',
    'risu-plugin-output',
  ]);
  expect(adapted.findings).toContainEqual(
    expect.objectContaining({ code: 'RISU_PLUGIN_ALIAS_ALL_PHASES', level: 'info' })
  );
});

test('the semantic differences of the three axes are reported as findings', () => {
  const adapted = adapt(`
    risuai.addRisuScriptHandler('process', (t) => t);
    risuai.addRisuScriptHandler('output', (t) => t);
    risuai.pluginStorage.setItem('seen', 1);
    risuai.setArgument('prefix', 'no');
    risuai.nativeFetch('https://example.test');
  `);
  const level = Object.fromEntries(
    adapted.findings.map((finding) => [finding.code, finding.level])
  );
  expect(level).toMatchObject({
    RISU_PLUGIN_FRESH_INVOCATION: 'warning',
    RISU_PLUGIN_STORAGE_SCOPE: 'warning',
    RISU_PLUGIN_OUTPUT_COPY: 'info',
    RISU_PLUGIN_ARGUMENTS_READONLY: 'info',
    'RISU_PLUGIN_HOOK_UNSUPPORTED:process': 'unsupported',
    'RISU_PLUGIN_API_UNSUPPORTED:nativeFetch': 'unsupported',
  });
  // A process handler registers but never dispatches, so it connects no action of its own.
  expect(adapted.actions.map((action) => action.id)).toEqual(['risu-plugin-editOutput']);
  expect(level['RISU_PLUGIN_API_UNSUPPORTED:pluginStorage']).toBeUndefined();
});
