import { createHash } from 'node:crypto';
import {
  AGENT_CONTEXT_REFS_MAX,
  type AgentConsultationContext,
  type AgentAdvice,
  type AdviceOrigin,
} from '../core/agent-collaboration.js';
import type { ToolEvent } from '../core/types.js';

export class AgentContextError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentContextError';
  }
}

/** Resolve references only against this run's completed, host-owned events. */
export function resolveAgentContext(
  refs: unknown,
  draft: unknown,
  available: readonly ToolEvent[],
  readNames: readonly string[]
): AgentConsultationContext | undefined {
  if (
    (refs !== undefined &&
      (!Array.isArray(refs) ||
        refs.length > AGENT_CONTEXT_REFS_MAX ||
        refs.some((ref) => typeof ref !== 'string' || !ref.trim() || ref.length > 500) ||
        new Set(refs).size !== refs.length)) ||
    (draft !== undefined && (typeof draft !== 'string' || !draft.trim()))
  )
    throw new AgentContextError('INVALID_ADVISOR_REQUEST');
  const ids = (refs ?? []) as string[];
  if (!ids.length && draft === undefined) return undefined;
  const events = new Map(available.map((event) => [event.callId, event]));
  const references: AgentConsultationContext['references'] = ids.map((id) => {
    const event = events.get(id);
    if (!event || (event.name !== 'agents.consult' && !readNames.includes(event.name)))
      throw new AgentContextError('ADVISOR_CONTEXT_UNAVAILABLE');
    return {
      ...structuredClone(event),
      kind: event.name === 'agents.consult' ? 'advice' : 'read-result',
    };
  });
  const content = {
    references,
    ...(draft !== undefined
      ? { draft: { status: 'uncommitted' as const, text: draft as string } }
      : {}),
  };
  const serialized = JSON.stringify(content);
  // Preserve complete references and drafts; the provider request enforces the model token budget.
  return { hash: createHash('sha256').update(serialized).digest('hex'), ...content };
}

/** A flat lineage of selected host-produced opinions; forwarding is not new confirmation. */
export function adviceOrigins(context?: AgentConsultationContext): AdviceOrigin[] {
  const origins = (context?.references ?? []).flatMap((event) => {
    if (event.kind !== 'advice' || event.denied) return [];
    const advice = event.result as AgentAdvice;
    return [{ agentId: advice.agentId, consultationId: advice.consultationId }, ...advice.basedOn];
  });
  return [...new Map(origins.map((origin) => [JSON.stringify(origin), origin])).values()];
}
