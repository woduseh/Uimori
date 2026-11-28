import type { z } from 'zod/v4';
import type {
  AnySplitOperation,
  OperationHead,
  OperationOutput,
  OperationParsedInput,
} from '#contracts';
import { splitHeadBody } from '#contracts/operations';
import { AppError, asAppError } from './app-errors.js';
import { canonicalPayloadHash } from './json-hash.js';
import type { AppPorts, ReceiptLookup, ReceiptPort } from './store-ports.js';
import type { SynchronousResult } from './synchronous-transaction.js';
import type { Tx } from './tx.js';

export { canonicalPayloadHash };

export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const error = new AppError(400, 'INVALID_REQUEST');
  error.message = `INVALID_REQUEST: ${parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || 'input'}: ${issue.message}`)
    .join('; ')}`;
  throw error;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

export type ReceiptSpec<Op extends AnySplitOperation, P, R> = {
  readonly store: (ports: P) => ReceiptPort<R>;
  readonly scope: (head: OperationHead<Op>) => string;
  readonly key: (head: OperationHead<Op>) => string;
  readonly digest?: (head: OperationHead<Op>, raw: Record<string, unknown>) => string;
  readonly conflictMessage?: string;
  readonly serialize: (output: OperationOutput<Op>, input: OperationParsedInput<Op>) => R;
  readonly onReplay: (
    tx: Tx | null,
    ports: P,
    record: R,
    head: OperationHead<Op>
  ) => SynchronousResult<OperationOutput<Op>>;
};

export type CommandSpec<
  Op extends AnySplitOperation,
  P extends Pick<AppPorts, 'tx'>,
  G,
  Prep,
  R,
> = {
  readonly receipt?: ReceiptSpec<Op, P, R>;
  readonly prepare?: (
    ports: P,
    head: OperationHead<Op>,
    raw: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<Prep>;
  readonly guard: (tx: Tx, ports: P, head: OperationHead<Op>) => SynchronousResult<G>;
  readonly apply: (
    tx: Tx,
    ports: P,
    input: OperationParsedInput<Op>,
    guarded: G,
    prepared: Prep
  ) => SynchronousResult<OperationOutput<Op>>;
  readonly afterCommit?: (
    ports: P,
    output: OperationOutput<Op>,
    input: OperationParsedInput<Op>,
    guarded: G,
    prepared: Prep
  ) => void | Promise<void>;
};

export type Command<
  Op extends AnySplitOperation = AnySplitOperation,
  P extends Pick<AppPorts, 'tx'> = AppPorts,
> = { readonly op: Op } & CommandSpec<Op, P, any, any, any>;

export function defineCommand<P extends Pick<AppPorts, 'tx'> = Pick<AppPorts, 'tx'>>() {
  return <Op extends AnySplitOperation, G = void, Prep = void, R = never>(
    op: Op,
    spec: CommandSpec<Op, P, G, Prep, R>
  ): Command<Op, P> => ({ op, ...spec });
}

export type CommandOutcome<Op extends AnySplitOperation = AnySplitOperation> =
  | { readonly replayed: true; readonly output: OperationOutput<Op> }
  | {
      readonly replayed: false;
      readonly output: OperationOutput<Op>;
      readonly input: OperationParsedInput<Op>;
    };

export type CommandContext = {
  readonly signal?: AbortSignal;
  readonly checkOutputs?: boolean;
};

export type StagedOperation<Op extends AnySplitOperation = AnySplitOperation> = {
  readonly replay: () => CommandOutcome<Op> | undefined;
  readonly run: (tx: Tx) => CommandOutcome<Op>;
  readonly afterCommit: () => Promise<void>;
};

function assertSyncReturn(value: unknown, phase: string): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  ) {
    Promise.resolve(value).catch(() => {});
    throw new Error(`Async ${phase} callback is not allowed inside a synchronous transaction`);
  }
}

function enforceOutput<Op extends AnySplitOperation>(
  op: Op,
  output: OperationOutput<Op>,
  checkOutputs: boolean | undefined
): OperationOutput<Op> {
  if (op.outputPolicy === 'always') {
    if (!op.output) throw new Error(`Operation ${op.name} requires an output schema`);
    return op.output.parse(output) as OperationOutput<Op>;
  }
  if (checkOutputs && op.output) return op.output.parse(output) as OperationOutput<Op>;
  return output;
}

export async function stageOperation<Op extends AnySplitOperation, P extends Pick<AppPorts, 'tx'>>(
  command: Command<Op, P>,
  ports: P,
  rawInput: unknown,
  ctx: CommandContext = {}
): Promise<StagedOperation<Op>> {
  const raw = plainRecord(rawInput);
  const { headRaw, bodyRaw } = splitHeadBody(command.op.head, raw);
  const head = parseInput(command.op.head, headRaw);
  const receipt = command.receipt;
  const receiptStore = receipt?.store(ports);
  const lookup: ReceiptLookup | undefined = receipt && {
    scope: receipt.scope(head),
    key: receipt.key(head),
    digest: receipt.digest ? receipt.digest(head, raw) : canonicalPayloadHash(raw),
    ...(receipt.conflictMessage ? { conflictMessage: receipt.conflictMessage } : {}),
  };
  const readReceipt = (tx: Tx | null): unknown =>
    receiptStore && lookup ? receiptStore.read(tx, lookup) : undefined;
  const replayRecord = (tx: Tx | null, record: unknown): CommandOutcome<Op> => {
    const output = receipt!.onReplay(tx, ports, record, head);
    assertSyncReturn(output, 'onReplay');
    return { replayed: true, output: enforceOutput(command.op, output, ctx.checkOutputs) };
  };

  let prior = readReceipt(null);
  let prepared: unknown;
  let preparationFailure: { readonly error: unknown } | undefined;
  if (prior === undefined && command.prepare) {
    try {
      prepared = await command.prepare(ports, head, raw, ctx.signal);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      prior = readReceipt(null);
      if (prior === undefined) throw error;
      preparationFailure = { error };
    }
  }

  let applied:
    | {
        readonly output: OperationOutput<Op>;
        readonly input: OperationParsedInput<Op>;
        readonly guarded: unknown;
      }
    | undefined;
  return {
    replay: () => (prior === undefined ? undefined : replayRecord(null, prior)),
    run(tx) {
      applied = undefined;
      const record = readReceipt(tx);
      if (record !== undefined) return replayRecord(tx, record);
      if (preparationFailure) throw preparationFailure.error;
      const guarded = command.guard(tx, ports, head);
      assertSyncReturn(guarded, 'guard');
      const input = {
        ...head,
        ...parseInput(command.op.body, bodyRaw),
      } as OperationParsedInput<Op>;
      const returned = command.apply(tx, ports, input, guarded, prepared);
      assertSyncReturn(returned, 'apply');
      const output = enforceOutput(command.op, returned, ctx.checkOutputs);
      if (receipt && receiptStore && lookup)
        receiptStore.save(tx, lookup, receipt.serialize(output, input));
      applied = { output, input, guarded };
      return { replayed: false, output, input };
    },
    async afterCommit() {
      const committed = applied;
      applied = undefined;
      if (committed && command.afterCommit)
        await command.afterCommit(
          ports,
          committed.output,
          committed.input,
          committed.guarded,
          prepared
        );
    },
  };
}

export async function executeOperation<
  Op extends AnySplitOperation,
  P extends Pick<AppPorts, 'tx'>,
>(
  command: Command<Op, P>,
  ports: P,
  rawInput: unknown,
  ctx: CommandContext = {}
): Promise<OperationOutput<Op>> {
  try {
    const staged = await stageOperation(command, ports, rawInput, ctx);
    const outcome = staged.replay() ?? ports.tx.transaction((tx) => staged.run(tx));
    await staged.afterCommit();
    return outcome.output;
  } catch (error) {
    throw asAppError(error);
  }
}
