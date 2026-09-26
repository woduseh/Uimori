/**
 * The wire contract between the native Risu Lua session and its isolated worker.
 *
 * Types only, imported with `import type` everywhere: the runtime starts a worker from the raw
 * `.ts` file whenever no build output sits next to it, and in that mode Node cannot resolve a
 * sibling `./x.js` specifier, so a worker can never value-import another module. Numeric limits
 * therefore travel as data in `NativeLuaWorkerInput.limits`, owned by the runtime.
 */

/** Watchdog phase a worker reports; the runtime bills wall time against the reported phase. */
export type NativeLuaWorkerPhase = 'active' | 'host-wait';

/** Terminal codes a worker may report for its own invocation. */
export type NativeLuaWorkerResultCode =
  | 'RISU_LUA_PROGRAM_INPUT_SIZE'
  | 'RISU_LUA_PROGRAM_RUNTIME_FAILED'
  | 'RISU_LUA_PROGRAM_FAILED'
  | 'RISU_LUA_PROGRAM_TIMEOUT'
  | 'RISU_LUA_PROGRAM_RESULT_VALUE'
  | 'RISU_LUA_PROGRAM_OUTPUT_SIZE';

/**
 * Numeric bounds the runtime owns and hands to a worker. A worker refuses to start when any of
 * them is missing or malformed rather than falling back to a literal of its own.
 */
export type NativeLuaWorkerLimits = {
  /** Guest CPU milliseconds, measured only while guest code runs. */
  readonly cpuMs: number;
  /** UTF-8 cap on an individual guest-authored JSON value or external host call. */
  readonly guestJsonBytes: number;
  /** Whole conversation snapshots use a separate allocation guard, without truncating history. */
  readonly snapshotJsonBytes: number;
  /** UTF-8 cap on the program source, behind core's own validation. */
  readonly sourceBytes: number;
  readonly hostMethodChars: number;
  readonly hostCalls: number;
  readonly hostPending: number;
  /** Cumulative UTF-8 cap across all host results of one invocation. */
  readonly hostResultBytes: number;
  /** Structured value bounds shared by both codecs. */
  readonly valueDepth: number;
  readonly valueNodes: number;
  readonly valueEntries: number;
  readonly luaMemoryBytes: number;
};

/** `workerData` for the native Lua worker. */
export type NativeLuaWorkerInput = {
  source: string;
  inputJSON: string;
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
/** Worker to host. */
export type NativeLuaWorkerMessage =
  | NativeLuaWorkerResult
  | NativeLuaWorkerHostCall
  | NativeLuaWorkerPhaseReport;
/** Host to worker. */
export type NativeLuaHostReply =
  | { type: 'host-result'; id: number; ok: true; json: string; resetBudget?: boolean }
  | { type: 'host-result'; id: number; ok: false; code: string };
