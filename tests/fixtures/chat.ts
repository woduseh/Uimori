import type { Content } from '../../core/product.js';
import type { Settings } from '../../core/types.js';
import type { Store } from '../../server/store.js';
import type { ContentPackage } from '../../core/content-package.js';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import type { APIRequestContext } from '@playwright/test';

/** Explicit test data; never imported by the product or used to bypass required bot ownership. */
export function fixtureBotInput(title = 'Synthetic fixture owner', body = '') {
  return {
    kind: 'bot' as const,
    title,
    description: 'Synthetic test data',
    text: body,
    loading: 'pinned' as const,
    relatedIds: [],
    package: {
      version: 1 as const,
      id: 'fixture-owner',
      revision: 1,
      title,
      description: 'Synthetic test data',
      body,
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
    } as ContentPackage,
  };
}

/** Existing scenario tests explicitly select synthetic data through this helper. Bot admission negative tests use raw inject. */
export async function injectWithFixtureBot(
  app: Pick<FastifyInstance, 'inject'>,
  options: InjectOptions | string
) {
  if (
    typeof options !== 'string' &&
    String(options.method ?? 'GET').toUpperCase() === 'POST' &&
    options.url === '/api/chats'
  ) {
    let payload = options.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return app.inject(options);
      }
    }
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      !Object.hasOwn(payload, 'botId') &&
      typeof (payload as { title?: unknown }).title === 'string'
    ) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/content',
        headers: options.headers,
        payload: fixtureBotInput(),
      });
      if (created.statusCode !== 200)
        throw new Error(`Fixture bot creation failed: ${created.statusCode} ${created.body}`);
      return app.inject({ ...options, payload: { ...payload, botId: created.json().id } });
    }
  }
  return app.inject(options);
}
/** Browser setup explicitly supplies a synthetic owning package before creating a chat. */
export async function postFixtureChat(
  request: APIRequestContext,
  options: Parameters<APIRequestContext['post']>[1]
) {
  const created = await request.post('/api/content', { data: fixtureBotInput() });
  if (!created.ok())
    throw new Error(`Fixture bot creation failed: ${created.status()} ${await created.text()}`);
  return request.post('/api/chats', {
    ...options,
    data: { ...options?.data, botId: (await created.json()).id },
  });
}
export function createFixtureChat(
  store: Store,
  title: string,
  preset: Settings['preset'] = 'calm',
  organization: { botId?: string; folderId?: string | null } = {}
) {
  const botId = organization.botId ?? (store.product.content(fixtureBotInput()) as Content).id;
  return store.createChat(title, preset, { ...organization, botId });
}
