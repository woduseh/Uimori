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
import { jsonPayloadHash } from './json-hash.js';
import type { AppPorts, ReceiptLookup, ReceiptRecord } from './store-ports.js';
import type { SynchronousResult } from './synchronous-transaction.js';
import type { Tx } from './tx.js';

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

function stripUndefined(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripUndefined);
  const cleaned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined)
      Object.defineProperty(cleaned, key, {
        value: stripUndefined(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return cleaned;
}

export const canonicalPayloadHash = (value: unknown): string =>
  jsonPayloadHash(stripUndefined(value));

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

export type ReceiptSpec<Op extends AnySplitOperation, P> = {
  readonly adapter?: 'import';
  readonly scope: (head: OperationHead<Op>) => string;
  readonly key: (head: OperationHead<Op>) => string;
  readonly digest?: (head: OperationHead<Op>, raw: Record<string, unknown>) => string;
  readonly conflictMessage?: string;
  readonly serialize: (output: OperationOutput<Op>) => ReceiptRecord;
  readonly onReplay: (
    tx: Tx | null,
    ports: P,
    record: ReceiptRecord,
    head: OperationHead<Op>
  ) => SynchronousResult<OperationOutput<Op>>;
};

export type CommandSpec<Op extends AnySplitOperation, P extends Pick<AppPorts, 'tx'>, G, Prep> = {
  readonly receipt?: P extends Pick<AppPorts, 'tx' | 'receipt'> ? ReceiptSpec<Op, P> : never;
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
> = {
  readonly op: Op;
  readonly receipt?: ReceiptSpec<Op, P>;
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
  ) => SynchronousResult<OperationOutput<Op>>;
  readonly afterCommit?: (
    ports: P,
    output: OperationOutput<Op>,
    input: OperationParsedInput<Op>,
    guarded: any,
    prepared: any
  ) => void | Promise<void>;
};

export function defineCommand<P extends Pick<AppPorts, 'tx'> = Pick<AppPorts, 'tx'>>() {
  return <Op extends AnySplitOperation, G = void, Prep = void>(
    op: Op,
    spec: CommandSpec<Op, P, G, Prep>
  ): Command<Op, P> => ({ op, ...spec });
}

export type CommandInTxOutcome<Op extends AnySplitOperation> =
  | { readonly replayed: true; readonly output: OperationOutput<Op> }
  | {
      readonly replayed: false;
      readonly output: OperationOutput<Op>;
      readonly input: OperationParsedInput<Op>;
    };

export type CommandContext<
  Op extends AnySplitOperation = AnySplitOperation,
  OnInTxReturn = void,
> = {
  readonly signal?: AbortSignal;
  readonly checkOutputs?: boolean;
  readonly bodySchema?: z.ZodType<OperationBody<Op>>;
  readonly aroundTx?: <T>(
    run: () => SynchronousResult<T>
  ) => SynchronousResult<T> | typeof EXTERNAL_REPLAY;
  readonly onInTx?: (tx: Tx, outcome: CommandInTxOutcome<Op>) => SynchronousResult<OnInTxReturn>;
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

function buildReceiptLookup<Op extends AnySplitOperation, P>(
  receipt: ReceiptSpec<Op, P>,
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
  OnInTxReturn = void,
>(
  command: Command<Op, P>,
  ports: P,
  rawInput: unknown,
  ctx: CommandContext<Op, OnInTxReturn> = {}
): Promise<OperationOutput<Op>> {
  try {
    const raw = plainRecord(rawInput);
    const { headRaw, bodyRaw } = splitHeadBody(command.op.head, raw);
    const head = parseInput(command.op.head, headRaw);
    const receiptLookup = command.receipt
      ? buildReceiptLookup(command.receipt, head, raw)
      : undefined;

    const receiptPort = (ports as P & Pick<AppPorts, 'receipt'>).receipt;
    const fastReplay = !ctx.aroundTx && !ctx.onInTx;
    let prior =
      receiptLookup && (command.prepare || fastReplay)
        ? receiptPort.read(null, receiptLookup)
        : undefined;
    let prepared: unknown;
    let preparationFailure: { error: unknown } | undefined;
    if (!prior && command.prepare) {
      try {
        prepared = await command.prepare(ports, head, raw, ctx.signal);
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        prior = receiptLookup && receiptPort.read(null, receiptLookup);
        if (!prior) throw error;
        preparationFailure = { error };
      }
    }
    if (prior && command.receipt && fastReplay)
      return enforceOutput(
        command.op,
        command.receipt.onReplay(null, ports, prior, head),
        ctx.checkOutputs
      );

    const runInTx = () =>
      ports.tx.transaction((tx) => {
        if (command.receipt && receiptLookup) {
          const prior = receiptPort.read(tx, receiptLookup);
          if (prior !== undefined) {
            const output = enforceOutput(
              command.op,
              command.receipt.onReplay(tx, ports, prior, head),
              ctx.checkOutputs
            );
            const outcome = { replayed: true as const, output };
            assertSyncReturn(ctx.onInTx?.(tx, outcome), 'onInTx');
            return outcome;
          }
        }
        if (preparationFailure) throw preparationFailure.error;
        const guarded = command.guard(tx, ports, head);
        const body = parseInput(ctx.bodySchema ?? command.op.body, bodyRaw);
        const input = { ...head, ...body } as OperationParsedInput<Op>;
        const output = enforceOutput(
          command.op,
          command.apply(tx, ports, input, guarded, prepared),
          ctx.checkOutputs
        );
        if (command.receipt && receiptLookup) {
          receiptPort.save(tx, receiptLookup, command.receipt.serialize(output));
        }
        const outcome = { replayed: false as const, output, input, guarded };
        assertSyncReturn(ctx.onInTx?.(tx, outcome), 'onInTx');
        return outcome;
      });

    const outcome = ctx.aroundTx ? ctx.aroundTx(runInTx) : runInTx();
    if (outcome === EXTERNAL_REPLAY) return undefined as OperationOutput<Op>;

    if (!outcome.replayed && command.afterCommit)
      await command.afterCommit(ports, outcome.output, outcome.input, outcome.guarded, prepared);
    return outcome.output;
  } catch (error) {
    throw asAppError(error);
  }
}
