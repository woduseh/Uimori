import type { PromptProgram } from './prompt-program.js';
import type { PromptRole } from './product.js';

/** Plain instruction authoring produces the same AST as detailed editing.
 * All default system blocks precede user data and history for provider portability.
 * Authored programs keep their own roles and order unchanged.
 */
export function createDefaultPromptProgram(text: string, role: PromptRole = 'main'): PromptProgram {
  const dataSlots = role === 'main'
    ? ['backgroundLore', 'globalNote', 'authorNote', 'postEverything']
    : ['source', 'context', 'outputSchema', 'catalog'];
  return { version: 1, controls: [], blocks: [
    { id: 'instructions', title: '지침', kind: 'message', role: 'system', template: [{ kind: 'text', text }] },
    ...dataSlots.map(slot => ({ id: slot, title: slot, kind: 'slot' as const, role: 'user' as const, slot,
      template: [{ kind: 'text' as const, text: `${slot}:\n` }, { kind: 'slot' as const, name: slot }] })),
    ...(role === 'main' ? [
      { id: 'history', title: 'History', kind: 'history' as const, from: 0, to: -1 },
      ...['memory','sceneLore'].map(slot => ({ id: slot, title: slot, kind: 'slot' as const, role: 'user' as const, slot })),
      { id: 'current', title: 'Current input', kind: 'current' as const },
    ] : [{ id: 'history', title: 'Request', kind: 'history' as const, from: 0, to: 'end' as const }]),
  ] };
}
