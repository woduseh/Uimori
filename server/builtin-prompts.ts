import { promptControls } from '../core/risu-prompt.js';
import phemeOptions from './builtin-prompts/pheme-options.json' with { type: 'json' };
import novelOptions from './builtin-prompts/pheme-novel-options.json' with { type: 'json' };
import hermeneiaOptions from './builtin-prompts/hermeneia-options.json' with { type: 'json' };
import type { CurrentPrompt, PromptRole } from '../core/product.js';
import { resolvePromptValues, validateEditableRisuPrompt } from '../core/risu-prompt.js';
import { validateAgentCollaboration } from '../core/agent-collaboration.js';
import pheme from './builtin-prompts/pheme.json' with { type: 'json' };
import novel from './builtin-prompts/pheme-novel.json' with { type: 'json' };
import hermeneia from './builtin-prompts/hermeneia.json' with { type: 'json' };
import collaboration from './builtin-prompts/collaboration.json' with { type: 'json' };
import simulation from './builtin-prompts/simulation.json' with { type: 'json' };

const templates = [
  {
    id: 'pheme',
    title: 'Phēmē RP',
    role: 'main',
    description: 'v5.4.1. 인물과 대화하며 이야기를 이어 가요.',
  },
  {
    id: 'pheme-novel',
    title: 'Phēmē 소설',
    role: 'main',
    description: 'v5.4.1. 요청한 장면이나 회차를 소설 원고로 써요.',
  },
  {
    id: 'hermeneia',
    title: 'Hermēneía',
    role: 'translation',
    description: 'v1.1.0. 원문의 의미와 문체를 살려 한국어로 번역해요.',
  },
] as const;

/** Opening the catalog returns metadata without loading full programs into the browser. */
export function builtinPromptTemplates() {
  return structuredClone(templates);
}

/** Each selection is an independent editable copy. The bundled definitions stay unchanged. */
export function builtinPromptTemplate(id: string) {
  const metadata = templates.find((template) => template.id === id);
  if (!metadata) return undefined;
  const program = validateEditableRisuPrompt(
    structuredClone(id === 'hermeneia' ? hermeneia : id === 'pheme-novel' ? novel : pheme)
  );
  const advisors = id === 'pheme' ? collaboration : id === 'pheme-novel' ? simulation : undefined;
  if (advisors) {
    program.collaboration = validateAgentCollaboration(
      structuredClone(advisors),
      promptControls(program).map((control) => control.id)
    );
    validateEditableRisuPrompt(program);
  }
  return {
    ...metadata,
    program,
    values: resolvePromptValues(
      program,
      id === 'hermeneia' ? hermeneiaOptions : id === 'pheme-novel' ? novelOptions : phemeOptions
    ),
  };
}

/** Used only when creating a fresh workspace, never to rewrite saved working copies. */
export function builtinCurrentPrompt(role: PromptRole): CurrentPrompt {
  const { title, program, values } = builtinPromptTemplate(
    role === 'main' ? 'pheme' : 'hermeneia'
  )!;
  return { title, program, values };
}
