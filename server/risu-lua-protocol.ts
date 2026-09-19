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

/** Host denial codes the runtime forwards to a guest unchanged; anything else becomes CALL_FAILED. */
export type NativeLuaHostErrorCode =
  | 'RISU_LUA_HOST_CALL_FAILED'
  | 'RISU_LUA_HOST_DENIED'
  | 'RISU_LUA_HOST_ARGUMENTS'
  | 'RISU_LUA_HOST_MATERIAL_UNAVAILABLE'
  | 'RISU_LUA_HOST_ABORTED'
  | 'RISU_LUA_HOST_RESULT_LIMIT'
  | 'RISU_LUA_HOST_MODEL_DENIED'
  | 'RISU_LUA_HOST_MODEL_UNAVAILABLE'
  | 'RISU_LUA_HOST_MODEL_BUDGET_EXHAUSTED'
  | 'RISU_LUA_HOST_VARIABLES_DENIED'
  | 'RISU_LUA_HOST_VARIABLES_LIMIT'
  | 'RISU_LUA_HOST_CONVERSATION_DENIED'
  | 'RISU_LUA_HOST_CONVERSATION_UNAVAILABLE';

/** Codes a guest harness raises on its own, on top of the forwarded host codes. */
export type NativeLuaGuestHostErrorCode =
  | NativeLuaHostErrorCode
  | 'RISU_LUA_HOST_CALL_LIMIT'
  | 'RISU_LUA_HOST_PENDING_LIMIT';

/**
 * The single string a guest harness returns: `E` the program threw, `V` the result is not an
 * exact `{ state, result }` value, `L` the encoded result exceeds the JSON limit, `O` + JSON.
 * Both harnesses encode the same envelope for the same program; tests/extension-runtime.test.ts
 * pins that agreement.
 */
export type NativeLuaResultEnvelope = 'E' | 'V' | 'L' | `O${string}`;

/**
 * Numeric bounds the runtime owns and hands to a worker. A worker refuses to start when any of
 * them is missing or malformed rather than falling back to a literal of its own.
 */
export type NativeLuaWorkerLimits = {
  /** Guest CPU milliseconds, measured only while guest code runs. */
  readonly cpuMs: number;
  /** UTF-8 cap on every JSON string crossing the guest boundary, in either direction. */
  readonly guestJsonBytes: number;
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
