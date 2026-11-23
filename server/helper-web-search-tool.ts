import type { ModelSnapshot } from '../core/product.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import type { ProviderRequest, ProviderTool } from '../core/transport.js';

export const GEMINI_HELPER_SEARCH_QUERY_LIMIT = 2000;

export const GEMINI_HELPER_SEARCH_TOOL: ProviderTool = {
  name: 'web.search',
  description:
    'Search the web with Google Search Grounding using this Gemini model. Useful for current facts, historical details, real-world places and references for creative writing. Form a focused question from the user’s story context when relevant; exact excerpts or unpublished details may be searched when the user explicitly asks. Never include credentials, secrets or unrelated private content. Each search uses another billed model request and may incur Google Search charges. The result indicates whether Google Search ran and provides source URLs. Do not present model knowledge as verified web evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: GEMINI_HELPER_SEARCH_QUERY_LIMIT,
        description:
          'Focused web-search question. Use relevant story context; include private excerpts only at the user’s request. Never include credentials or secrets.',
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
        'Research the question with Google Search Grounding for the creative-writing assistant. Cite only returned sources and distinguish unverified model knowledge. Do not invent citations or request app tools. Respond concisely with findings and sources.',
      tools: [],
    },
    generation: { maxOutputTokens: 8192, temperature: null },
    input: { task: query, controls: { purpose: 'public-web-search' } },
  };
}
