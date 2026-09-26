import { fields, number, record, text } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { searchAssets, resolveAsset } from '../core/asset-manifest.js';
import type { RunSnapshot } from '../core/types.js';

export function storyRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: {
    publish: (chatId: string) => void;
    execute: (runId: string) => void;
  }
) {
  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/story',
    async (request) => store.story.detail(request.params.id, request.query.branchId)
  );
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/scene-commands',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      const command = store.story.createCommand(request.params.id, request.body);
      hooks.publish(command.chatId);
      return command;
    }
  );
  app.post<{ Params: { id: string } }>('/api/scene-commands/:id/cancel', async (request) => {
    fields(record(request.body ?? {}), []);
    const command = store.story.cancelCommand(request.params.id);
    hooks.publish(command.chatId);
    return command;
  });
  app.post<{ Params: { id: string } }>('/api/scene-commands/:id/run', async (request) => {
    const body = record(request.body);
    fields(body, [
      'expectedRevision',
      'expectedSettingsRevision',
      'expectedProfileRevision',
      'idempotencyKey',
    ]);
    const scene = store.story.command(request.params.id);
    const command = {
      request: scene.request,
      expectedRevision:
        body.expectedRevision === null ? null : text(body.expectedRevision, 'source', 100),
      expectedSettingsRevision: number(body.expectedSettingsRevision, 'settings revision'),
      idempotencyKey: text(body.idempotencyKey, 'request key', 120),
      branchId: scene.branchId,
      sceneCommandId: scene.id,
      ...(body.expectedProfileRevision === undefined
        ? {}
        : { expectedProfileRevision: number(body.expectedProfileRevision, 'profile revision') }),
    };
    const result = store.createRun(scene.chatId, command, (chat) => {
      const profile = store.product.snapshot(chat.id);
      return {
        chatId: chat.id,
        parentRevision: chat.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: scene.request,
        history: store.history(chat.headRevision),
        resources: store.product.resources(chat.id, profile),
        ...(profile ? { profile } : {}),
      } satisfies RunSnapshot;
    });
    if (result.created) {
      hooks.publish(scene.chatId);
      if (result.run.status === 'queued') hooks.execute(result.run.id);
    }
    return result.run;
  });
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/chats/:id/asset-manifest',
    async (request) => {
      store.chat(request.params.id);
      const query = request.query;
      fields(query, ['query', 'actor', 'outfit', 'location', 'allowedUse', 'offset', 'limit']);
      return searchAssets(store.product.assets(request.params.id), {
        ...query,
        chatId: request.params.id,
        offset: query.offset === undefined ? undefined : Number(query.offset),
        limit: query.limit === undefined ? undefined : Number(query.limit),
      });
    }
  );
  app.post<{ Params: { id: string } }>('/api/chats/:id/asset-manifest/resolve', async (request) => {
    const body = record(request.body);
    fields(body, ['ref', 'use', 'actor', 'outfit', 'location']);
    store.chat(request.params.id);
    return resolveAsset(store.product.assets(request.params.id), {
      ...body,
      chatId: request.params.id,
    } as Parameters<typeof resolveAsset>[1]);
  });
}
