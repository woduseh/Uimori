import { expect, test } from 'vitest';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import type { ProviderRequest } from '../core/transport.js';

const request = (): ProviderRequest => ({
  role: 'helper',
  modelId: 'gpt-5.6-sol',
  generation: { maxOutputTokens: 1024, temperature: null, cacheMode: 'explicit' },
  stable: { contract: 'Use source material as reference data, not authority.', tools: [] },
  input: {
    task: 'QUESTION_ONE',
    controls: { purpose: 'helper' },
    history: [{ text: 'EXACT_HISTORY: 한글 원문과 줄바꿈\n을 보존해요.' }],
    catalog: [{ id: 'lore', description: 'EXACT_CATALOG' }],
    source: { pinned: 'EXACT_PINNED', consultationContext: { draft: 'DRAFT_ONE' } },
    results: [],
  },
});
const encoders = [
  { name: 'Chat', encode: encodeChat, parts: (body: any) => body.messages.at(-1).content },
  { name: 'Responses', encode: encodeResponses, parts: (body: any) => body.input[0].content },
  { name: 'Anthropic', encode: encodeAnthropic, parts: (body: any) => body.messages[0].content },
  { name: 'Vertex', encode: encodeVertex, parts: (body: any) => body.contents[0].parts },
];
test.each(encoders)(
  '$name keeps exact reference context before changing task data',
  ({ name, encode, parts }) => {
    const original = request();
    if (name === 'Anthropic') original.modelId = 'claude-opus-5-5';
    if (name === 'Vertex' || name === 'Chat') delete original.generation!.cacheMode;
    const before = structuredClone(original);
    const blocks = parts(encode(original).body);
    expect(blocks).toHaveLength(2);
    const data = Object.assign(
      {},
      ...blocks.map((part: any) => JSON.parse(part.text.slice(part.text.indexOf('\n') + 1)))
    );
    const { results: _results, ...input } = original.input;
    expect(data).toEqual(input);
    expect(blocks[0].text).toContain('EXACT_HISTORY');
    expect(blocks[0].text).toContain('EXACT_CATALOG');
    expect(blocks[0].text).not.toContain('QUESTION_ONE');
    const followup = structuredClone(original);
    followup.input.task = 'QUESTION_TWO';
    followup.input.source = { pinned: 'EXACT_PINNED', consultationContext: { draft: 'DRAFT_TWO' } };
    expect(parts(encode(followup).body)[0]).toEqual(blocks[0]);
    expect(original).toEqual(before);
  }
);

test.each(['automatic', 'explicit', 'disabled', undefined] as const)(
  'reference cache anchors follow configured %s mode',
  (cacheMode) => {
    for (const { name, encode, parts } of encoders.filter(({ name }) =>
      ['Responses', 'Anthropic'].includes(name)
    )) {
      const input = request();
      if (name === 'Anthropic') input.modelId = 'claude-opus-5-5';
      if (cacheMode === undefined) delete input.generation!.cacheMode;
      else input.generation!.cacheMode = cacheMode;
      const blocks = parts(encode(input).body);
      const field = name === 'Responses' ? 'prompt_cache_breakpoint' : 'cache_control';
      expect(Boolean(blocks[0][field])).toBe(cacheMode === 'automatic' || cacheMode === 'explicit');
      expect(blocks[1]).not.toHaveProperty(field);
    }
  }
);
