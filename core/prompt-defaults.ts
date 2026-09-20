import type { RisuPrompt } from './risu-prompt.js';
import type { PromptRole } from './product.js';
/** New prompts are native Risu sources. Host data, tools and model routing stay outside authored source. */
export function createDefaultRisuPrompt(text: string, role: PromptRole = 'main'): RisuPrompt {
  return {
    version: 1,
    nativeRisuPreset: {
      version: 1,
      preset: {
        name: role === 'main' ? '작문 프롬프트' : '번역 프롬프트',
        promptTemplate: [
          { type: 'plain', role: 'system', text },
          ...(role === 'main'
            ? [
                { type: 'persona' },
                { type: 'description' },
                { type: 'lorebook' },
                { type: 'plain', role: 'system', type2: 'globalNote', text: '' },
                { type: 'authornote' },
                { type: 'postEverything' },
              ]
            : []),
          { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
        ],
      },
    },
  };
}
