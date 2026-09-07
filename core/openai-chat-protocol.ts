import { OpenAIProtocolError, openAIProtocol, type OpenAITurn } from './openai-protocol.js';
import type { Json, ProviderRequest, ProviderResult, ProviderToolCall } from './transport.js';
export { OpenAIProtocolError as OpenAIChatProtocolError } from './openai-protocol.js';
const {
  object,
  nonempty,
  copy,
  canonical,
  seal,
  prepare,
  toolCall,
  readUsage,
  empty,
  withState,
  diagnostic,
} = openAIProtocol;
function reject(code: string): never {
  throw new OpenAIProtocolError(code);
}

/** OpenAI's Chat Completions shape. Compatible servers choose their own model/capabilities. */
export function encodeChat(request: ProviderRequest): { body: Json; context: OpenAITurn } {
  const prepared = prepare(request, 'openai-chat-turn-v1');
  const { generation, aliases, schema, previous, fresh, plan, bootstrap } = prepared;
  const bootstrapMessages: Json[] = [];
  for (const item of bootstrap as Record<string, Json>[]) {
    bootstrapMessages.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.callId,
            type: 'function',
            function: { name: item.name, arguments: JSON.stringify(item.args) },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: item.callId,
        content: JSON.stringify(item.result),
        name: item.name,
      }
    );
  }
  const messages: Json[] = previous
    ? [
        ...previous.input,
        ...previous.pending.map((call, index) => ({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(fresh[index].result),
        })),
      ]
    : [
        { role: 'system', content: prepared.instructions },
        ...bootstrapMessages,
        ...(plan
          ? structuredClone(plan.messages)
          : [
              {
                role: 'user',
                content: 'Request data (JSON):\n' + JSON.stringify(prepared.wireInput),
              },
            ]),
      ];
  const body: Json = {
    model: request.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...plan?.options,
    ...(generation
      ? {
          max_completion_tokens: generation.maxOutputTokens,
          ...(generation.temperature !== null ? { temperature: generation.temperature } : {}),
          ...(generation.reasoningEffort !== undefined
            ? { reasoning_effort: generation.reasoningEffort }
            : {}),
          ...(generation.serviceTier !== undefined ? { service_tier: generation.serviceTier } : {}),
        }
      : {}),
    ...(aliases.length
      ? {
          tools: request.stable.tools.map((tool, index) => ({
            type: 'function',
            function: {
              name: aliases[index].providerName,
              description: tool.description,
              parameters: copy(tool.inputSchema),
              strict: false,
            },
          })),
          ...(request.toolChoice
            ? {
                tool_choice:
                  request.toolChoice === 'auto'
                    ? 'auto'
                    : {
                        type: 'function',
                        function: {
                          name: aliases.find((alias) => alias.name === request.toolChoice)!
                            .providerName,
                        },
                      },
              }
            : {}),
        }
      : {}),
    ...(schema
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'translation_result', strict: true, schema },
          },
        }
      : {}),
  };
  return {
    body: copy(body, 'INVALID_OPENAI_REQUEST'),
    context: seal({
      version: 'openai-chat-turn-v1',
      modelId: request.modelId,
      bindingHash: prepared.bindingHash,
      phase: 'request',
      input: structuredClone(messages),
      completedResults: prepared.results,
      aliases,
      pending: [],
      usedIds: [...(previous?.usedIds ?? [])],
    }),
  };
}
export const diagnosticChatBody = (body: Json): Json => diagnostic(copy(body));

export class ChatDecoder {
  private readonly context: OpenAITurn;
  private readonly assistant: Record<string, Json> = { role: 'assistant', content: null };
  private readonly calls = new Map<number, Record<string, Json>>();
  private result = empty();
  private completionId: string | undefined;
  private finishReason: string | undefined;
  private done = false;
  constructor(context: OpenAITurn) {
    this.context = structuredClone(context);
  }
  private append(field: string, value: Json | undefined): void {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') reject('INVALID_CHAT_DELTA');
    const previous = this.assistant[field];
    if (previous !== undefined && previous !== null && typeof previous !== 'string')
      reject('INVALID_CHAT_DELTA');
    this.assistant[field] = ((previous as string | null | undefined) ?? '') + value;
  }
  private extra(target: Record<string, Json>, key: string, value: Json): void {
    const previous = target[key];
    // Opaque extension values are preserved without becoming visible prose or tool authority.
    if (previous === undefined || previous === null) target[key] = copy(value);
    else if (
      typeof previous === 'string' &&
      typeof value === 'string' &&
      ['reasoning', 'reasoning_content'].includes(key)
    )
      target[key] = previous + value;
    else if (Array.isArray(previous) && Array.isArray(value))
      target[key] = [...previous, ...(copy(value) as Json[])];
    else if (value !== null && canonical(previous) !== canonical(value))
      reject('CONFLICTING_CHAT_METADATA');
  }
  private addCall(value: Json): void {
    if (
      !object(value) ||
      typeof value.index !== 'number' ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0 ||
      value.index > 1024
    )
      reject('INVALID_TOOL_INDEX');
    let call = this.calls.get(value.index);
    if (!call) {
      call = { type: 'function', function: { arguments: '' } };
      this.calls.set(value.index, call);
    }
    if (value.type !== undefined && value.type !== null && value.type !== 'function')
      reject('UNSUPPORTED_TOOL_TYPE');
    if (value.id !== undefined && value.id !== null) {
      if (!nonempty(value.id) || (call.id !== undefined && call.id !== value.id))
        reject('TOOL_ID_MISMATCH');
      call.id = value.id;
    }
    if (value.function !== undefined && value.function !== null) {
      if (!object(value.function)) reject('INVALID_TOOL_ARGUMENTS');
      const fn = call.function as Record<string, Json>;
      if (value.function.name !== undefined && value.function.name !== null) {
        if (
          !nonempty(value.function.name) ||
          (fn.name !== undefined && fn.name !== value.function.name)
        )
          reject('INVALID_TOOL_NAME');
        fn.name = value.function.name;
      }
      if (value.function.arguments !== undefined && value.function.arguments !== null) {
        if (typeof value.function.arguments !== 'string') reject('INVALID_TOOL_ARGUMENTS');
        fn.arguments = String(fn.arguments) + value.function.arguments;
      }
      for (const [key, item] of Object.entries(value.function))
        if (!['name', 'arguments'].includes(key)) this.extra(fn, key, item);
    }
    for (const [key, item] of Object.entries(value))
      if (!['index', 'id', 'type', 'function'].includes(key)) this.extra(call, key, item);
  }
  private refresh(): void {
    this.result.text = typeof this.assistant.content === 'string' ? this.assistant.content : '';
    this.result.refusal =
      typeof this.assistant.refusal === 'string' && this.assistant.refusal
        ? this.assistant.refusal
        : null;
    if (this.calls.size)
      this.assistant.tool_calls = [...this.calls]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => copy(call));
  }
  private finalize(): void {
    this.refresh();
    if (this.result.refusal || this.finishReason === 'content_filter') {
      this.result.status = 'refused';
      this.result.refusal ??= 'CONTENT_FILTER';
      return;
    }
    if (this.finishReason === 'length') {
      this.result.status = this.result.text || this.calls.size ? 'partial' : 'error';
      this.result.error = { code: 'MAX_OUTPUT_TOKENS' };
      return;
    }
    if (this.finishReason === 'tool_calls') {
      if (!this.calls.size) reject('EMPTY_TOOL_CALLS');
      const ids = new Set<string>();
      const tools: ProviderToolCall[] = [];
      const ordered = [...this.calls].sort(([a], [b]) => a - b);
      ordered.forEach(([index, value], position) => {
        if (index !== position || !object(value.function)) reject('INVALID_TOOL_INDEX');
        const call = toolCall(
          value.id,
          value.function.name,
          value.function.arguments,
          this.context
        );
        if (ids.has(call.id)) reject('DUPLICATE_TOOL_ID');
        ids.add(call.id);
        tools.push(call);
      });
      this.result.toolCalls = tools;
      this.result.status = 'tool_calls';
      return;
    }
    if (this.finishReason !== 'stop') reject('UNSUPPORTED_FINISH_REASON');
    if (this.calls.size) reject('UNEXPECTED_TOOL_CALL');
    if (this.result.text) this.result.status = 'completed';
    else {
      this.result.status = 'error';
      this.result.error = { code: 'EMPTY_RESPONSE' };
    }
  }
  accept(value: unknown): void {
    if (this.done) reject('EVENT_AFTER_TERMINAL');
    if (value === '[DONE]') {
      if (!this.finishReason) reject('MISSING_FINISH_REASON');
      this.done = true;
      return;
    }
    const event = copy(value);
    if (!object(event)) reject('INVALID_CHAT_EVENT');
    if (object(event.error)) {
      this.done = true;
      this.result.status = this.result.text ? 'partial' : 'error';
      this.result.error = { code: 'PROVIDER_ERROR' };
      return;
    }
    if (event.id !== undefined) {
      if (
        !nonempty(event.id) ||
        (this.completionId !== undefined && this.completionId !== event.id)
      )
        reject('RESPONSE_ID_MISMATCH');
      this.completionId = event.id;
    }
    if (event.usage !== undefined && event.usage !== null)
      this.result.usage = readUsage(event.usage, 'prompt_tokens', 'completion_tokens');
    if (!Array.isArray(event.choices)) reject('INVALID_CHAT_EVENT');
    if (!event.choices.length) {
      if (event.usage === undefined || event.usage === null) reject('INVALID_CHAT_EVENT');
      return;
    }
    if (event.choices.length !== 1 || !object(event.choices[0]) || event.choices[0].index !== 0)
      reject('UNSUPPORTED_MULTIPLE_CHOICES');
    if (this.finishReason) reject('EVENT_AFTER_FINISH');
    const choice = event.choices[0];
    if (!object(choice.delta)) reject('INVALID_CHAT_DELTA');
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== null && delta.role !== 'assistant')
      reject('INVALID_CHAT_ROLE');
    if (delta.function_call !== undefined) reject('UNSUPPORTED_LEGACY_FUNCTION_CALL');
    this.append('content', delta.content);
    this.append('refusal', delta.refusal);
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) reject('INVALID_TOOL_CALLS');
      delta.tool_calls.forEach((call) => {
        this.addCall(call);
      });
    }
    for (const [key, item] of Object.entries(delta))
      if (!['role', 'content', 'refusal', 'tool_calls'].includes(key))
        this.extra(this.assistant, key, item);
    this.refresh();
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== 'string') reject('INVALID_FINISH_REASON');
      this.finishReason = choice.finish_reason;
      this.finalize();
    }
  }
  snapshot(): ProviderResult {
    return withState(this.result, this.context, [copy(this.assistant)]);
  }
  finish(): ProviderResult {
    if (!this.done) reject('UNEXPECTED_EOF');
    return this.snapshot();
  }
}
