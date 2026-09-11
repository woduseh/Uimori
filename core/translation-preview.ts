import { defaultProfile } from './product.js';
import type { PromptProgram, PromptValue } from './prompt-program.js';
import { compileTranslationPrompt } from './translation-prompt.js';
import type { AuxiliaryInput } from './auxiliary.js';
import type { RunSnapshot } from './types.js';

/** Local compilation only: synthetic identity, no stored chat or provider connection. */
export async function compileTranslationPreview(
  program: PromptProgram,
  sourceText: string,
  values: Record<string, PromptValue>
) {
  const sourceRevision = 'preview-translation-source';
  const sourceHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceText))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const preset = {
    id: 'preview-translation',
    revision: 1,
    title: '미리보기',
    role: 'translation' as const,
    program,
  };
  const instructionRevision = `prompt:${preset.id}@${preset.revision}`;
  const task =
    'Translate the complete source according to the selected prompt. Return the translated text only.';
  const snapshot: RunSnapshot = {
    chatId: 'preview-translation',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 1 },
    request: task,
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('preview-translation'),
      contents: [],
      models: {},
      promptPresets: { translation: preset },
      promptControls: { [`${preset.id}@${preset.revision}`]: { values, combinations: [] } },
    },
  };
  const input: AuxiliaryInput = {
    role: 'translation',
    contract: '',
    sourceRevision,
    sourceHash,
    sourceText,
    blocks: [],
    catalog: [],
    tools: [],
    results: [],
    outputSchema: {},
    context: {
      revision: sourceRevision,
      bot: null,
      persona: null,
      references: [],
      scene: '',
      previousSources: [],
      instructionRevision,
      modelPresetRevision: 'synthetic',
    },
  };
  return compileTranslationPrompt(input, snapshot, task)!;
}
