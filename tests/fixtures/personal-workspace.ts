import { expect, type APIRequestContext } from '@playwright/test';
import { postFixtureChat } from './chat.js';
import type { Chat, ChatDetail } from '../../core/types.js';
import type { ChatTranscript } from '../../core/chat-transcript.js';

export async function createReadingChat(request: APIRequestContext, title: string, count = 8) {
  const owner = await postFixtureChat(request, { data: { title: `${title} 자료` } });
  expect(owner.ok()).toBe(true);
  const original = (await owner.json()) as Chat;
  const transcript = (await (
    await request.get(`/api/chats/${original.id}/transcript`)
  ).json()) as ChatTranscript;
  transcript.title = title;
  transcript.entries = Array.from({ length: count }, (_, index) => ({
    request: `검증 장면 ${index + 1}`,
    text: `Scene ${index + 1}. Mira carried a purple umbrella.\n\n${'The quiet river reflected the lanterns.\n\n'.repeat(5)}`,
    translation: `장면 ${index + 1}. 미카는 보라색 우산을 들었다.\n\n${'조용한 강물이 등불을 비추었다.\n\n'.repeat(5)}`,
  }));
  const imported = await request.post('/api/chats/import-transcript', {
    data: { transcript, idempotencyKey: crypto.randomUUID() },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  const chat = (await imported.json()).chat as Chat;
  const detail = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  return { chat, detail };
}
