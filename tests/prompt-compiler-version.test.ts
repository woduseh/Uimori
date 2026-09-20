import { expect, test } from 'vitest';
import { buildMainInput, CATALOG_SUMMARY_CHARS } from '../core/provider.js';
import { PROMPT_COMPILER_VERSION } from '../core/risu-prompt.js';
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

test('the current native compiler uses a compact reference catalog', () => {
  const many = Array.from({ length: 120 }, (_, index) => lore(index));
  const current = compileSnapshotPrompt(snapshot(many));
  expect(current.promptCompilation!.compilerVersion).toBe(PROMPT_COMPILER_VERSION);
  expect(PROMPT_COMPILER_VERSION).toBe('risu-native-prompt-2');
  const compact = buildMainInput(snapshot(many));
  expect(hostText(current)).toBe(nativeHostContextText({ input: requestInput(current, compact) }));
  expect(compact.catalog[0].description).toHaveLength(CATALOG_SUMMARY_CHARS);
  expect(compact.catalog[0]).not.toHaveProperty('loreContext');
  expect(attachMainHostContext(current)).toEqual(current);
  expect(buildMainProviderRequest(current).request.prompt!.compilerVersion).toBe(
    PROMPT_COMPILER_VERSION
  );
  const tampered = structuredClone(current);
  tampered.promptCompilation!.messages.find(
    (message) => message.id === NATIVE_HOST_CONTEXT_ID
  )!.content[0].text += ' ';
  expect(() => attachMainHostContext(tampered)).toThrow('NATIVE_HOST_CONTEXT_COLLISION');
});
