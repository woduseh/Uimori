// Without a build, the runtime starts the worker from its raw `.ts` file, where Node cannot
// resolve a sibling `./x.js` specifier. Import this module with `import type` only, and pass
// numeric limits as data in `NativeLuaWorkerInput.limits`.

export type NativeLuaWorkerPhase = 'active' | 'host-wait';

export type NativeLuaWorkerResultCode =
  | 'RISU_LUA_PROGRAM_INPUT_SIZE'
  | 'RISU_LUA_PROGRAM_RUNTIME_FAILED'
  | 'RISU_LUA_PROGRAM_FAILED'
  | 'RISU_LUA_PROGRAM_TIMEOUT'
  | 'RISU_LUA_PROGRAM_RESULT_VALUE'
  | 'RISU_LUA_PROGRAM_OUTPUT_SIZE';

export type NativeLuaWorkerLimits = {
  readonly cpuMs: number;
  readonly guestJsonBytes: number;
  readonly snapshotJsonBytes: number;
  readonly sourceBytes: number;
  readonly hostMethodChars: number;
  readonly hostCalls: number;
  readonly hostPending: number;
  readonly hostResultBytes: number;
  readonly valueDepth: number;
  readonly valueNodes: number;
  readonly valueEntries: number;
  readonly luaMemoryBytes: number;
};

export type NativeLuaWorkerInput = {
  source: string;
  inputJSON: string;
  historyJSON: string;
  hostErrorCodes: string[];
  limits: NativeLuaWorkerLimits;
};

export type NativeLuaWorkerResult =
  | { type: 'result'; ok: true; json: string }
  | { type: 'result'; ok: false; code: string };
export type NativeLuaWorkerHostCall = {
  type: 'host-call';
  id: number;
  method: string;
  argsJson: string;
};
export type NativeLuaWorkerPhaseReport = {
  type: 'phase';
  phase: NativeLuaWorkerPhase;
  sequence: number;
  hostIds: number[];
};
export type NativeLuaWorkerMessage =
  | NativeLuaWorkerResult
  | NativeLuaWorkerHostCall
  | NativeLuaWorkerPhaseReport;
export type NativeLuaHostReply =
  | {
      type: 'host-result';
      id: number;
      ok: true;
      json: string;
      resetBudget?: boolean;
      historyJSON?: string;
    }
  | { type: 'host-result'; id: number; ok: false; code: string };
