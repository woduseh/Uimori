import { afterEach, expect, test, vi } from 'vitest';
import { defaultProfile, type Connection, type ModelSnapshot } from '../core/product.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import { createNativeRisuHost } from '../server/risu-native-host.js';
import { executeRisuNative, disposeAllNativeRisuSessions } from '../server/risu-native-runtime.js';
import type { Store } from '../server/store.js';
import { nativeContent } from './fixtures/native-content.js';

afterEach(() => {
  vi.unstubAllGlobals();
  disposeAllNativeRisuSessions();
});

// RisuAI cad8595a scriptings.ts maps sys -> system and bot/char -> assistant
// in both LLMMain and axLLMMain. Capture the serialized HTTP body, after our host adapts it.
test.each(['LLM', 'axLLM'] as const)(
  '%s preserves Risu role aliases, prompt text and order at the provider boundary',
  async (method) => {
    const pkg = nativeContent({
      extensions: {
        risuai: {
          lowLevelAccess: true,
          triggerscript: [
            {
              type: 'start',
              effect: [
                {
                  type: 'triggerlua',
                  code: `function onStart(id)
                    local response = ${method}(id, {
                      {role='sys', content='설정 원문'},
                      {role='user', content='요청 원문'},
                      {role='bot', content='이전 응답'},
                      {role='char', content='추가 응답'},
                      {role='user', content='이어쓰기'}
                    })
                    setChatVar(id, 'answer', response.result)
                  end`,
                },
              ],
            },
          ],
        },
      },
    });
    const connection: Connection = {
      id: 'synthetic-connection',
      revision: 1,
      title: 'Synthetic',
      protocol: 'openai-chat-v1',
      endpoint: 'https://compatible.synthetic.invalid/v1',
      credentialRef: 'UIMORI_SYNTHETIC_SECRET',
      enabled: true,
      catalog: [],
      catalogError: null,
    };
    const model: ModelSnapshot = {
      id: 'synthetic-model',
      revision: 1,
      title: 'Synthetic',
      connectionId: connection.id,
      modelId: 'synthetic-model',
      connection,
      maxOutputTokens: 512,
      temperature: null,
    };
    const snapshot: RunSnapshot = {
      chatId: 'synthetic-chat',
      parentRevision: null,
      settingsRevision: 0,
      settings: { maxCalls: 4 },
      request: 'Continue',
      history: [],
      resources: [],
      profile: {
        ...defaultProfile('synthetic-chat'),
        models: { main: model },
        scriptModel: { ...model, modelId: 'synthetic-script-model' },
        packages: [pkg],
      },
    };
    const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const finishAttempt = vi.fn();
    const store = {
      run: () => ({ status: 'running' }),
      product: {
        authorize: () => connection,
        startAttempt: () => 'synthetic-attempt',
        finishAttempt,
      },
    } as unknown as Store;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          'data: ' +
            JSON.stringify({
              id: 'synthetic-response',
              choices: [
                { index: 0, delta: { role: 'assistant', content: '답변' }, finish_reason: 'stop' },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }
        );
      })
    );
    const result = await executeRisuNative(
      {
        native: pkg.nativeRisu!,
        variables: {},
        messages: [],
        charName: 'Bot',
        userName: 'User',
        event: 'start',
      },
      {
        host: createNativeRisuHost(
          store,
          'synthetic-run',
          snapshot,
          usage,
          {
            resolveCredential: () => 'synthetic-key',
          },
          'start'
        ),
      }
    );
    expect(result.variables.answer).toBe('답변');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.model).toBe(method === 'LLM' ? model.modelId : 'synthetic-script-model');
    const messages = bodies[0]!.messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ role: 'system', content: expect.any(String) });
    expect(messages.slice(1)).toEqual([
      { role: 'system', content: [{ type: 'text', text: '설정 원문' }] },
      { role: 'user', content: [{ type: 'text', text: '요청 원문' }] },
      { role: 'assistant', content: [{ type: 'text', text: '이전 응답' }] },
      { role: 'assistant', content: [{ type: 'text', text: '추가 응답' }] },
      { role: 'user', content: [{ type: 'text', text: '이어쓰기' }] },
    ]);
    expect(usage.modelCalls).toBe(1);
    expect(finishAttempt).toHaveBeenCalledOnce();
  }
);
