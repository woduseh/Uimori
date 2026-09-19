import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defaultProfile } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';
import type { ProviderRequest } from '../core/transport.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { prepareNativeRisuRequest } from '../server/risu-native-request.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';

afterEach(disposeAllNativeRisuSessions);
async function prepared(code?: string) {
  const program = importRisuPresetProgram({
    name: 'Prefill',
    promptTemplate: [
      { type: 'plain', role: 'system', text: 'Story' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ],
    promptSettings: { assistantPrefill: 'Continue: ' },
  }).program;
  const pkg: ContentPackage = {
    version: 1,
    id: 'bot',
    revision: 1,
    title: 'Bot',
    description: '',
    body: 'Bot',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    nativeRisu: {
      version: 1,
      sourceHash: 'a'.repeat(64),
      assets: [],
      card: {
        name: 'Bot',
        extensions: {
          risuai: {
            triggerscript: code ? [{ type: 'start', effect: [{ type: 'triggerlua', code }] }] : [],
          },
        },
      },
    },
  };
  const snapshot = {
    chatId: randomUUID(),
    parentRevision: null,
    settingsRevision: 1,
    settings: {},
    request: 'A scene',
    history: [],
    logicalHistory: [],
    resources: [],
    profile: {
      ...defaultProfile('test'),
      contents: [],
      models: {},
      packages: [pkg],
      packageAttachments: [{ id: pkg.id, revision: 1, role: 'bot' }],
      promptPresets: {
        main: { id: 'preset', revision: 1, title: 'Prefill', role: 'main', program, values: {} },
      },
    },
  } as unknown as RunSnapshot;
  const compiled = compileSnapshotPrompt(await prepareNativeRisuRun(snapshot));
  const p = compiled.promptCompilation!;
  const request: ProviderRequest = {
    role: 'main',
    modelId: 'synthetic',
    stable: { contract: '', tools: [] },
    input: { task: '', controls: {} },
    prompt: {
      compilerVersion: p.compilerVersion,
      messages: p.messages,
      cachePlan: p.cachePlan,
      values: p.values,
    },
  };
  return { snapshot: compiled, request };
}

test('native request without callbacks retains the RISUP assistant prefill', async () => {
  const input = await prepared();
  expect(input.request.prompt!.messages.at(-1)!.completion).toBe('prefill');
  const result = await prepareNativeRisuRequest(input.snapshot, input.request);
  expect(result.request.prompt).toEqual(input.request.prompt);
  expect(
    result.snapshot.nativeRisuExecution!.requestEdits![0]!.prompt.messages.at(-1)!.completion
  ).toBe('prefill');
});

test('native request body edits preserve completion when the final role and position stay fixed', async () => {
  const input = await prepared(`listenEdit('editRequest', function(id, messages)
    messages[#messages].content = 'Edited prefix: '
    return messages
  end)`);
  const result = await prepareNativeRisuRequest(input.snapshot, input.request);
  expect(result.request.prompt!.messages.at(-1)).toMatchObject({
    role: 'assistant',
    completion: 'prefill',
    content: [{ type: 'text', text: 'Edited prefix: ' }],
  });
  expect(input.request.prompt!.messages.at(-1)!.content[0]!.text).toBe('Continue: ');
});

test.each([
  "table.insert(messages, {role='user', content='Inserted final request'})",
  "messages[#messages].role = 'user'",
])(
  'native request resets prefill when its terminal role or position changes: %s',
  async (change) => {
    const input = await prepared(
      `listenEdit('editRequest', function(id, messages) ${change}; return messages end)`
    );
    const result = await prepareNativeRisuRequest(input.snapshot, input.request);
    expect(
      result.request.prompt!.messages.every((message) => message.completion === 'complete')
    ).toBe(true);
  }
);
