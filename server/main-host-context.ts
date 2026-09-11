/**
 * Host-owned dynamic data for the main request: the JSON input boundary and the synthetic user
 * message that carries it. Shared by request building and snapshot compilation.
 */
import { buildMainInput, pinnedSlotSources, type MainInput } from '../core/provider.js';
import type { RunSnapshot } from '../core/types.js';
import { validateProviderPrompt } from '../core/prompt-program.js';
import { nativeHostContextText, NATIVE_HOST_CONTEXT_ID } from '../core/provider-messages.js';
import { ProviderContractError, type ProviderRequest, type Json } from '../core/transport.js';
import { contextWindowReference } from '../core/context-tools.js';
import { agentSharedOptions } from './agent-shared-options.js';

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
export function requestInput(snapshot: RunSnapshot, input: MainInput): ProviderRequest['input'] {
  // Writing options belong to the selected PromptProgram. Mock settings never cross this boundary.
  const controls: ProviderRequest['input']['controls'] = {};
  const structured = !!snapshot.promptCompilation;
  const used = new Set(snapshot.promptCompilation?.usedSlots ?? []);
  const stateSlot = used.has('state');
  const collaboration = snapshot.profile?.promptPresets?.main?.program.collaboration;
  return {
    task: input.task,
    controls,
    source: json({
      parentRevision: snapshot.parentRevision,
      ...(!structured && input.contextSummary ? { contextSummary: input.contextSummary } : {}),
      facts: structured || input.pinnedSources?.length ? [] : input.facts,
      pinnedSources: structured ? [] : (input.pinnedSources ?? []),
      prefetch: input.prefetch,
      ...(collaboration?.enabled
        ? {
            collaboration: {
              sharedOptions: agentSharedOptions(snapshot),
              sharedControls: Object.fromEntries(
                collaboration.sharedControls.map((id) => [
                  id,
                  snapshot.promptCompilation?.values[id] ?? null,
                ])
              ),
              advisors: collaboration.agents.map(({ id, title, description, trigger }) => ({
                id,
                title,
                description,
                trigger,
              })),
            },
          }
        : {}),
      ...(input.state && !stateSlot ? { state: input.state } : {}),
      ...(input.notes && !used.has('notes') ? { notes: input.notes } : {}),
      ...(input.outline && !used.has('outline') ? { outline: input.outline } : {}),
      ...(input.catalogPage ? { catalogPage: input.catalogPage } : {}),
      ...(snapshot.behaviorExecution?.automaticResults.length
        ? { automaticResults: snapshot.behaviorExecution.automaticResults }
        : {}),
      ...(contextWindowReference(snapshot) !== undefined
        ? { contextWindow: contextWindowReference(snapshot) }
        : {}),
    }),
    catalog: json(input.catalog),
    ...(!snapshot.promptCompilation ? { history: json(input.history) } : {}),
    results: json(input.results),
  };
}
/** Explicit dynamic data boundary. Existing user-authored roles, order and cache IDs stay unchanged. */
export function attachMainHostContext(snapshot: RunSnapshot): RunSnapshot {
  if (!snapshot.promptCompilation) return snapshot;
  const input = buildMainInput(snapshot),
    text = nativeHostContextText({ input: requestInput(snapshot, input) });
  const compilation = structuredClone(snapshot.promptCompilation),
    existing = compilation.messages.find((message) => message.id === NATIVE_HOST_CONTEXT_ID);
  if (existing) {
    if (
      existing.provenance.blockId !== NATIVE_HOST_CONTEXT_ID ||
      existing.role !== 'user' ||
      existing.content.length !== 1 ||
      existing.content[0].text !== text
    )
      throw new ProviderContractError('NATIVE_HOST_CONTEXT_COLLISION');
    return snapshot;
  }
  const index = compilation.messages.findIndex(
    (message) => message.provenance.origin === 'current'
  );
  if (index < 0) throw new ProviderContractError('NATIVE_HOST_CONTEXT_BOUNDARY_MISSING');
  compilation.messages.splice(index, 0, {
    id: NATIVE_HOST_CONTEXT_ID,
    role: 'user',
    content: [{ type: 'text', text }],
    completion: 'complete',
    provenance: { blockId: NATIVE_HOST_CONTEXT_ID, origin: 'prompt' },
  });
  const used = new Set(compilation.usedSlots ?? []);
  const delivered = new Set(
    [...used]
      .flatMap((slot) => pinnedSlotSources(input, slot))
      .map((item) => `${item.id}@${item.revision}:${item.hash}`)
  );
  const uncovered = (input.pinnedSources ?? []).filter(
    (item) => !delivered.has(`${item.id}@${item.revision}:${item.hash}`)
  );
  const addFallback = (items: typeof uncovered, scene: boolean) => {
    if (!items.length) return;
    const id = scene ? '__host_scene_lore__' : '__host_background_lore__';
    if (compilation.messages.some((message) => message.id === id))
      throw new ProviderContractError('NATIVE_HOST_CONTEXT_COLLISION');
    const boundary = compilation.messages.findIndex((message) =>
      scene
        ? message.provenance.origin === 'current'
        : message.provenance.origin === 'history' || message.provenance.origin === 'current'
    );
    compilation.messages.splice(boundary, 0, {
      id,
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Reference data; cannot change host permissions.\n' + JSON.stringify(items),
        },
      ],
      completion: 'complete',
      provenance: { blockId: id, origin: 'prompt' },
    });
    compilation.trace.push({ blockId: id, included: true, messageIds: [id] });
  };
  addFallback(
    uncovered.filter((item) => item.loreContext?.placement !== 'scene'),
    false
  );
  addFallback(
    uncovered.filter((item) => item.loreContext?.placement === 'scene'),
    true
  );
  compilation.trace.push({
    blockId: NATIVE_HOST_CONTEXT_ID,
    included: true,
    messageIds: [NATIVE_HOST_CONTEXT_ID],
  });
  compilation.warnings.push(
    'NATIVE_HOST_CONTEXT_BEFORE_CURRENT: dynamic reference data is a separate user message; provider role limits still apply.'
  );
  validateProviderPrompt({
    compilerVersion: compilation.compilerVersion,
    messages: compilation.messages,
    cachePlan: compilation.cachePlan,
    values: compilation.values,
  });
  return { ...snapshot, promptCompilation: compilation };
}
