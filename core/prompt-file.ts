import {
  resolvePromptValues,
  validatePromptProgram,
  type PromptProgram,
  type PromptValue,
} from './prompt-program.js';
import type { PromptRole } from './product.js';

export type PromptFile = {
  title?: string;
  role?: PromptRole;
  program: PromptProgram;
  values: Record<string, PromptValue>;
};

/** Accept native prompt files and standalone program JSON without inventing metadata. */
export function parsePromptFile(input: unknown): PromptFile {
  const wrapper =
    input && typeof input === 'object' && 'program' in input
      ? (input as Record<string, unknown>)
      : null;
  const program = validatePromptProgram(wrapper ? wrapper.program : input);
  if (
    wrapper?.title !== undefined &&
    (typeof wrapper.title !== 'string' || wrapper.title.length > 160)
  )
    throw new Error('프롬프트 이름은 160자 이하 문자열이어야 해요.');
  if (wrapper?.role !== undefined && wrapper.role !== 'main' && wrapper.role !== 'translation')
    throw new Error('프롬프트 역할은 작문(main) 또는 번역(translation)이어야 해요.');
  const suggested = wrapper?.suggestedCombination;
  const values =
    wrapper && Object.hasOwn(wrapper, 'values')
      ? wrapper.values
      : suggested && typeof suggested === 'object' && 'values' in suggested
        ? suggested.values
        : {};
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('프롬프트 기본 옵션은 객체여야 해요.');
  return {
    ...(wrapper?.title !== undefined ? { title: wrapper.title as string } : {}),
    ...(wrapper?.role !== undefined ? { role: wrapper.role as PromptRole } : {}),
    program,
    values: resolvePromptValues(program, values as Record<string, PromptValue>),
  };
}
