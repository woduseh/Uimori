import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type App } from '../server/app.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import type { Connection, ModelPreset, Content } from '../core/product.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';
import { DEFAULT_JEV_JUDGMENT } from '../core/judgment.js';
import { JEV_ENDPOINT } from '../server/jev-judgment.js';
import { readChatVariables } from '../server/chat-variables.js';
import { validateRunSnapshot } from '../server/snapshot-archive.js';

const owned: { app: App; path: string; close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.app.close();
    await item.close();
    rmSync(item.path, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each([false, true])(
  'server native turn keeps Lua calls, request edits and archive with JEV=%s',
  async (withJev) => {
    let judgments = 0;
    if (withJev) {
      const fallback = globalThis.fetch;
      vi.stubEnv('TYPESAFE_API_KEY', 'test-only-key');
      vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (url !== JEV_ENDPOINT) return fallback(url, init);
        judgments++;
        const body = JSON.parse(String(init?.body));
        expect(body.state.entries).toHaveLength(2);
        return new Response(
          JSON.stringify({
            model: 'jev-latest',
            answers: Object.fromEntries(
              Object.keys(body.questions).map((key) => [key, { type: 'noul', noul: 0.9 }])
            ),
            usage: { input_tokens: 30, output_tokens: 2 },
          })
        );
      });
    }
    const provider = await loopbackProvider(async (request, response) => {
      const body = JSON.parse(request.body);
      await writeSse(response, [
        {
          type: 'text_delta',
          delta: body.modelId === 'auxiliary' ? 'selected' : 'The scene continues.',
        },
        { type: 'usage', inputTokens: 10, outputTokens: 4, costUsd: null },
        { type: 'done', reason: 'stop' },
      ]);
    });
    const path = mkdtempSync(join(tmpdir(), 'uimori-native-app-'));
    const app = await createApp({
      dbPath: join(path, 'test.sqlite'),
      buildId: 'native-app-test',
      approvedOrigins: [provider.origin],
    });
    owned.push({ app, path, close: provider.close });
    await app.ready();
    const connection = app.store.product.connection({
      title: 'Fixture',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as Connection;
    const main = app.store.product.model({
      title: 'Main',
      connectionId: connection.id,
      modelId: 'writer',
      maxOutputTokens: 128,
      temperature: null,
    }) as ModelPreset;
    const aux = app.store.product.model({
      title: 'Script model',
      connectionId: connection.id,
      modelId: 'auxiliary',
      maxOutputTokens: 128,
      temperature: null,
    }) as ModelPreset;
    const workspace = modelWorkspace(app.store);
    updateModelWorkspace(app.store, {
      expectedRevision: workspace.revision,
      routes: { ...workspace.routes, main: { id: main.id } },
      extensionModel: { id: aux.id },
      translationPolicy: workspace.translationPolicy,
    });
    const source = {
      name: 'script.json',
      base64: Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v3',
          data: {
            name: 'Native script',
            description: 'Selection:{{getvar::selection}}',
            first_mes: 'Start',
            ...(withJev
              ? {
                  character_book: {
                    entries: [
                      {
                        id: 0,
                        name: 'Lore',
                        content: 'Selected native lore.',
                        enabled: true,
                        keys: [],
                      },
                    ],
                  },
                }
              : {}),
            extensions: {
              risuai: {
                lowLevelAccess: true,
                triggerscript: [
                  {
                    type: 'start',
                    lowLevelAccess: true,
                    effect: [
                      {
                        type: 'triggerlua',
                        code: `
function onInput(id)
  local answer = axLLM(id, {{role='user',content='Choose a fixture value.'}}):await()
  if not answer.success then error(answer.result) end
  setChatVar(id,'selection',answer.result)
end
listenEdit('editRequest', function(id, messages)
  messages[#messages].content = messages[#messages].content .. ' REQUEST_EDIT'
  return messages
end)
listenEdit('editOutput', function(id,text) return text .. ' OUTPUT_EDIT' end)
function onOutput(id) setChatVar(id,'completed','yes') end
`,
                      },
                    ],
                  },
                ],
              },
            },
          },
        })
      ).toString('base64'),
    };
    const preview = prepareRisuImport({ source });
    expect(preview.findings.some((finding) => finding.code === 'native-model-calls')).toBe(true);
    const imported = applyRisuImport(app.store, {
      source,
      digest: preview.digest,
      memoryIds: [],
      allowPartial: false,
      idempotencyKey: 'native',
    });
    const chat = imported.chat!;
    if (withJev) {
      const module = app.store.product.content({
        kind: 'module',
        title: 'Module',
        description: '',
        text: '',
        loading: 'pinned',
        relatedIds: [],
        package: {
          version: 1,
          id: 'module',
          revision: 1,
          title: 'Module',
          description: '',
          instructions: [],
          controls: [],
          transforms: [],
          loreActivation: { mode: 'model' },
          lore: [
            {
              id: 'lore-0',
              title: 'Lore',
              description: '',
              text: 'Selected module lore.',
              loading: 'discoverable',
            },
          ],
        },
      }) as Content;
      const profile = app.store.product.profile(chat.id);
      app.store.product.updateProfile(chat.id, {
        expectedRevision: profile.revision,
        attachments: profile.attachments,
        image: false,
        packageAttachments: [
          ...profile.packageAttachments!,
          { id: module.id, revision: module.revision, role: 'module' },
        ],
        loreContext: { ...DEFAULT_LORE_CONTEXT, judgment: DEFAULT_JEV_JUDGMENT },
      });
    }
    app.store.settings(chat.id, chat.settingsRevision, {
      ...chat.settings,
      status: false,
      translation: false,
      maxCalls: 4,
    });
    const current = app.store.chat(chat.id);
    const before = readChatVariables(app.store, chat.id, app.store.product.branch(chat.id).id);
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/prompt-preview`,
      payload: { request: 'Preview only' },
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    expect(previewResponse.json().compilation.warnings).toContain(
      'RISU_NATIVE_PREVIEW_CALLBACKS_DEFERRED'
    );
    expect(JSON.stringify(previewResponse.json().compilation.messages)).not.toContain(
      '{{getvar::selection}}'
    );
    expect(provider.requests).toHaveLength(0);
    expect(readChatVariables(app.store, chat.id, app.store.product.branch(chat.id).id)).toEqual(
      before
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/runs`,
      payload: {
        request: 'Continue',
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        expectedProfileRevision: app.store.product.profile(chat.id).revision,
        idempotencyKey: 'turn',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;
    await expect
      .poll(() => app.store.run(id).status, { timeout: 15000, interval: 30 })
      .not.toMatch(/queued|running|waiting_for_state/);
    const run = app.store.run(id);
    expect(run.status, run.error ?? '').toBe('completed');
    expect(run.usage.modelCalls).toBe(withJev ? 3 : 2);
    expect(judgments).toBe(withJev ? 1 : 0);
    expect(provider.requests).toHaveLength(2);
    const sent = provider.requests[1].body;
    expect(sent).toContain('Selection:selected');
    expect(sent).toContain('REQUEST_EDIT');
    if (withJev) {
      expect(sent).toContain('Selected native lore.');
      expect(sent).toContain('Selected module lore.');
    }
    expect(app.store.source(run.sourceRevision!).text).toBe('The scene continues. OUTPUT_EDIT');
    expect(readChatVariables(app.store, chat.id, run.snapshot.branchId!).values).toMatchObject({
      selection: 'selected',
      completed: 'yes',
    });
    validateRunSnapshot(app.store, run.snapshot, id);
    const archive = app.store.product.export();
    expect(archive.tables.attempts).toHaveLength(withJev ? 3 : 2);
  }
);
