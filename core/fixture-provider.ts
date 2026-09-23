import { buildMainInput, executeTool, knowledgeReadResults, type ToolAction } from './provider.js';
import type { ModelInput, Resource, RunSnapshot, ToolEvent, Usage } from './types.js';

/** Explicit synthetic behavior, never saved as user chat settings or sent to a provider. */
export type FixtureGeneration = { preset?: 'calm' | 'vivid'; mode?: 'direct' | 'research' };

function checkAbort(signal?: AbortSignal) {
  // Abort reasons may include a caller's data. Do not echo them into a run error.
  if (signal?.aborted) throw Object.assign(new Error('Run cancelled'), { name: 'AbortError' });
}

type SearchResult = { items: Omit<Resource, 'text' | 'chatId'>[] };
type ModelStep = { kind: 'tool'; action: ToolAction } | { kind: 'text'; text: string };

/** A deterministic fixture provider, not a creative quality or API compatibility model. */
function scriptedStep(input: ModelInput, options: FixtureGeneration): ModelStep {
  const research = options.mode === 'research';
  const success = input.results.filter((result) => !result.denied);
  if (research && !success.some((result) => result.name === 'knowledge.search')) {
    return {
      kind: 'tool',
      action: { callId: 'call-search', name: 'knowledge.search', args: { query: 'harbor' } },
    };
  }
  const search = success.find((result) => result.name === 'knowledge.search');
  const discovered = search
    ? (search.result as SearchResult).items.find((item) => item.kind === 'lore')
    : undefined;
  if (discovered && !success.some((result) => result.name === 'knowledge.read')) {
    return {
      kind: 'tool',
      action: { callId: 'call-read', name: 'knowledge.read', args: { ids: [discovered.id] } },
    };
  }
  const skill = input.catalog.find((item) => item.kind === 'skill');
  if (research && skill && !success.some((result) => result.name === 'skills.load')) {
    return {
      kind: 'tool',
      action: { callId: 'call-skill', name: 'skills.load', args: { id: skill.id } },
    };
  }
  const read = success.find((result) => result.name === 'knowledge.read');
  const detail =
    (read ? knowledgeReadResults(read)[0]?.text : undefined) ??
    'The evening tide moved softly beneath the wooden pier.';
  const opening =
    options.preset === 'vivid'
      ? 'Wind struck the pier in bright, salt-heavy bursts. Mira caught her coat against her wrist, the brass compass cold in her palm.'
      : 'Mira paused beside the quiet pier, resting the brass compass in her open palm. The water moved patiently below her.';
  const previous = input.history.at(-1);
  // The fixture incorporates the actual read result and current request; it never
  // invents evidence that a catalog entry's body was already read.
  return {
    kind: 'text',
    text: `${opening}\n\n${detail}${previous ? ' The thread of the earlier scene remained with her as she looked along the shore.' : ''}\n\nThe next scene was still open: ${input.task}\nMira waited beside the rail, leaving the next decision to her companion.`,
  };
}

export async function executeFixtureMain(
  snapshot: RunSnapshot,
  hooks: {
    signal: AbortSignal;
    onInput: (input: ModelInput) => void | Promise<void>;
    onToolEvent: (event: ToolEvent) => void | Promise<void>;
  },
  options: FixtureGeneration = {}
): Promise<{ text: string; usage: Usage }> {
  // Detach once so neither instrumentation nor UI settings changes can mutate
  // this run's context or expand scope during a tool loop.
  const fixed = structuredClone(snapshot);
  const generation = { ...options };
  const results: ToolEvent[] = [];
  let modelCalls = 0;
  while (true) {
    checkAbort(hooks.signal);
    if (
      !Number.isSafeInteger(fixed.settings.maxCalls) ||
      fixed.settings.maxCalls < 1 ||
      modelCalls >= fixed.settings.maxCalls
    ) {
      throw Object.assign(new Error('Model call budget exhausted'), { name: 'BudgetError' });
    }
    const input = buildMainInput(fixed, results, {
      compilerVersion: fixed.promptCompilation?.compilerVersion,
    });
    modelCalls++;
    // This is the exact mock-provider input, copied only to prevent log-hook writes.
    await hooks.onInput(structuredClone(input));
    checkAbort(hooks.signal);
    const step = scriptedStep(input, generation);
    if (step.kind === 'text')
      return {
        text: step.text,
        usage: { modelCalls, inputTokens: null, outputTokens: null, costUsd: null },
      };
    const event = executeTool(fixed, step.action, hooks.signal);
    results.push(event);
    await hooks.onToolEvent(structuredClone(event));
    checkAbort(hooks.signal);
    if (event.denied) throw new Error('Read tool request denied');
  }
}
