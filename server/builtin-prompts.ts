import type { CurrentPrompt, PromptRole } from '../core/product.js';
import { resolvePromptValues, validateEditablePromptProgram } from '../core/prompt-program.js';
import { validateAgentCollaboration } from '../core/agent-collaboration.js';
import pheme from './builtin-prompts/pheme.json' with { type: 'json' };
import hermeneia from './builtin-prompts/hermeneia.json' with { type: 'json' };
import collaboration from './builtin-prompts/collaboration.json' with { type: 'json' };
import simulation from './builtin-prompts/simulation.json' with { type: 'json' };
import ooc from './builtin-prompts/ooc.json' with { type: 'json' };

const templates = [
  {
    id: 'pheme',
    title: 'Phēmē',
    role: 'main',
    description: '롤플레이·소설 집필·OOC 작업을 지원하는 작문 프롬프트예요.',
  },
  {
    id: 'hermeneia',
    title: 'Hermēneía',
    role: 'translation',
    description: '원문의 의미·인물의 말투·문체를 살리는 한국어 문학 번역 프롬프트예요.',
  },
  {
    id: 'pheme-collaboration',
    title: 'Phēmē · 협업',
    role: 'main',
    description: '인물·관계, 설정·연속성, 서사 전개를 검토하는 협업자 3명을 필요할 때 호출해요.',
  },
  {
    id: 'pheme-simulation',
    title: 'Phēmē · 시뮬레이션 협업',
    role: 'main',
    description: '기본 협업자 3명에 장면 밖 인물과 사건을 검토하는 협업자를 더해요.',
  },
  {
    id: 'pheme-ooc',
    title: 'Phēmē · OOC 검토',
    role: 'main',
    description: '설정과 근거의 일관성을 검토하는 협업자 1명과 OOC 작업으로 시작해요.',
  },
] as const;

/** Metadata only: opening the catalog does not load five full programs into the browser. */
export function builtinPromptTemplates() {
  return structuredClone(templates);
}

/** Each selection is an independent editable copy. The bundled definitions stay unchanged. */
export function builtinPromptTemplate(id: string) {
  const metadata = templates.find((template) => template.id === id);
  if (!metadata) return undefined;
  const program = validateEditablePromptProgram(
    structuredClone(id === 'hermeneia' ? hermeneia : pheme)
  );
  const advisors =
    id === 'pheme-collaboration'
      ? collaboration
      : id === 'pheme-simulation'
        ? simulation
        : id === 'pheme-ooc'
          ? ooc
          : undefined;
  if (advisors) {
    program.collaboration = validateAgentCollaboration(
      advisors,
      program.controls.map((control) => control.id)
    );
    if (id === 'pheme-ooc') {
      program.controls.find((control) => control.id === 'pheme_session_mode')!.default = 2;
      program.provenance!.notes.push('The OOC template starts with pheme_session_mode=2.');
    }
    validateEditablePromptProgram(program);
  }
  return { ...metadata, program, values: resolvePromptValues(program) };
}

/** Used only when creating a fresh workspace, never to rewrite saved working copies. */
export function builtinCurrentPrompt(role: PromptRole): CurrentPrompt {
  const { title, program, values } = builtinPromptTemplate(
    role === 'main' ? 'pheme' : 'hermeneia'
  )!;
  return { title, program, values };
}
