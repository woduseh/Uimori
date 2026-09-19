/**
 * The wire contract between extension-runtime.ts and both guest workers.
 *
 * Types only, imported with `import type` everywhere: the runtime starts a worker from the raw
 * `.ts` file whenever no build output sits next to it, and in that mode Node cannot resolve a
 * sibling `./x.js` specifier, so a worker can never value-import another module. Numeric limits
 * therefore travel as data in `ExtensionWorkerInput.limits`, owned by the runtime.
 */

/** Watchdog phase a worker reports; the runtime bills wall time against the reported phase. */
export type ExtensionWorkerPhase = 'active' | 'host-wait';

/** Terminal codes a worker may report for its own invocation. */
export type ExtensionWorkerResultCode =
  | 'BEHAVIOR_PROGRAM_INPUT_SIZE'
  | 'BEHAVIOR_PROGRAM_RUNTIME_FAILED'
  | 'BEHAVIOR_PROGRAM_FAILED'
  | 'BEHAVIOR_PROGRAM_TIMEOUT'
  | 'BEHAVIOR_PROGRAM_RESULT_VALUE'
  | 'BEHAVIOR_PROGRAM_OUTPUT_SIZE';

/** Host denial codes the runtime forwards to a guest unchanged; anything else becomes CALL_FAILED. */
export type ExtensionHostErrorCode =
  | 'BEHAVIOR_HOST_CALL_FAILED'
  | 'BEHAVIOR_HOST_DENIED'
  | 'BEHAVIOR_HOST_ARGUMENTS'
  | 'BEHAVIOR_HOST_MATERIAL_UNAVAILABLE'
  | 'BEHAVIOR_HOST_ABORTED'
  | 'BEHAVIOR_HOST_RESULT_LIMIT'
  | 'BEHAVIOR_HOST_MODEL_DENIED'
  | 'BEHAVIOR_HOST_MODEL_UNAVAILABLE'
  | 'BEHAVIOR_HOST_MODEL_BUDGET_EXHAUSTED'
  | 'BEHAVIOR_HOST_VARIABLES_DENIED'
  | 'BEHAVIOR_HOST_VARIABLES_LIMIT'
  | 'BEHAVIOR_HOST_CONVERSATION_DENIED'
  | 'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE';

/** Codes a guest harness raises on its own, on top of the forwarded host codes. */
export type ExtensionGuestHostErrorCode =
  | ExtensionHostErrorCode
  | 'BEHAVIOR_HOST_CALL_LIMIT'
  | 'BEHAVIOR_HOST_PENDING_LIMIT';

/**
 * The single string a guest harness returns: `E` the program threw, `V` the result is not an
 * exact `{ state, result }` value, `L` the encoded result exceeds the JSON limit, `O` + JSON.
 * Both harnesses encode the same envelope for the same program; tests/extension-runtime.test.ts
 * pins that agreement.
 */
export type ExtensionResultEnvelope = 'E' | 'V' | 'L' | `O${string}`;

/**
 * Numeric bounds the runtime owns and hands to a worker. A worker refuses to start when any of
 * them is missing or malformed rather than falling back to a literal of its own.
 */
export type ExtensionWorkerLimits = {
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
  readonly quickjsMemoryBytes: number;
  readonly quickjsStackBytes: number;
  readonly luaMemoryBytes: number;
};

/** `workerData` for both guest workers. */
export type ExtensionWorkerInput = {
  source: string;
  inputJSON: string;
  hostErrorCodes: string[];
  limits: ExtensionWorkerLimits;
};

export type ExtensionWorkerResult =
  | { type: 'result'; ok: true; json: string }
  | { type: 'result'; ok: false; code: string };
export type ExtensionWorkerHostCall = {
  type: 'host-call';
  id: number;
  method: string;
  argsJson: string;
};
export type ExtensionWorkerPhaseReport = {
  type: 'phase';
  phase: ExtensionWorkerPhase;
  sequence: number;
  hostIds: number[];
};
/** Worker to host. */
export type ExtensionWorkerMessage =
  | ExtensionWorkerResult
  | ExtensionWorkerHostCall
  | ExtensionWorkerPhaseReport;
/** Host to worker. */
export type ExtensionHostReply =
  | { type: 'host-result'; id: number; ok: true; json: string; resetBudget?: boolean }
  | { type: 'host-result'; id: number; ok: false; code: string };
