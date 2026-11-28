import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { AnySplitOperation, OperationBody } from '#contracts';
import { combineStrictObject } from '#contracts/operations';
import type { HelperTask, HelperTaskResult } from '../core/helper.js';
import type { Json, ProviderTool } from '../core/transport.js';
import {
  type Command,
  type CommandInTxOutcome,
  EXTERNAL_REPLAY,
  executeOperation,
} from './command.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { type AppPorts, createStorePorts } from './store-ports.js';
import type { Store } from './store.js';

type ResultTask = Pick<HelperTask, 'id' | 'conversationId'>;
type TaskResultPayload = Omit<HelperTaskResult, 'eventSeq' | 'changedTargets'>;

function helperCommandSchema<
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
  Op extends AnySplitOperation = AnySplitOperation,
  P extends Pick<AppPorts, 'tx'> = AppPorts,
> = {
  readonly tool: ProviderTool;
  readonly command: Command<Op, P>;
  readonly schemaBody: z.ZodType<OperationBody<Op>>;
  readonly omitHeadKeys: readonly string[];
  readonly injectIdempotencyKey?: boolean;
  readonly formatResult: (
    outcome: CommandInTxOutcome<Op>,
    context: HelperCommandFormatContext
  ) => {
    readonly toolOutput: Record<string, unknown>;
    readonly taskResult: TaskResultPayload;
  };
};

export function defineHelperCommandTool<
  Op extends AnySplitOperation,
  P extends Pick<AppPorts, 'tx'>,
  B extends z.ZodObject<z.ZodRawShape> & z.ZodType<OperationBody<Op>>,
>(spec: {
  readonly name: string;
  readonly description: string;
  readonly command: Command<Op, P>;
  readonly schemaBody: B;
  readonly omitHeadKeys: readonly (keyof Op['head']['shape'] & string)[];
  readonly injectIdempotencyKey?: boolean;
  readonly formatResult: HelperCommandTool<Op, P>['formatResult'];
}): HelperCommandTool<Op, P> {
  return {
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: helperCommandSchema(spec.command.op.head, spec.schemaBody, spec.omitHeadKeys),
    },
    command: spec.command,
    schemaBody: spec.schemaBody,
    omitHeadKeys: spec.omitHeadKeys,
    ...(spec.injectIdempotencyKey ? { injectIdempotencyKey: true } : {}),
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
  const operationInput = { name: entry.tool.name, args, chatId };
  const cached = deps.workspace.operationResult<Record<string, unknown>>(
    task.id,
    receiptId,
    operationInput
  );
  if (cached !== undefined) return cached;

  const ports = createStorePorts(deps.store, { publish: deps.chatChanged });
  const rawInput = buildHelperRawInput(
    args,
    chatId,
    receiptId,
    entry.omitHeadKeys,
    entry.injectIdempotencyKey === true
  );
  const formatInTx = (outcome: CommandInTxOutcome<AnySplitOperation>) => {
    const formatted = entry.formatResult(outcome, {
      chatId,
      receiptId,
      chatTitle: deps.store.chat(chatId).title,
    });
    recordHelperTaskResult(deps.workspace, task, formatted.taskResult);
    return formatted.toolOutput;
  };

  let toolOutput: Record<string, unknown> | undefined;
  let resultOutput: Record<string, unknown> | undefined;
  await executeOperation(entry.command, ports, rawInput, {
    signal,
    bodySchema: entry.schemaBody,
    aroundTx: (run) => {
      let ran = false;
      let executed: ReturnType<typeof run> | undefined;
      resultOutput = deps.workspace.operation(task.id, receiptId, operationInput, () => {
        ran = true;
        executed = run();
        return toolOutput!;
      });
      return ran ? executed! : EXTERNAL_REPLAY;
    },
    onInTx: (_tx, outcome) => {
      toolOutput = formatInTx(outcome);
    },
  });
  return resultOutput!;
}
