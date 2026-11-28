import type { z } from 'zod/v4';
import type {
  OperationHead,
  OperationOutput,
  OperationParsedInput,
  SplitOperation,
} from '#contracts';
import { splitHeadBody } from '#contracts/operations';
import { AppError, asAppError } from './app-errors.js';
import { jsonPayloadHash } from './json-hash.js';
import type { AppPorts, ReceiptAdapter, ReceiptLookup, ReceiptRecord } from './store-ports.js';
import type { SynchronousResult } from './synchronous-transaction.js';
import type { Tx } from './tx.js';

export const NOT_MODIFIED = Symbol('notModified');
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

export function canonicalPayloadHash(value: unknown): string {
  return jsonPayloadHash(stripUndefined(value));
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

export type ReceiptSpec<Op extends SplitOperation<any, any, any, any, any, any>, P> = {
  readonly adapter?: ReceiptAdapter;
  readonly scope?: (head: OperationHead<Op>) => string;
  readonly key: (head: OperationHead<Op>) => string;
  readonly digest?: (head: OperationHead<Op>, raw: Record<string, unknown>) => string;
  readonly conflictMessage?: string;
  readonly serialize?: (output: OperationOutput<Op>) => ReceiptRecord;
  readonly onReplay?: (
    tx: Tx | null,
    ports: P,
    record: ReceiptRecord,
    head: OperationHead<Op>
  ) => SynchronousResult<OperationOutput<Op>>;
};

export type CommandSpec<
  Op extends SplitOperation<any, any, any, any, any, any>,
  P extends Pick<AppPorts, 'tx'>,
  G,
  Prep,
> = {
  readonly receipt?: P extends Pick<AppPorts, 'tx' | 'receipt'> ? ReceiptSpec<Op, P> : never;
  readonly preflight?: (ports: P, head: OperationHead<Op>) => void;
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
    guarded: G
  ) => void | Promise<void>;
};

export type Command<
  Op extends SplitOperation<any, any, any, any, any, any> = SplitOperation<
    any,
    any,
    any,
    any,
    any,
    any
  >,
  P extends Pick<AppPorts, 'tx'> = AppPorts,
> = {
  readonly kind: 'command';
  readonly op: Op;
  readonly receipt?: ReceiptSpec<Op, P>;
  readonly preflight?: (ports: P, head: OperationHead<Op>) => void;
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
    guarded: any
  ) => void | Promise<void>;
};

export type QueryContext = {
  readonly signal?: AbortSignal;
};

export type Query<
  Op extends SplitOperation<any, any, any, any, any, any> = SplitOperation<
    any,
    any,
    any,
    any,
    any,
    any
  >,
  P = AppPorts,
> = {
  readonly kind: 'query';
  readonly op: Op;
  readonly run: (
    ports: P,
    input: OperationParsedInput<Op>,
    ctx: QueryContext
  ) =>
    | OperationOutput<Op>
    | typeof NOT_MODIFIED
    | Promise<OperationOutput<Op> | typeof NOT_MODIFIED>;
};

export function defineCommand<P extends Pick<AppPorts, 'tx'> = Pick<AppPorts, 'tx'>>() {
  return <Op extends SplitOperation<any, any, any, any, any, any>, G = void, Prep = void>(
    op: Op,
    spec: CommandSpec<Op, P, G, Prep>
  ): Command<Op, P> => ({
    kind: 'command',
    op,
    ...(spec.receipt ? { receipt: spec.receipt } : {}),
    ...(spec.preflight ? { preflight: spec.preflight } : {}),
    ...(spec.prepare ? { prepare: spec.prepare } : {}),
    guard: spec.guard,
    apply: spec.apply,
    ...(spec.afterCommit ? { afterCommit: spec.afterCommit } : {}),
  });
}

export function defineQuery<P = AppPorts>() {
  return <Op extends SplitOperation<any, any, any, any, any, any>>(
    op: Op,
    run: Query<Op, P>['run']
  ): Query<Op, P> => ({ kind: 'query', op, run });
}

export type CommandInTxOutcome<Op extends SplitOperation<any, any, any, any, any, any>> =
  | { readonly replayed: true; readonly output: OperationOutput<Op> }
  | {
      readonly replayed: false;
      readonly output: OperationOutput<Op>;
      readonly input: OperationParsedInput<Op>;
    };

export type CommandContext<
  Op extends SplitOperation<any, any, any, any, any, any> = SplitOperation<
    any,
    any,
    any,
    any,
    any,
    any
  >,
> = {
  readonly signal?: AbortSignal;
  readonly checkOutputs?: boolean;
  readonly aroundTx?: <T>(
    run: () => SynchronousResult<T>
  ) => SynchronousResult<T> | typeof EXTERNAL_REPLAY;
  readonly onInTx?: (tx: Tx, outcome: CommandInTxOutcome<Op>) => SynchronousResult<void>;
};

function enforceOutput<Op extends SplitOperation<any, any, any, any, any, any>>(
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

function buildReceiptLookup<Op extends SplitOperation<any, any, any, any, any, any>, P>(
  receipt: ReceiptSpec<Op, P>,
  head: OperationHead<Op>,
  raw: Record<string, unknown>
): ReceiptLookup {
  return {
    adapter: receipt.adapter ?? 'import',
    key: receipt.key(head),
    ...(receipt.scope ? { scope: receipt.scope(head) } : {}),
    digest: receipt.digest ? receipt.digest(head, raw) : canonicalPayloadHash(raw),
    ...(receipt.conflictMessage ? { conflictMessage: receipt.conflictMessage } : {}),
  };
}

function resolveReplay<Op extends SplitOperation<any, any, any, any, any, any>, P>(
  tx: Tx | null,
  receipt: ReceiptSpec<Op, P>,
  ports: P,
  record: ReceiptRecord,
  head: OperationHead<Op>
): OperationOutput<Op> {
  if (receipt.onReplay) return receipt.onReplay(tx, ports, record, head);
  return record.result as OperationOutput<Op>;
}

export async function executeOperation<
  Op extends SplitOperation<any, any, any, any, any, any>,
  P extends Pick<AppPorts, 'tx'>,
>(
  target: Command<Op, P>,
  ports: P,
  rawInput: unknown,
  ctx?: CommandContext<Op>
): Promise<OperationOutput<Op>>;
export async function executeOperation<Op extends SplitOperation<any, any, any, any, any, any>, P>(
  target: Query<Op, P>,
  ports: P,
  rawInput: unknown,
  ctx?: CommandContext<Op>
): Promise<OperationOutput<Op> | typeof NOT_MODIFIED>;
export async function executeOperation<Op extends SplitOperation<any, any, any, any, any, any>, P>(
  target: Command<Op, P & Pick<AppPorts, 'tx'>> | Query<Op, P>,
  ports: P,
  rawInput: unknown,
  ctx: CommandContext<Op> = {}
): Promise<OperationOutput<Op> | typeof NOT_MODIFIED> {
  try {
    if (target.kind === 'query') {
      const input = parseInput(target.op.input, rawInput);
      const output = await target.run(ports, input, { signal: ctx.signal });
      if (output === NOT_MODIFIED) return NOT_MODIFIED;
      return enforceOutput(target.op, output, ctx.checkOutputs);
    }

    const command = target;
    const commandPorts = ports as P & Pick<AppPorts, 'tx'>;
    const raw = plainRecord(rawInput);
    const { headRaw, bodyRaw } = splitHeadBody(command.op.head, raw);
    const head = parseInput(command.op.head, headRaw);
    const receiptLookup = command.receipt
      ? buildReceiptLookup(command.receipt, head, raw)
      : undefined;

    const canFastReplay =
      receiptLookup !== undefined && (!ctx.aroundTx || command.prepare !== undefined);
    if (canFastReplay && command.receipt && receiptLookup) {
      const receiptPorts = commandPorts as P & Pick<AppPorts, 'tx' | 'receipt'>;
      const prior = receiptPorts.receipt.read(null, receiptLookup);
      if (prior !== undefined) {
        const replayed = resolveReplay(null, command.receipt, commandPorts, prior, head);
        return enforceOutput(command.op, replayed, ctx.checkOutputs);
      }
    }

    if (command.preflight) command.preflight(commandPorts, head);
    const prepared = command.prepare
      ? await command.prepare(commandPorts, head, raw, ctx.signal)
      : undefined;

    const runInTx = () =>
      commandPorts.tx.transaction((tx) => {
        if (command.receipt && receiptLookup) {
          const receiptPorts = commandPorts as P & Pick<AppPorts, 'tx' | 'receipt'>;
          const prior = receiptPorts.receipt.read(tx, receiptLookup);
          if (prior !== undefined) {
            const output = resolveReplay(tx, command.receipt, commandPorts, prior, head);
            const outcome = { replayed: true as const, output };
            ctx.onInTx?.(tx, outcome);
            return outcome;
          }
        }
        const guarded = command.guard(tx, commandPorts, head);
        const body = parseInput(command.op.body, bodyRaw);
        const input = { ...head, ...body } as OperationParsedInput<Op>;
        const output = command.apply(tx, commandPorts, input, guarded, prepared);
        if (command.receipt && receiptLookup) {
          const receiptPorts = commandPorts as P & Pick<AppPorts, 'tx' | 'receipt'>;
          const serialized = command.receipt.serialize
            ? command.receipt.serialize(output)
            : { result: output };
          receiptPorts.receipt.save(tx, receiptLookup, serialized);
        }
        const outcome = { replayed: false as const, output, input, guarded };
        ctx.onInTx?.(tx, outcome);
        return outcome;
      });

    const outcome = ctx.aroundTx ? ctx.aroundTx(runInTx) : runInTx();
    if (outcome === EXTERNAL_REPLAY) return undefined as OperationOutput<Op>;

    const verified = enforceOutput(command.op, outcome.output, ctx.checkOutputs);
    if (!outcome.replayed && command.afterCommit)
      await command.afterCommit(commandPorts, verified, outcome.input, outcome.guarded);
    return verified;
  } catch (error) {
    throw asAppError(error);
  }
}
