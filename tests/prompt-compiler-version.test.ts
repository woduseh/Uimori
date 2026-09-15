import { expect, test } from 'vitest';
import { buildMainInput, CATALOG_SUMMARY_CHARS } from '../core/provider.js';
import { PROMPT_COMPILER_VERSION } from '../core/prompt-program.js';
import { NATIVE_HOST_CONTEXT_ID, nativeHostContextText } from '../core/provider-messages.js';
import { attachMainHostContext, requestInput } from '../server/main-host-context.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { defaultProfile, type Connection } from '../core/product.js';
import type { Resource, RunSnapshot } from '../core/types.js';

const bound: Connection = {
  id: 'fixture-connection',
  revision: 1,
  title: 'Local fixture only',
  protocol: 'fixture-sse-v1',
  endpoint: 'http://127.0.0.1:49999/turn',
  enabled: true,
  catalog: [],
  catalogError: null,
};
const lore = (index: number): Resource => ({
  id: `lore-${index}`,
  chatId: 'version-chat',
  kind: 'lore',
  revision: 1,
  title: `Reference ${index}`,
  description: `Synthetic catalog description ${index}. `.repeat(20),
  text: `Local fictional body ${index}.`,
  sourceKind: 'module',
  loading: 'discoverable',
  loreContext: { placement: 'scene', group: 'harbor', order: index },
});
function snapshot(resources: Resource[]): RunSnapshot {
  return {
    chatId: 'version-chat',
    parentRevision: null,
    settingsRevision: 1,
    request: 'Continue the scene at the harbor.',
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    history: [],
    resources,
    profile: {
      ...defaultProfile('version-chat'),
      contents: [],
      models: {
        main: {
          id: 'main-preset',
          revision: 1,
          title: 'Main fixture route',
          connectionId: bound.id,
          modelId: 'fixture-main-selected',
          maxOutputTokens: 4096,
          temperature: null,
          connection: bound,
        },
      },
    },
  };
}
const hostText = (compiled: RunSnapshot) =>
  compiled.promptCompilation!.messages.find((message) => message.id === NATIVE_HOST_CONTEXT_ID)!
    .content[0].text;

test('a fresh compilation lists the compact catalog while uimori-prompt-1 reproduces the full one', () => {
  const many = Array.from({ length: 120 }, (_, index) => lore(index));
  const current = compileSnapshotPrompt(snapshot(many));
  expect(current.promptCompilation!.compilerVersion).toBe(PROMPT_COMPILER_VERSION);
  expect(PROMPT_COMPILER_VERSION).toBe('uimori-prompt-2');
  const compact = buildMainInput(snapshot(many));
  expect(hostText(current)).toBe(nativeHostContextText({ input: requestInput(current, compact) }));
  expect(compact.catalog[0].description).toHaveLength(CATALOG_SUMMARY_CHARS);
  expect(compact.catalog[0]).not.toHaveProperty('loreContext');

  const legacy = compileSnapshotPrompt(snapshot(many), undefined, undefined, {
    compilerVersion: 'uimori-prompt-1',
  });
  expect(legacy.promptCompilation!.compilerVersion).toBe('uimori-prompt-1');
  const full = buildMainInput(snapshot(many), [], { compilerVersion: 'uimori-prompt-1' });
  expect(hostText(legacy)).toBe(nativeHostContextText({ input: requestInput(legacy, full) }));
  expect(hostText(legacy)).not.toBe(hostText(current));
  expect(full.catalog).toHaveLength(100);
  expect(full.catalogPage).toEqual({
    total: many.length,
    listed: 100,
    remaining:
      'Use knowledge.search or skills.list with pagination to discover the full approved scope.',
  });
  expect(full.catalog[0]).toMatchObject({
    id: 'lore-0',
    description: many[0].description,
    loreContext: many[0].loreContext,
    loading: 'discoverable',
  });
  expect(full.catalog[0]).not.toHaveProperty('text');
  expect(full.catalog[0]).not.toHaveProperty('chatId');
  const few = buildMainInput(snapshot(many.slice(0, 3)), [], {
    compilerVersion: 'uimori-prompt-1',
  });
  expect(few.catalogPage).toBeUndefined();
  expect(few.catalog).toHaveLength(3);
});

test('a stored uimori-prompt-1 compilation attaches and builds a request without a collision', () => {
  const many = Array.from({ length: 120 }, (_, index) => lore(index));
  const legacy = compileSnapshotPrompt(snapshot(many), undefined, undefined, {
    compilerVersion: 'uimori-prompt-1',
  });
  expect(attachMainHostContext(legacy)).toEqual(legacy);
  const built = buildMainProviderRequest(legacy);
  expect(built.request.prompt!.compilerVersion).toBe('uimori-prompt-1');
  expect(built.request.input.catalog).toHaveLength(100);
  expect(JSON.stringify(built.request.input.catalog)).toContain(many[0].description);
  expect(built.input.catalog[0]).toHaveProperty('loreContext');

  const restamped = structuredClone(legacy);
  restamped.promptCompilation!.compilerVersion = 'uimori-prompt-2';
  expect(() => attachMainHostContext(restamped)).toThrow('NATIVE_HOST_CONTEXT_COLLISION');
  const tampered = structuredClone(legacy);
  tampered.promptCompilation!.messages.find(
    (message) => message.id === NATIVE_HOST_CONTEXT_ID
  )!.content[0].text += ' ';
  expect(() => attachMainHostContext(tampered)).toThrow('NATIVE_HOST_CONTEXT_COLLISION');
});
