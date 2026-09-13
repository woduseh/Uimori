import type { ExtensionProgramResult, ResolvedExtensionProgram } from './extension-program.js';
import type { ProfileSnapshot } from './product.js';
import type { RuntimeValue } from './prompt-values.js';
import type { Settings, Usage } from './types.js';

export type ExtensionOperationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ExtensionOperationCommand {
  actionId: string;
  input: RuntimeValue;
  expectedStateRevision: number;
  expectedSourceHash: string | null;
  idempotencyKey: string;
  panel?: { id: string; packageRevision: number };
}

/** A user action has no prose Run or full transcript snapshot of its own. */
export interface ExtensionOperationSnapshot {
  version: 1;
  scope: {
    chatId: string;
    branchId: string;
    attachmentInstanceId: string;
    packageId: string;
    packageRevision: number;
    behaviorRevision: number;
    schemaVersion: number;
  };
  stateRevision: number;
  state: RuntimeValue;
  runtime: Record<string, RuntimeValue>;
  guard: string;
  profile: ProfileSnapshot;
  settings: Settings;
  sourceRevision: string | null;
  sourceHash: string | null;
  extensionConversation?: import('./extension-conversation.js').ExtensionConversationSnapshot;
}

export interface ExtensionOperation {
  id: string;
  chatId: string;
  branchId: string;
  instanceId: string;
  command: ExtensionOperationCommand;
  snapshot: ExtensionOperationSnapshot;
  status: ExtensionOperationStatus;
  generation: number;
  owner: string | null;
  result: ResolvedExtensionProgram | null;
  usage: Usage | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
}

/** User-facing projection; no code, model connection, credential reference or host runtime. */
export interface ExtensionOperationView {
  hasResult: boolean;
  id: string;
  instanceId: string;
  actionId: string;
  title: string;
  status: ExtensionOperationStatus;
  usage: Usage;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  result?: ExtensionProgramResult;
}
