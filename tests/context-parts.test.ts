import { describe, expect, test } from 'vitest';
import { estimateContextTokens, estimateImageTokens } from '../core/context-budget.js';
import { createNativeRisuPresetProgram } from '../core/risu-native-preset.js';
import { compileRisuPrompt } from '../core/risu-prompt.js';
import type { ProviderRequest } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';
import { mainContextParts } from '../server/context-parts.js';

const budget = { inputTokenLimit: 200_000, estimator: 'o200k_base-v1' as const };
const image = {
  hash: 'a'.repeat(64),
  mime: 'image/webp' as const,
  name: 'scene.webp',
  width: 640,
  height: 960,
  input: { hash: 'b'.repeat(64), width: 640, height: 960 },
};
const program = createNativeRisuPresetProgram({
  version: 1,
  preset: {
    promptTemplate: [
      { type: 'plain', role: 'system', text: '너는 장면을 이어 쓰는 작가예요. '.repeat(20) },
      { type: 'chatML', text: '<|im_start|>system\n문체는 담백하게 유지해요.<|im_end|>' },
      { type: 'description' },
      { type: 'persona' },
      { type: 'lorebook' },
      { type: 'authornote' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      { type: 'postEverything' },
    ],
  },
});
const compiled = compileRisuPrompt(program, {
  slots: {
    description: '미라는 등대를 지키는 사람이에요. '.repeat(30),
    persona: '나는 항구에 막 도착한 여행자예요. '.repeat(10),
    lorebook: '항구 마을에는 밤마다 종이 울려요. '.repeat(25),
    authorNote: '긴장감을 천천히 높여 주세요.',
    postEverything: '마지막으로 문장 끝을 점검해요.',
  },
  examples: [
    { role: 'user', text: '예시 질문이에요.' },
    { role: 'assistant', text: '예시 대답이에요. '.repeat(8) },
  ],
  history: [
    {
      id: 'context-summary',
      role: 'user',
      text: '앞선 장면 요약: 미라와 여행자가 처음 만났어요. '.repeat(12),
    },
    {
      id: 'source:1',
      role: 'assistant',
      text: '바람이 부두를 훑고 지나갔어요. '.repeat(60),
      sourceRevision: '1',
    },
    {
      id: 'current-input',
      role: 'user',
      text: '등대 꼭대기로 올라가요.',
      current: true,
      requestImages: [image],
    },
  ],
  references: [
    {
      message: {
        id: 'lore-reference:1',
        role: 'user',
        text: '등대의 열쇠는 미라만 가지고 있어요.',
      },
      beforeMessageId: 'current-input',
    },
  ],
});
const tools = [
  {
    name: 'story.read',
    description: '이전 장면을 읽어요.',
    inputSchema: { type: 'object', properties: { sceneNumber: { type: 'integer' } } },
  },
];
const brief = '원작에서 등대는 마지막 장의 무대예요. '.repeat(15);

function fixture(options: { storyGuide?: boolean } = {}) {
  const snapshot = {
    profile: { promptPresets: { main: { program } } },
    ...(options.storyGuide
      ? { storyGuide: { config: { enabled: true }, brief: { text: brief } } }
      : {}),
  } as unknown as RunSnapshot;
  const request = {
    role: 'main',
    modelId: 'fixture',
    stable: { contract: '앱이 정한 작업 지시예요.', tools },
    contextBudget: budget,
    input: { task: 'write', controls: {} },
    prompt: {
      compilerVersion: compiled.compilerVersion,
      messages: [
        ...compiled.messages.slice(0, -1),
        {
          id: 'native.host-context',
          role: 'user',
          content: [{ type: 'text', text: `Host context:\n${JSON.stringify({ brief })}` }],
          completion: 'complete',
          provenance: { blockId: 'native.host-context', origin: 'prompt' },
        },
        compiled.messages.at(-1)!,
      ],
      cachePlan: [],
      values: compiled.values,
    },
  } as unknown as ProviderRequest;
  return {
    snapshot,
    request,
    total: estimateContextTokens(request, budget) + estimateImageTokens(640, 960),
  };
}

const sum = (parts: Record<string, number | undefined>) =>
  Object.values(parts).reduce<number>((value, tokens) => value + (tokens ?? 0), 0);

describe('main context parts', () => {
  test('a Risu preset request splits into block categories that sum to the measured total', () => {
    const { snapshot, request, total } = fixture({ storyGuide: true });
    const parts = mainContextParts(snapshot, request, total)!;
    expect(Object.keys(parts).sort()).toEqual(
      [
        'authorNote',
        'botDescription',
        'history',
        'lore',
        'other',
        'persona',
        'prompt',
        'request',
        'storyGuide',
        'summary',
        'tools',
      ].sort()
    );
    expect(sum(parts)).toBe(total);
    expect(parts.request!).toBeGreaterThan(estimateImageTokens(640, 960));
    expect(parts.history!).toBeGreaterThan(parts.summary!);
    expect(parts.botDescription!).toBeGreaterThan(
      estimateContextTokens('미라는 등대를 지키는 사람이에요. '.repeat(30), budget)
    );
  });

  test('absent categories are omitted and an overlong split is reduced to the reported total', () => {
    const { snapshot, request } = fixture();
    const parts = mainContextParts(snapshot, request, 1_000)!;
    expect(parts).not.toHaveProperty('storyGuide');
    expect(sum(parts)).toBe(1_000);
    expect(Object.values(parts).every((tokens) => tokens! > 0)).toBe(true);
  });

  test('a continuation request without its full prompt records no parts', () => {
    const { snapshot, request, total } = fixture();
    expect(mainContextParts(snapshot, { ...request, opaqueState: { id: 'x' } }, total)).toBe(
      undefined
    );
    expect(mainContextParts(snapshot, { ...request, prompt: undefined }, total)).toBe(undefined);
  });
});
