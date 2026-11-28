import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { SplitOperation } from '#contracts';
import { combineStrictObject } from '#contracts/operations';
import type { HelperTask, HelperTaskResult } from '../core/helper.js';
import type { Json, ProviderTool } from '../core/transport.js';
import {
  type Command,
  type CommandInTxOutcome,
  EXTERNAL_REPLAY,
  executeOperation,
} from './command.js';
import { type HelperChangeTarget, withHelperChange } from './helper-changes.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { type AppPorts, createStorePorts } from './store-ports.js';
import type { Store } from './store.js';

type ResultTask = Pick<HelperTask, 'id' | 'conversationId'>;
type TaskResultPayload = Omit<HelperTaskResult, 'eventSeq' | 'changedTargets'>;

export function helperCommandSchema<
  H extends z.ZodObject<z.ZodRawShape>,
  B extends z.ZodObject<z.ZodRawShape>,
>(head: H, body: B, omitHeadKeys: readonly (keyof H['shape'] & string)[]): Json {
  const omitted = Object.fromEntries(omitHeadKeys.map((key) => [key, true])) as Record<
    string,
    true
  >;
  const combined = combineStrictObject(head.omit(omitted) as z.ZodObject<z.ZodRawShape>, body);
  const schema = z.toJSONSchema(combined, { io: 'output' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema as Json;
}

export type HelperCommandFormatContext = {
  readonly chatId: string;
  readonly receiptId: string;
  readonly chatTitle: string;
};

export type HelperCommandTool<
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
  readonly tool: ProviderTool;
  readonly command: Command<Op, P>;
  readonly omitHeadKeys: readonly string[];
  readonly injectIdempotencyKey?: boolean;
  readonly changeTarget?: (
    chatId: string,
    args: Record<string, unknown>
  ) => HelperChangeTarget | undefined;
  readonly formatResult: (
    outcome: CommandInTxOutcome<Op>,
    context: HelperCommandFormatContext
  ) => {
    readonly toolOutput: Record<string, unknown>;
    readonly taskResult: TaskResultPayload;
  };
};

export function defineHelperCommandTool<
  Op extends SplitOperation<any, any, any, any, any, any>,
  P extends Pick<AppPorts, 'tx'>,
  B extends z.ZodObject<z.ZodRawShape>,
>(spec: {
  readonly name: string;
  readonly description: string;
  readonly command: Command<Op, P>;
  readonly schemaBody: B;
  readonly omitHeadKeys: readonly (keyof Op['head']['shape'] & string)[];
  readonly injectIdempotencyKey?: boolean;
  readonly changeTarget?: (
    chatId: string,
    args: Record<string, unknown>
  ) => HelperChangeTarget | undefined;
  readonly formatResult: HelperCommandTool<Op, P>['formatResult'];
}): HelperCommandTool<Op, P> {
  return {
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: helperCommandSchema(spec.command.op.head, spec.schemaBody, spec.omitHeadKeys),
    },
    command: spec.command,
    omitHeadKeys: spec.omitHeadKeys,
    ...(spec.injectIdempotencyKey ? { injectIdempotencyKey: true } : {}),
    ...(spec.changeTarget ? { changeTarget: spec.changeTarget } : {}),
    formatResult: spec.formatResult,
  };
}

function buildHelperRawInput(
  args: Record<string, unknown>,
  chatId: string,
  receiptId: string,
  omitHeadKeys: readonly string[],
  injectIdempotencyKey: boolean
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    const targetKey = omitHeadKeys.includes(key) ? `unexpected:${key}` : key;
    Object.defineProperty(raw, targetKey, {
      value: args[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  raw.chatId = chatId;
  if (injectIdempotencyKey)
    raw.idempotencyKey = `helper:${createHash('sha256').update(receiptId).digest('hex')}`;
  return raw;
}

export async function executeHelperCommand(
  entry: HelperCommandTool,
  deps: {
    readonly store: Store;
    readonly workspace: HelperWorkspace;
    readonly chatChanged?: (chatId: string) => void;
  },
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const ports = createStorePorts(deps.store, { publish: deps.chatChanged });
  const rawInput = buildHelperRawInput(
    args,
    chatId,
    receiptId,
    entry.omitHeadKeys,
    entry.injectIdempotencyKey === true
  );
  let toolOutput: Record<string, unknown> | undefined;
  let resultOutput: Record<string, unknown> | undefined;
  await executeOperation(entry.command, ports, rawInput, {
    signal,
    aroundTx: (run) => {
      let ran = false;
      let executed: ReturnType<typeof run> | undefined;
      resultOutput = deps.workspace.operation(
        task.id,
        receiptId,
        { name: entry.tool.name, args, chatId },
        () => {
          ran = true;
          const apply = () => {
            executed = run();
            return toolOutput!;
          };
          const target = entry.changeTarget?.(chatId, args);
          return target ? withHelperChange(deps.store, task, target, apply) : apply();
        }
      );
      return ran ? executed! : EXTERNAL_REPLAY;
    },
    onInTx: (_tx, outcome) => {
      const formatted = entry.formatResult(outcome, {
        chatId,
        receiptId,
        chatTitle: deps.store.chat(chatId).title,
      });
      recordHelperTaskResult(deps.workspace, task, formatted.taskResult);
      toolOutput = formatted.toolOutput;
    },
  });
  return resultOutput!;
}
