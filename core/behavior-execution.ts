import type { PackageExecutionState } from './execution-context.js';
import type { RuntimeValue } from './prompt-program.js';

/** Frozen at admission. Mutable progress belongs to the host's separate run journal. */
export interface BehaviorRunSnapshot {
  version: 1;
  opportunityId: string;
  baseStates: PackageExecutionState[];
  automaticResults: { instanceId: string; actionId: string; result: RuntimeValue }[];
}
