import { expect, test } from 'vitest';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import {
  AnthropicDecoder,
  encodeAnthropic,
  decodeAnthropicMessage,
} from '../core/anthropic-protocol.js';
import {
  boundedWebSearch,
  helperWebSearchCapability,
  storyGuideWebSearchCapability,
  webCitationLinks,
} from '../core/helper-web-search.js';
import { buildCodexDescriptor, prepareCodexNative } from '../core/codex-protocol.js';
import { createPublicTextProgress } from '../core/provider-progress.js';
import { executeProvider, type Json, type ProviderRequest } from '../core/transport.js';
import { validateRequest } from '../core/provider-request.js';

const request = (): ProviderRequest => ({
  role: 'helper',
  modelId: 'selected-model',
  webSearch: true,
  stable: {
    contract: 'Research with cited sources.',
    tools: [{ name: 'app.read', description: 'Read app data', inputSchema: { type: 'object' } }],
  },
  input: { task: 'Find current information.', controls: {}, results: [] },
});
const record = (value: Json) => value as Record<string, any>;
const citation = {
  type: 'url_citation',
  url: 'https://example.com/source',
  title: 'Official source',
  start_index: 0,
  end_index: 6,
};

test('saved search provenance deduplicates repeated continuation sources and rejects oversized attribution', () => {
  const sources = Array.from({ length: 32 }, (_, index) => ({
    url: `https://example.com/source/${index}`,
    title: `Source ${index}`,
  }));
  expect(boundedWebSearch({ performed: true, sources: [...sources, ...sources] }).sources).toEqual(
    sources
  );
  expect(() =>
    boundedWebSearch({ performed: true, sources, searchEntryPoint: 'x'.repeat(65_537) })
  ).toThrow('STORY_GUIDE_WEB_SEARCH_METADATA_TOO_LARGE');
});

test('hosted search is explicit, limited to helper and story guide, and unsupported adapters fail before execution', async () => {
  for (const encode of [encodeResponses, encodeAnthropic]) {
    const input = request();
    delete input.webSearch;
    expect(record(encode(input).body).tools).toHaveLength(1);
    expect(record(encode(request()).body).tools).toHaveLength(2);
    expect(() => encode({ ...request(), role: 'main' })).toThrow('INVALID_WEB_SEARCH');
    const guide = {
      ...request(),
      role: 'main' as const,
      input: { ...request().input, controls: { purpose: 'story-guide' } },
    };
    expect(record(encode(guide).body).tools).toHaveLength(2);
    expect(validateRequest(guide).webSearch).toBe(true);
  }
  expect(() => validateRequest({ ...request(), role: 'translation' })).toThrow(
    'INVALID_WEB_SEARCH'
  );
  expect(helperWebSearchCapability('google-gemini-v1').supported).toBe(false);
  expect(storyGuideWebSearchCapability('google-gemini-v1').supported).toBe(true);
  expect(storyGuideWebSearchCapability('vertex-gemini-v1').supported).toBe(true);
  await expect(
    executeProvider(
      { id: 'x', protocol: 'openai-chat-v1', endpoint: 'https://api.openai.com/v1' },
      request(),
      {
        signal: new AbortController().signal,
      }
    )
  ).rejects.toThrow('WEB_SEARCH_UNSUPPORTED');
});

test('Responses hosted search streams append-only prose and visible links, retaining exact continuation items', async () => {
  const input = request();
  const encoded = encodeResponses(input);
  expect(record(encoded.body).tools.at(-1)).toEqual({
    type: 'web_search',
    external_web_access: true,
  });
  const decoder = new ResponsesDecoder(encoded.context);
  const chunks: string[] = [];
  const progress = createPublicTextProgress(input, 'openai-responses-v1', {
    signal: new AbortController().signal,
    onProgress: (delta) => {
      chunks.push(delta.text);
    },
  });
  const search = {
    type: 'web_search_call',
    id: 'ws-1',
    status: 'completed',
    action: { type: 'search', query: 'current information' },
  };
  const message = {
    type: 'message',
    id: 'msg-1',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Answer', annotations: [citation] }],
  };
  await progress(
    decoder.accept({ type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws-1' })
  );
  await progress(
    decoder.accept({
      type: 'response.output_item.added',
      output_index: 1,
      item: { ...message, content: [{ type: 'output_text', text: '', annotations: [] }] },
    })
  );
  await progress(
    decoder.accept({
      type: 'response.output_text.delta',
      output_index: 1,
      item_id: 'msg-1',
      content_index: 0,
      delta: 'Answer',
    })
  );
  const hostCall = {
    type: 'function_call',
    id: 'fc-1',
    call_id: 'host-1',
    name: 'tool_0_app_read',
    arguments: '{}',
    status: 'completed',
  };
  await progress(
    decoder.accept({
      type: 'response.completed',
      response: { id: 'response-1', status: 'completed', output: [search, message, hostCall] },
    })
  );
  const result = decoder.finish();
  expect(result.webSearch).toEqual({
    performed: true,
    sources: [{ url: citation.url, title: citation.title }],
    queries: ['current information'],
  });
  progress.finish(result.text);
  expect(chunks.join('')).toBe('Answer\n\n[Official source](<https://example.com/source>)');
  expect(result.toolCalls).toEqual([{ id: 'host-1', name: 'app.read', arguments: {} }]);
  const next = encodeResponses({
    ...input,
    opaqueState: result.opaqueState,
    input: { ...input.input, results: [{ callId: 'host-1', name: 'app.read', result: {} }] },
  });
  expect(record(next.body).input).toEqual(expect.arrayContaining([search, message]));
  expect(() =>
    encodeResponses({ ...input, webSearch: undefined, opaqueState: result.opaqueState })
  ).toThrow('OPENAI_CONTINUATION_MISMATCH');
});

test('Anthropic hosted blocks and citation deltas stay distinct from host tool calls and preserve encrypted data', async () => {
  const input = request();
  const encoded = encodeAnthropic(input);
  expect(record(encoded.body).tools.at(-1)).toEqual({
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  });
  const decoder = new AnthropicDecoder(encoded.context);
  const chunks: string[] = [];
  const progress = createPublicTextProgress(input, 'anthropic-messages-v1', {
    signal: new AbortController().signal,
    onProgress: (delta) => {
      chunks.push(delta.text);
    },
  });
  const accept = async (event: Json) => progress(decoder.accept(event));
  await accept({
    type: 'message_start',
    message: { type: 'message', role: 'assistant', id: 'msg-1', content: [], stop_reason: null },
  });
  await accept({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} },
  });
  await accept({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"query":"current information"}' },
  });
  await accept({ type: 'content_block_stop', index: 0 });
  const searchResult = {
    type: 'web_search_tool_result',
    tool_use_id: 'search-1',
    content: [
      {
        type: 'web_search_result',
        url: citation.url,
        title: citation.title,
        encrypted_content: 'opaque-search-bytes',
      },
    ],
  };
  await accept({ type: 'content_block_start', index: 1, content_block: searchResult });
  await accept({ type: 'content_block_stop', index: 1 });
  await accept({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'text', text: '' },
  });
  await accept({
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'text_delta', text: 'Answer' },
  });
  await accept({
    type: 'content_block_delta',
    index: 2,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url: citation.url,
        title: citation.title,
        encrypted_index: 'opaque-citation-index',
        cited_text: 'Source excerpt',
      },
    },
  });
  await accept({ type: 'content_block_stop', index: 2 });
  await accept({
    type: 'content_block_start',
    index: 3,
    content_block: { type: 'tool_use', id: 'host-1', name: 'tool_0_app_read', input: {} },
  });
  await accept({ type: 'content_block_stop', index: 3 });
  await accept({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  await accept({ type: 'message_stop' });
  const result = decoder.finish();
  progress.finish(result.text);
  expect(chunks.join('')).toBe('Answer\n\n[Official source](<https://example.com/source>)');
  expect(result.webSearch).toMatchObject({
    performed: true,
    sources: [{ url: citation.url, title: citation.title }],
  });
  expect(result.toolCalls).toEqual([{ id: 'host-1', name: 'app.read', arguments: {} }]);
  const next = encodeAnthropic({
    ...input,
    opaqueState: result.opaqueState,
    input: { ...input.input, results: [{ callId: 'host-1', name: 'app.read', result: {} }] },
  });
  expect(record(next.body).messages.at(-2).content[1]).toEqual(searchResult);
  expect(record(next.body).messages.at(-2).content[2].citations[0].encrypted_index).toBe(
    'opaque-citation-index'
  );
});

test('Anthropic search HTTP-success errors remain explicit failures', () => {
  const decoder = new AnthropicDecoder(encodeAnthropic(request()).context);
  const events: Json[] = [
    {
      type: 'message_start',
      message: { type: 'message', role: 'assistant', id: 'msg-1', content: [], stop_reason: null },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  for (const event of events) decoder.accept(event);
  expect(decoder.finish()).toMatchObject({
    status: 'error',
    error: { code: 'ANTHROPIC_WEB_SEARCH_ERROR' },
  });
});

test('Anthropic parallel hosted search may resolve after the client tool continuation', () => {
  const input = request();
  const first = decodeAnthropicMessage(
    {
      type: 'message',
      role: 'assistant',
      id: 'msg-1',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'server_tool_use',
          id: 'search-deferred',
          name: 'web_search',
          input: { query: 'current' },
        },
        { type: 'tool_use', id: 'host-1', name: 'tool_0_app_read', input: {} },
      ],
    },
    encodeAnthropic(input).context
  );
  const next = encodeAnthropic({
    ...input,
    opaqueState: first.opaqueState,
    input: {
      ...input.input,
      results: [{ callId: 'host-1', name: 'app.read', result: {} }],
    },
  });
  const completed = decodeAnthropicMessage(
    {
      type: 'message',
      role: 'assistant',
      id: 'msg-2',
      stop_reason: 'end_turn',
      content: [
        { type: 'web_search_tool_result', tool_use_id: 'search-deferred', content: [] },
        { type: 'text', text: 'The search returned no sources.' },
      ],
    },
    next.context
  );
  expect(completed).toMatchObject({
    status: 'completed',
    text: 'The search returned no sources.',
    toolCalls: [],
  });
});

test('Codex helper search is live while writing defaults stay cached; unsafe citations cannot become links', () => {
  expect(record(buildCodexDescriptor(request())).builtinTools.webSearch).toBe('live');
  expect(
    record(buildCodexDescriptor({ ...request(), role: 'main', webSearch: undefined })).builtinTools
      .webSearch
  ).toBe('cached');
  expect(
    record(
      prepareCodexNative({ modelId: 'model', text: 'task', developerInstructions: '', tools: [] })
        .descriptor
    ).builtinTools.webSearch
  ).toBe('live');
  expect(
    webCitationLinks([
      { url: 'javascript:alert(1)', title: 'bad' },
      { url: 'https://example.com', title: '[safe](bad)' },
    ])
  ).not.toContain('javascript:');
});

test('only valid helper web search pauses resume exact opaque assistant content without invented tool results', () => {
  const input = request();
  const content: Json[] = [
    {
      type: 'server_tool_use',
      id: 'search-paused',
      name: 'web_search',
      input: { query: 'current information' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'search-paused',
      content: [
        {
          type: 'web_search_result',
          title: 'Official',
          url: citation.url,
          encrypted_content: 'preserve-exactly',
        },
      ],
    },
  ];
  const paused = decodeAnthropicMessage(
    { type: 'message', role: 'assistant', id: 'msg-pause', stop_reason: 'pause_turn', content },
    encodeAnthropic(input).context
  );
  expect(paused).toMatchObject({
    status: 'partial',
    continuation: 'web-search-pause',
    error: null,
    toolCalls: [],
  });
  const next = encodeAnthropic({ ...input, opaqueState: paused.opaqueState });
  expect(record(next.body).messages.at(-1)).toEqual({ role: 'assistant', content });
  expect(record(next.body).tools).toEqual(record(encodeAnthropic(input).body).tools);
  expect(() =>
    encodeAnthropic({
      ...input,
      opaqueState: paused.opaqueState,
      input: { ...input.input, results: [{ callId: 'invented', name: 'app.read', result: {} }] },
    })
  ).toThrow('TOOL_RESULT_MISMATCH');
  expect(() =>
    encodeAnthropic({ ...input, webSearch: undefined, opaqueState: paused.opaqueState })
  ).toThrow('ANTHROPIC_CONTINUATION_MISMATCH');
  const stopped = decodeAnthropicMessage(
    {
      type: 'message',
      role: 'assistant',
      id: 'msg-truncated',
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'Incomplete' }],
    },
    encodeAnthropic(input).context
  );
  expect(stopped.continuation).toBeUndefined();
  expect(() => encodeAnthropic({ ...input, opaqueState: stopped.opaqueState })).toThrow(
    'TOOL_RESULT_MISMATCH'
  );
});
