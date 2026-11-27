import type { Content } from '../../core/product.js';
import type { Store } from '../../server/store.js';
import { nativeContent } from './native-content.js';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import type { APIRequestContext } from '@playwright/test';
import {
  CHAT_TRANSCRIPT_FORMAT,
  CHAT_TRANSCRIPT_VERSION,
  type ChatTranscript,
} from '../../core/chat-transcript.js';
import type { ChatProfile } from '../../core/product.js';

export function fixtureBotInput(title = 'Synthetic fixture owner', body = '') {
  return {
    kind: 'bot' as const,
    title,
    description: 'Synthetic test data',
    text: body,
    loading: 'pinned' as const,
    relatedIds: [],
    package: nativeContent(
      { name: title, creator_notes: 'Synthetic test data', description: body },
      { id: 'fixture-owner' }
    ),
  };
}

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
export async function fixtureTranscript(
  request: APIRequestContext,
  chat: { id: string; title: string }
): Promise<ChatTranscript> {
  const response = await request.get(`/api/chats/${chat.id}/profile`);
  if (!response.ok()) throw new Error(`Fixture profile read failed: ${await response.text()}`);
  const profile = (await response.json()) as ChatProfile;
  return {
    format: CHAT_TRANSCRIPT_FORMAT,
    version: CHAT_TRANSCRIPT_VERSION,
    exportedAt: new Date().toISOString(),
    title: chat.title,
    packageAttachments: (profile.packageAttachments ?? []).map(({ id, revision, role }) => ({
      id,
      revision,
      role,
    })),
    notes: [],
    entries: [],
  };
}
export function createFixtureChat(
  store: Store,
  title: string,
  organization: { botId?: string; folderId?: string | null } = {}
) {
  const botId = organization.botId ?? (store.product.content(fixtureBotInput()) as Content).id;
  return store.createChat(title, { ...organization, botId });
}

export async function setFixtureModelRoutes(
  app: Pick<FastifyInstance, 'inject'>,
  routes: Record<string, { id: string } | null>
) {
  const headers = { host: '127.0.0.1' };
  const response = await app.inject({ method: 'GET', url: '/api/model-workspace', headers });
  if (response.statusCode !== 200) throw new Error(response.body);
  const current = response.json();
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/model-workspace',
    headers,
    payload: {
      expectedRevision: current.revision,
      routes,
      translationPolicy: current.translationPolicy,
    },
  });
  if (saved.statusCode !== 200) throw new Error(saved.body);
}
