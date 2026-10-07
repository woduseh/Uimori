import { expect, test } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import type { RunSnapshot } from '../core/types.js';
import type { Json, WireRecord } from '../core/transport.js';
import { requestReceipt } from '../server/request-receipt.js';
import { nativeContent } from './fixtures/native-content.js';

const summary = '이전 장면의 "약속"\n아직 밝혀지지 않은 사실이에요.';
const wire = (body: Json): WireRecord => ({
  connectionId: 'connection',
  protocol: 'openai-chat-v1',
  role: 'main',
  modelId: 'writer',
  method: 'POST',
  url: 'http://127.0.0.1:9',
  headers: {},
  body,
  bodySha256: 'a'.repeat(64),
  stablePrefixSha256: 'b'.repeat(64),
});
function snapshot(): RunSnapshot {
  const persona = {
    ...nativeContent({ name: '호출 당시 이름', description: 'PRIVATE_PERSONA' }),
    id: 'persona',
    revision: 7,
  };
  return {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { maxCalls: 3 },
    request: 'PRIVATE_REQUEST',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('chat'),
      models: {},
      packageAttachments: [{ id: 'persona', revision: 7, role: 'persona' }],
      packages: [persona],
      promptPresets: {
        main: {
          id: 'prompt',
          revision: 3,
          title: '호출 당시 프롬프트',
          role: 'main',
          program: createDefaultRisuPrompt('PRIVATE_PROMPT'),
        },
      },
    },
    contextPlan: {
      version: 1,
      status: 'ready',
      budget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
      dependencyKey: 'frozen',
      estimatedInputTokens: 100,
      compacted: [
        { revision: 'first', hash: 'first-hash' },
        { revision: 'second', hash: 'second-hash' },
      ],
      recentSourceRevisions: [],
      summary,
      summaryCalls: 1,
      usage: { modelCalls: 1, inputTokens: 100, outputTokens: 20, costUsd: null },
      error: null,
    },
  };
}

test.each<{ body: Json; status: string }>([
  { body: { messages: [{ text: summary }] }, status: 'included' },
  { body: { input: JSON.stringify({ text: summary }) }, status: 'included' },
  { body: { messages: [{ text: 'A request hook removed the summary.' }] }, status: 'unverified' },
])('summary receipt reflects final wire evidence: $status', ({ body, status }) => {
  const captured = snapshot(),
    before = structuredClone(captured);
  const receipt = requestReceipt(captured, wire(body));
  expect(receipt.summary).toEqual({ status, coveredSources: 2 });
  expect(receipt.prompt).toEqual({ id: 'prompt', revision: 3, title: '호출 당시 프롬프트' });
  expect(receipt.persona).toMatchObject({ id: 'persona', revision: 7, name: '호출 당시 이름' });
  expect(JSON.stringify(receipt)).not.toContain('PRIVATE_');
  expect(JSON.stringify(receipt)).not.toContain('아직 밝혀지지');
  expect(captured).toEqual(before);
});

test('missing frozen identity is not reconstructed and a plan without summary records absence', () => {
  const captured = snapshot();
  captured.profile!.packages = [];
  captured.profile!.promptPresets = {};
  captured.contextPlan!.summary = null;
  const receipt = requestReceipt(captured, wire({ text: 'No summary' }));
  expect(receipt.prompt).toBeNull();
  expect(receipt.persona).toEqual({ id: 'persona', revision: 7, title: null, name: null });
  expect(receipt.summary).toEqual({ status: 'absent', coveredSources: 0 });
  delete captured.contextPlan;
  expect(requestReceipt(captured, wire({ text: 'Older unsupported context' })).summary).toBeNull();
});
