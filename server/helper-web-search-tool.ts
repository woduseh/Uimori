import type { ModelSnapshot } from '../core/product.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import type { ProviderRequest, ProviderTool } from '../core/transport.js';

export const GEMINI_HELPER_SEARCH_TOOL: ProviderTool = {
  name: 'web.search',
  description: 'Search the web when needed.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query.' } },
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
      contract: 'Use Google Search to answer the question. Include the sources you found.',
      tools: [],
    },
    generation: { maxOutputTokens: 8192, temperature: null },
    input: { task: query, controls: { purpose: 'public-web-search' } },
  };
}
