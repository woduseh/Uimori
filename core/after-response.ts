import type { PackageExecutionState } from './execution-context.js';
import type { ExtensionProgramReceipt } from './extension-program.js';
import type { RuntimeValue } from './prompt-values.js';

/** Kept separate from the before-turn/model opportunity: each response has its own text. */
export type AfterResponseEntry = {
  instanceId: string;
  actionId: string;
  trigger: 'after-turn';
  input: RuntimeValue;
  before: PackageExecutionState;
  after: PackageExecutionState;
  result: RuntimeValue;
  draws: Record<string, RuntimeValue>;
  drawSeed: null;
  hostRuntime: Record<string, RuntimeValue>;
  program: ExtensionProgramReceipt;
};

export type AfterResponsePackage = {
  instanceId: string;
  status: 'ready' | 'failed';
  /** State after the existing before/model actions and output parsers. */
  before: PackageExecutionState;
  after: PackageExecutionState;
  entries: AfterResponseEntry[];
  code?: string;
};

export type AfterResponseProgress = {
  version: 1;
  sourceHash: string;
  status: 'running' | 'completed' | 'skipped';
  skipKey?: string;
  completed: number;
  total: number;
  packages: AfterResponsePackage[];
};
