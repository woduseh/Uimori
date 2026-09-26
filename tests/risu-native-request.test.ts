import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { defaultProfile } from '../core/product.js';
import type { RisuContent } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import type { ProviderRequest } from '../core/transport.js';
import { importRisuPresetProgram } from '../server/risu-preset-program.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { prepareNativeRisuRequest } from '../server/risu-native-request.js';
import { disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';

afterEach(disposeAllNativeRisuSessions);
async function prepared(code?: string, providerPrefill = false) {
  const program = importRisuPresetProgram({
    name: 'Prefill',
    promptTemplate: [
      { type: 'plain', role: 'system', text: 'Story' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
    ],
    promptSettings: { assistantPrefill: 'Continue: ' },
  }).program;
  const pkg: RisuContent = {
    version: 2,
    id: 'bot',
    revision: 1,
    title: 'Bot',
    description: '',
    body: 'Bot',
    lore: [],
    nativeRisu: {
      version: 1,
      sourceHash: 'a'.repeat(64),
      assets: [],
      card: {
        name: 'Bot',
        extensions: {
          risuai: {
            lowLevelAccess: true,
            triggerscript: code
              ? [{ type: 'start', lowLevelAccess: true, effect: [{ type: 'triggerlua', code }] }]
              : [],
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
  // Exercise the generic provider prefill contract independently of RISUP settings.
  if (providerPrefill)
    p.messages.push({
      id: 'provider-prefill',
      role: 'assistant',
      completion: 'prefill',
      content: [{ type: 'text', text: 'Continue: ' }],
      provenance: { blockId: 'provider-prefill', origin: 'prompt' },
    });
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

test('native request without callbacks never adds the retired RISUP assistant prefill', async () => {
  const input = await prepared();
  expect(input.request.prompt!.messages.at(-1)).toMatchObject({
    role: 'user',
    completion: 'complete',
    content: [{ type: 'text', text: 'A scene' }],
  });
  const result = await prepareNativeRisuRequest(input.snapshot, input.request);
  expect(result.request.prompt).toEqual(input.request.prompt);
  expect(
    result.snapshot.nativeRisuExecution!.requestEdits![0]!.prompt.messages.at(-1)!.completion
  ).toBe('complete');
});

test('native request body edits preserve completion when the final role and position stay fixed', async () => {
  const input = await prepared(
    `listenEdit('editRequest', function(id, messages)
    messages[#messages].content = 'Edited prefix: '
    return messages
  end)`,
    true
  );
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
      `listenEdit('editRequest', function(id, messages) ${change}; return messages end)`,
      true
    );
    const result = await prepareNativeRisuRequest(input.snapshot, input.request);
    expect(
      result.request.prompt!.messages.every((message) => message.completion === 'complete')
    ).toBe(true);
  }
);

test('request receipts replay by round without repeating Lua callbacks or folding a later identical request', async () => {
  const input = await prepared(`listenEdit('editRequest', function(id, messages)
    local count = (tonumber(getChatVar(id, 'requestCount')) or 0) + 1
    setChatVar(id, 'requestCount', tostring(count))
    LLM(id, 'Synthetic request edit callback')
    messages[#messages].content = messages[#messages].content .. ' edit ' .. tostring(count)
    return messages
  end)`);
  const calls: string[] = [];
  const host = async (method: string) => {
    calls.push(method);
    return { success: true, result: 'Synthetic callback response' };
  };
  const first = await prepareNativeRisuRequest(input.snapshot, input.request, {
    host,
    requestOrdinal: 0,
  });
  const second = await prepareNativeRisuRequest(first.snapshot, input.request, {
    host,
    requestOrdinal: 1,
  });
  expect(calls).toEqual(['LLM', 'LLM']);
  expect(first.request.prompt!.messages.at(-1)!.content[0]!.text).toBe('A scene edit 1');
  expect(second.request.prompt!.messages.at(-1)!.content[0]!.text).toBe('A scene edit 2');
  const persisted = JSON.parse(JSON.stringify(second.snapshot)) as RunSnapshot;
  disposeAllNativeRisuSessions();
  const replayFirst = await prepareNativeRisuRequest(persisted, input.request, {
    host,
    requestOrdinal: 0,
  });
  const replaySecond = await prepareNativeRisuRequest(replayFirst.snapshot, input.request, {
    host,
    requestOrdinal: 1,
  });
  expect(calls).toEqual(['LLM', 'LLM']);
  expect(replayFirst.request).toEqual(first.request);
  expect(replaySecond.request).toEqual(second.request);
  expect(replaySecond.snapshot).toEqual(persisted);
  expect(persisted.nativeRisuExecution!.variables.requestCount).toBe('2');
  expect(persisted.nativeRisuExecution!.requestEdits).toHaveLength(2);
});

test('a replayed request rejects changed input before executing authored callbacks', async () => {
  const input = await prepared(`listenEdit('editRequest', function(id, messages)
    LLM(id, 'Synthetic request edit callback')
    return messages
  end)`);
  const calls: string[] = [];
  const host = async (method: string) => {
    calls.push(method);
    return { success: true, result: 'Synthetic callback response' };
  };
  const first = await prepareNativeRisuRequest(input.snapshot, input.request, {
    host,
    requestOrdinal: 0,
  });
  const changed = structuredClone(input.request);
  changed.prompt!.messages.at(-1)!.content[0]!.text = 'Different scene';
  await expect(
    prepareNativeRisuRequest(first.snapshot, changed, { host, requestOrdinal: 0 })
  ).rejects.toThrow('RISU_NATIVE_REQUEST_REPLAY_MISMATCH');
  expect(calls).toEqual(['LLM']);
});
