import type { ModelSnapshot } from '../core/product.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import type { ProviderRequest, ProviderTool } from '../core/transport.js';

export const GEMINI_HELPER_SEARCH_QUERY_LIMIT = 500;

export const GEMINI_HELPER_SEARCH_TOOL: ProviderTool = {
  name: 'web.search',
  description:
    'Search the public web with Google Search Grounding using this Gemini model. Use for current facts, recent announcements, official documentation and verifiable sources. Send a concise public-information query only: never include private manuscripts, chats, character cards, credentials or other workspace content. Each search uses an additional billed model request and possibly billable Google Search queries. The result says whether a search actually occurred and includes verified source URLs. Do not cite model knowledge as a searched source.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: GEMINI_HELPER_SEARCH_QUERY_LIMIT,
        description: 'Standalone public search question; do not include private workspace data.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export function geminiHelperSearchRequest(model: ModelSnapshot, query: string): ProviderRequest {
  return {
    role: 'helper',
    ...modelRequestFields(model),
    webSearch: true,
    contextBudget: contextBudgetForModel(model),
    stable: {
      contract:
        'Answer the public research question using Google Search Grounding. Search when needed and cite only returned sources. Do not invent citations. Do not request app tools or private workspace content. Respond briefly with the information and sources found.',
      tools: [],
    },
    generation: { maxOutputTokens: 8192, temperature: null },
    input: { task: query, controls: { purpose: 'public-web-search' } },
  };
}
