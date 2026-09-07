import type { ContentRef, ModelPreset, Connection } from './product.js';
import type { StateModule, StateValues, StateProposal } from './state.js';
import type { MemoryEntry, MemoryCheckpoint, MemoryContextPlan } from './memory.js';
import { memoryHash } from './memory.js';
import { initialState } from './state.js';

export type StoryConfig = {
  revision: number;
  module: StateModule | null;
  stateModel: ContentRef | null;
  memory: { enabled: boolean; model: ContentRef | null; recentCount: number; maxPacketChars: number };
  activatedAt: { revision: string; hash: string } | null;
};
export const defaultStoryConfig = (): StoryConfig => ({ revision: 0, module: null, stateModel: null, memory: { enabled: false, model: null, recentCount: 2, maxPacketChars: 60000 }, activatedAt: null });
export type StoryState = { id: string; sourceRevision: string | null; sourceHash: string | null; moduleRevision: number; values: StateValues; canonical: boolean };
/** An explicit rebuild re-applies the activation scene, starting immediately before it. */
export function activationRebuildState(chatId: string, config: StoryConfig, source: { id: string; hash: string }, history: { revision: string; text: string }[]): StoryState | null {
  if (!config.module || config.activatedAt?.revision !== source.id) return null;
  const parent = history.at(-1);
  return { id: `initial:${chatId}:${config.module.revision}:rebuild:${source.hash}`, sourceRevision: parent?.revision ?? null, sourceHash: parent ? memoryHash(parent.text) : null, moduleRevision: config.module.revision, values: initialState(config.module), canonical: config.module.mode !== 'annotation' };
}
export type StorySnapshot = {
  config: StoryConfig;
  state: StoryState | null;
  waiting: boolean;
  lineageHash: string;
  canonHash: string;
  memory: { entries: MemoryEntry[]; checkpoint: MemoryCheckpoint; plan: MemoryContextPlan } | null;
  models: Partial<Record<'state' | 'memory', ModelPreset & { connection: Connection }>>;
  sceneCommandId?: string;
};
export type StoryJob = {
  id: string; chatId: string; sourceRevision: string; sourceHash: string; kind: 'state' | 'memory';
  configRevision: number; generation: number; owner: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stale' | 'cancelled' | 'interrupted';
  error: string | null; mock: boolean; createdAt: string; updatedAt: string;
  result: StateProposal | { entries: MemoryEntry[] } | null;
  inputs?: unknown[]; toolEvents?: unknown[];
};
export type SceneCommand = { id: string; chatId: string; branchId: string; label: string; request: string; status: 'pending' | 'consumed' | 'failed' | 'cancelled'; runId: string | null; sourceRevision: string | null };
export type StoryDetail = { config: StoryConfig; state: StoryState | null; stateStatus: 'disabled' | 'ready' | 'pending' | 'stale'; jobs: StoryJob[]; memory: MemoryEntry[]; checkpoint: MemoryCheckpoint; commands: SceneCommand[] };
