import { expect, test } from 'vitest';
import {
  helperWebSearchCapability,
  storyGuideWebSearchCapability,
} from '../core/helper-web-search.js';
import { encodeVertex, VertexDecoder } from '../core/vertex-protocol.js';
import { validateRequest } from '../core/provider-request.js';
import type { ModelSnapshot } from '../core/product.js';
import type { ProviderProtocol } from '../core/product.js';
import { helperToolTraits } from '../server/helper-app-tools.js';
import {
  GEMINI_HELPER_SEARCH_TOOL,
  geminiHelperSearchRequest,
} from '../server/helper-web-search-tool.js';

const protocols = ['google-gemini-v1', 'vertex-gemini-v1'] as const;
const models = ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen'];

function request(protocol: ProviderProtocol, modelId: string) {
  const model = {
    modelId,
    connection: { id: 'connection', protocol, endpoint: 'https://example.com' },
    inputTokenLimit: 16_384,
    maxOutputTokens: 8192,
  } as ModelSnapshot;
  return geminiHelperSearchRequest(model, 'Latest public Gemini API grounding documentation');
}

test.each(protocols)(
  '%s preserves Google Search sources on a tool-free helper call',
  (protocol) => {
    const input = request(protocol, 'gemini-4-neon');
    expect(validateRequest(input).webSearch).toBe(true);
    expect(input.stable.tools).toEqual([]);
    expect(input.input).toEqual({
      task: 'Latest public Gemini API grounding documentation',
      controls: { purpose: 'public-web-search' },
    });
    const encoded = encodeVertex(input, protocol);
    expect((encoded.body as Record<string, unknown>).tools).toEqual([{ googleSearch: {} }]);
    const decoder = new VertexDecoder(encoded.context);
    decoder.accept({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Official details are available.' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: ['Gemini official grounding documentation'],
            groundingChunks: [
              {
                web: {
                  uri: 'https://ai.google.dev/gemini-api/docs/google-search',
                  title: 'Gemini API Search',
                },
              },
            ],
          },
        },
      ],
    });
    expect(decoder.finish()).toMatchObject({
      status: 'completed',
      webSearch: {
        performed: true,
        sources: [
          {
            url: 'https://ai.google.dev/gemini-api/docs/google-search',
            title: 'Gemini API Search',
          },
        ],
        queries: ['Gemini official grounding documentation'],
      },
    });
  }
);

test.each(protocols)(
  '%s allows Gemini 4 families but does not enable native mixed tools',
  (protocol) => {
    for (const modelId of models) {
      expect(helperWebSearchCapability(protocol, modelId)).toEqual({
        supported: true,
        mode: 'separate',
      });
      const input = request(protocol, modelId);
      expect(encodeVertex(input, protocol).body).toMatchObject({ tools: [{ googleSearch: {} }] });
      input.stable.tools = [
        { name: 'app.call', description: 'Call', inputSchema: { type: 'object' } },
      ];
      expect(() => encodeVertex(input, protocol)).toThrow(
        'GEMINI_SEARCH_TOOL_COMBINATION_UNSUPPORTED'
      );
    }
    expect(helperWebSearchCapability(protocol, 'gemini-3.8-flash').supported).toBe(false);
    expect(helperWebSearchCapability(protocol, 'gemini-4evil').supported).toBe(false);
    expect(storyGuideWebSearchCapability(protocol).supported).toBe(true);
    const old = request(protocol, 'gemini-3.8-flash');
    expect(() => encodeVertex(old, protocol)).toThrow('INVALID_WEB_SEARCH');
  }
);

test('Gemini 4 web search leaves query content and length to the helper', () => {
  expect(helperToolTraits('web.search')).toMatchObject({
    readOnly: true,
    direct: true,
    reviewAllowed: true,
    effect: 'read',
  });
  expect(GEMINI_HELPER_SEARCH_TOOL.description).toBe('Search the web when needed.');
  expect(GEMINI_HELPER_SEARCH_TOOL.inputSchema).toEqual({
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query.' } },
    required: ['query'],
    additionalProperties: false,
  });
  const query = '비공개 캐릭터 배경 설정과 원고에서 필요한 역사적 풍속 자료 '.repeat(100);
  expect(
    geminiHelperSearchRequest({ modelId: 'gemini-4-neon' } as ModelSnapshot, query).input.task
  ).toBe(query);
});
