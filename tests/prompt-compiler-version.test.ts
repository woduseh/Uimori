import { expect, test } from 'vitest';
import { buildMainInput } from '../core/provider.js';
import { PROMPT_COMPILER_VERSION } from '../core/risu-prompt.js';
import { NATIVE_HOST_CONTEXT_ID, nativeHostContextText } from '../core/provider-messages.js';
import { attachMainHostContext, requestInput } from '../server/main-host-context.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { defaultProfile, type Connection } from '../core/product.js';
import type { Resource, RunSnapshot } from '../core/types.js';
import { nativePrompt } from './fixtures/native-prompt.js';

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
const lore: Resource = {
  id: 'lore',
  chatId: 'version-chat',
  kind: 'lore',
  revision: 1,
  title: 'Reference',
  description: 'Synthetic catalog description.',
  text: 'Local fictional body.',
  sourceKind: 'module',
  loading: 'discoverable',
};
function snapshot(resources: Resource[]): RunSnapshot {
  return {
    chatId: 'version-chat',
    parentRevision: null,
    settingsRevision: 1,
    request: 'Continue the scene at the harbor.',
    settings: { maxCalls: 4 },
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
  (
    compiled.promptCompilation!.messages.find((message) => message.id === NATIVE_HOST_CONTEXT_ID)!
      .content[0] as { type: 'text'; text: string }
  ).text;

test('the current native compiler keeps host context and version across request building', () => {
  const input = snapshot([lore]);
  const current = compileSnapshotPrompt(input);
  expect(current.promptCompilation!.compilerVersion).toBe(PROMPT_COMPILER_VERSION);
  const compact = buildMainInput(input);
  expect(hostText(current)).toBe(nativeHostContextText({ input: requestInput(current, compact) }));
  expect(attachMainHostContext(current)).toEqual(current);
  expect(buildMainInput(current)).toEqual(compact);
  expect(buildMainProviderRequest(current).request.prompt!.compilerVersion).toBe(
    PROMPT_COMPILER_VERSION
  );
  const tampered = structuredClone(current);
  (
    tampered.promptCompilation!.messages.find((message) => message.id === NATIVE_HOST_CONTEXT_ID)!
      .content[0] as { type: 'text'; text: string }
  ).text += ' ';
  expect(() => attachMainHostContext(tampered)).toThrow('NATIVE_HOST_CONTEXT_COLLISION');
});

test('prompt compilation preserves the aggregate variable-default warning without changing its inputs', () => {
  const input = snapshot([]);
  const value = 'x'.repeat(180_000);
  input.profile!.variableState = {
    revision: 1,
    values: { savedA: value, savedB: value, savedC: value },
  };
  input.profile!.promptPresets = {
    main: {
      id: 'variable-defaults',
      revision: 1,
      title: 'Synthetic variable defaults',
      role: 'main',
      program: nativePrompt('Active instructions.', {
        templateDefaultVariables: ['defaultA', 'defaultB', 'defaultC']
          .map((key) => `${key}=${value}`)
          .join('\n'),
      }),
    },
  };
  const before = structuredClone(input);

  const compiled = compileSnapshotPrompt(input);

  expect(compiled.promptCompilation!.warnings).toContain('TEMPLATE_VARIABLE_DEFAULTS_LIMIT');
  expect(compiled.promptCompilation!.messages).toContainEqual(
    expect.objectContaining({
      content: [{ type: 'text', text: 'Active instructions.' }],
    })
  );
  expect(input).toEqual(before);
});

test.each(['risu-prompt-1', 'future-prompt', undefined])(
  'stored compiler version %s is rejected even when host context already exists',
  (compilerVersion) => {
    const compiled = compileSnapshotPrompt(snapshot([lore]));
    const input = buildMainInput(compiled);
    Object.assign(compiled.promptCompilation!, { compilerVersion });
    expect(() => buildMainInput(compiled)).toThrow('PROMPT_INVALID_COMPILED');
    expect(() => buildMainInput(compiled, [], [])).toThrow('PROMPT_INVALID_COMPILED');
    expect(() => attachMainHostContext(compiled)).toThrow('PROMPT_INVALID_COMPILED');
    expect(() => attachMainHostContext(compiled, input)).toThrow('PROMPT_INVALID_COMPILED');
    expect(() => buildMainProviderRequest(compiled)).toThrow('PROMPT_INVALID_COMPILED');
  }
);
