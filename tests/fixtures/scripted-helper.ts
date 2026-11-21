import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import * as transport from '../../core/transport.js';
import {
  HelperRuntime,
  type HelperRequestOptions,
  type HelperServices,
} from '../../server/helper-runtime.js';
import { readHelperTaskResults } from '../../server/helper-task-results.js';
import { modelWorkspace, updateModelWorkspace } from '../../server/prompt-workspace.js';
import { ResponseStreamStore } from '../../server/response-stream.js';
import type { Store } from '../../server/store.js';

export const helperDone: transport.ProviderResult = {
  status: 'completed',
  text: '완료했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};

export const helperCall = (
  id: string,
  name: string,
  args: Record<string, transport.Json>
): transport.ProviderResult => ({
  ...structuredClone(helperDone),
  status: 'tool_calls',
  toolCalls: [{ id, name: 'app.call', arguments: { name, arguments: args } }],
});

export function selectFixtureModels(store: Store) {
  const connection = store.product.connection({
    title: 'Synthetic connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic model',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { main: { id: model.id }, translation: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  return model;
}

export async function runScriptedChatHelper(
  store: Store,
  chatId: string,
  steps: transport.ProviderResult[],
  services: HelperServices = {},
  options: HelperRequestOptions & { request?: string } = {}
) {
  let step = 0;
  const requests: transport.ProviderRequest[] = [];
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (target, request, options) => {
    transport.validateConnection(target);
    options.beforeTurn?.();
    await options.onWire?.({
      connectionId: target.id,
      protocol: target.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'POST',
      url: target.endpoint,
      headers: {},
      body: request as unknown as transport.Json,
      bodySha256: 'synthetic',
      stablePrefixSha256: 'synthetic',
    });
    requests.push(request);
    return structuredClone(steps[step++] ?? helperDone);
  });
  const work: Promise<void>[] = [];
  const runtime = new HelperRuntime(store, {
    owner: 'scripted-helper-test',
    signal: new AbortController().signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
    services,
  });
  const conversation = runtime.workspace.open({ kind: 'chat', chatId });
  const { request = 'Scripted helper request', ...requestOptions } = options;
  const task = runtime.enqueue(
    conversation.id,
    randomUUID(),
    request,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    undefined,
    requestOptions
  );
  await Promise.all(work);
  expect(runtime.workspace.task(task.id).status).toBe('completed');
  const events = runtime.workspace.events(conversation.id);
  const finished = (callId: string) =>
    events.find(
      (event) =>
        event.taskId === task.id &&
        event.kind === 'tool.finished' &&
        (event.data as { callId?: string } | null)?.callId === callId
    )?.data as Record<string, unknown>;
  return {
    finished,
    results: readHelperTaskResults(store, task.id).results,
    requests,
    runtime,
    task: runtime.workspace.task(task.id),
  };
}
