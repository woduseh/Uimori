import type { z } from 'zod/v4';
import type {
  AnySplitOperation,
  OperationBody,
  OperationHead,
  OperationOutput,
  OperationParsedInput,
} from '#contracts';
import { splitHeadBody } from '#contracts/operations';
import { AppError, asAppError } from './app-errors.js';
import { canonicalPayloadHash } from './json-hash.js';
import type { AppPorts, ReceiptLookup, ReceiptPort, ReceiptRecord } from './store-ports.js';
import type { SynchronousResult } from './synchronous-transaction.js';
import type { Tx } from './tx.js';

export { canonicalPayloadHash };

export const EXTERNAL_REPLAY = Symbol('externalReplay');

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

export type ReceiptSpec<
  Op extends AnySplitOperation,
  P,
  R = ReceiptRecord,
  A = OperationOutput<Op>,
> = {
  readonly adapter?: 'import';
  readonly store?: (ports: P) => ReceiptPort<R>;
  readonly scope: (head: OperationHead<Op>) => string;
  readonly key: (head: OperationHead<Op>) => string;
  readonly digest?: (head: OperationHead<Op>, raw: Record<string, unknown>) => string;
  readonly conflictMessage?: string;
  readonly serialize: (applied: NoInfer<A>, input: OperationParsedInput<Op>) => R;
  readonly onReplay: (
    tx: Tx | null,
    ports: P,
    record: R,
    head: OperationHead<Op>
  ) => SynchronousResult<A>;
};

type BaseCommandSpec<
  Op extends AnySplitOperation,
  P extends Pick<AppPorts, 'tx'>,
  G,
  Prep,
  R,
  A,
> = {
  readonly receipt?: P extends Pick<AppPorts, 'tx' | 'receipt'>
    ? ReceiptSpec<Op, P, R, A>
    : ReceiptSpec<Op, P, R, A> & { readonly store: (ports: P) => ReceiptPort<R> };
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
  ) => SynchronousResult<A>;
  readonly afterCommit?: (
    ports: P,
    output: NoInfer<A>,
    input: OperationParsedInput<Op>,
    guarded: G,
    prepared: Prep
  ) => void | Promise<void>;
};

export type CommandSpec<
  Op extends AnySplitOperation,
  P extends Pick<AppPorts, 'tx'>,
  G,
  Prep,
  R = ReceiptRecord,
  A = OperationOutput<Op>,
> = BaseCommandSpec<Op, P, G, Prep, R, A> & {
  readonly project?: (
    tx: Tx | null,
    ports: P,
    applied: NoInfer<A>,
    head: OperationHead<Op>
  ) => SynchronousResult<OperationOutput<Op>>;
};

export type Command<
  Op extends AnySplitOperation = AnySplitOperation,
  P extends Pick<AppPorts, 'tx'> = AppPorts,
  A = any,
> = {
  readonly op: Op;
  readonly receipt?: ReceiptSpec<Op, P, any, A>;
  readonly prepare?: (
    ports: P,
    head: OperationHead<Op>,
    raw: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<any>;
  readonly guard: (tx: Tx, ports: P, head: OperationHead<Op>) => SynchronousResult<any>;
  readonly apply: (
    tx: Tx,
    ports: P,
    input: OperationParsedInput<Op>,
    guarded: any,
    prepared: any
  ) => SynchronousResult<A>;
  readonly project?: (
    tx: Tx | null,
    ports: P,
    applied: A,
    head: OperationHead<Op>
  ) => SynchronousResult<OperationOutput<Op>>;
  readonly afterCommit?: (
    ports: P,
    output: A,
    input: OperationParsedInput<Op>,
    guarded: any,
    prepared: any
  ) => void | Promise<void>;
};

type ResolvedApplied<Op extends AnySplitOperation, A> = [A] extends [never]
  ? OperationOutput<Op>
  : A;

export function defineCommand<P extends Pick<AppPorts, 'tx'> = Pick<AppPorts, 'tx'>, A = never>() {
  return <Op extends AnySplitOperation, G = void, Prep = void, R = ReceiptRecord>(
    op: Op,
    spec: BaseCommandSpec<Op, P, G, Prep, R, ResolvedApplied<Op, A>> &
      ([A] extends [never]
        ? { readonly project?: undefined }
        : {
            readonly project: (
              tx: Tx | null,
              ports: P,
              applied: A,
              head: OperationHead<Op>
            ) => SynchronousResult<OperationOutput<Op>>;
          })
  ): Command<Op, P, ResolvedApplied<Op, A>> => ({ op, ...spec });
}

export type CommandInTxOutcome<Op extends AnySplitOperation, Output = OperationOutput<Op>> =
  | { readonly replayed: true; readonly output: Output }
  | {
      readonly replayed: false;
      readonly output: Output;
      readonly input: OperationParsedInput<Op>;
    };

export type CommandContext<
  Op extends AnySplitOperation = AnySplitOperation,
  OnInTxReturn = void,
  Output = OperationOutput<Op>,
> = {
  readonly signal?: AbortSignal;
  readonly checkOutputs?: boolean;
  readonly skipProject?: boolean;
  readonly bodySchema?: z.ZodType<OperationBody<Op>>;
  readonly aroundTx?: <T>(
    run: () => SynchronousResult<T>
  ) => SynchronousResult<T> | typeof EXTERNAL_REPLAY;
  readonly aroundApply?: <T>(
    tx: Tx,
    input: OperationParsedInput<Op>,
    run: () => SynchronousResult<T>
  ) => SynchronousResult<T>;
  readonly onInTx?: (
    tx: Tx,
    outcome: CommandInTxOutcome<Op, Output>
  ) => SynchronousResult<OnInTxReturn>;
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

function buildReceiptLookup<Op extends AnySplitOperation, P, R, A>(
  receipt: ReceiptSpec<Op, P, R, A>,
  head: OperationHead<Op>,
  raw: Record<string, unknown>
): ReceiptLookup {
  return {
    adapter: receipt.adapter,
    scope: receipt.scope(head),
    key: receipt.key(head),
    digest: receipt.digest ? receipt.digest(head, raw) : canonicalPayloadHash(raw),
    ...(receipt.conflictMessage ? { conflictMessage: receipt.conflictMessage } : {}),
  };
}

export async function executeOperation<
  Op extends AnySplitOperation,
  P extends Pick<AppPorts, 'tx'>,
  A = OperationOutput<Op>,
  OnInTxReturn = void,
>(
  command: Command<Op, P, A>,
  ports: P,
  rawInput: unknown,
  ctx: CommandContext<Op, OnInTxReturn, any> = {}
): Promise<OperationOutput<Op>> {
  try {
    const raw = plainRecord(rawInput);
    const { headRaw, bodyRaw } = splitHeadBody(command.op.head, raw);
    const head = parseInput(command.op.head, headRaw);
    const receiptLookup = command.receipt
      ? buildReceiptLookup(command.receipt, head, raw)
      : undefined;
    const receiptStore = command.receipt
      ? (command.receipt.store?.(ports) ?? (ports as P & Pick<AppPorts, 'receipt'>).receipt)
      : undefined;
    const shouldProject =
      command.project !== undefined && (!ctx.skipProject || command.op.outputPolicy === 'always');
    const finalizeOutput = (tx: Tx | null, applied: A) => {
      if (shouldProject) {
        const projected = command.project!(tx, ports, applied, head);
        assertSyncReturn(projected, 'project');
        return enforceOutput(command.op, projected, ctx.checkOutputs);
      }
      if (command.project !== undefined) return applied;
      return enforceOutput(command.op, applied as unknown as OperationOutput<Op>, ctx.checkOutputs);
    };

    const fastReplay = !ctx.aroundTx && !ctx.onInTx;
    let prior =
      receiptLookup && receiptStore && (command.prepare || fastReplay)
        ? receiptStore.read(null, receiptLookup)
        : undefined;
    let prepared: unknown;
    let preparationFailure: { error: unknown } | undefined;
    if (prior === undefined && command.prepare) {
      try {
        prepared = await command.prepare(ports, head, raw, ctx.signal);
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        prior = receiptLookup && receiptStore ? receiptStore.read(null, receiptLookup) : undefined;
        if (prior === undefined) throw error;
        preparationFailure = { error };
      }
    }
    if (prior !== undefined && command.receipt && fastReplay) {
      const applied = command.receipt.onReplay(null, ports, prior, head);
      assertSyncReturn(applied, 'onReplay');
      return finalizeOutput(null, applied) as OperationOutput<Op>;
    }

    const runInTx = () =>
      ports.tx.transaction((tx) => {
        if (command.receipt && receiptLookup && receiptStore) {
          const prior = receiptStore.read(tx, receiptLookup);
          if (prior !== undefined) {
            const applied = command.receipt.onReplay(tx, ports, prior, head);
            assertSyncReturn(applied, 'onReplay');
            const output = finalizeOutput(tx, applied);
            const outcome = { replayed: true as const, output };
            assertSyncReturn(ctx.onInTx?.(tx, outcome), 'onInTx');
            return { ...outcome, applied };
          }
        }
        if (preparationFailure) throw preparationFailure.error;
        const guarded = command.guard(tx, ports, head);
        const body = parseInput(ctx.bodySchema ?? command.op.body, bodyRaw);
        const input = { ...head, ...body } as OperationParsedInput<Op>;
        const applied = ctx.aroundApply
          ? ctx.aroundApply(tx, input, () => command.apply(tx, ports, input, guarded, prepared))
          : command.apply(tx, ports, input, guarded, prepared);
        assertSyncReturn(applied, ctx.aroundApply ? 'aroundApply' : 'apply');
        const output = finalizeOutput(tx, applied);
        if (command.receipt && receiptLookup && receiptStore)
          receiptStore.save(tx, receiptLookup, command.receipt.serialize(applied, input));
        const outcome = { replayed: false as const, output, input, guarded };
        assertSyncReturn(ctx.onInTx?.(tx, outcome), 'onInTx');
        return { ...outcome, applied };
      });

    const outcome = ctx.aroundTx ? ctx.aroundTx(runInTx) : runInTx();
    if (outcome === EXTERNAL_REPLAY) return undefined as OperationOutput<Op>;

    if (!outcome.replayed && command.afterCommit)
      await command.afterCommit(ports, outcome.applied, outcome.input, outcome.guarded, prepared);
    return outcome.output as OperationOutput<Op>;
  } catch (error) {
    throw asAppError(error);
  }
}
