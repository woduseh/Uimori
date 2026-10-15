import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Run } from '../core/types.js';
import {
  MAIN_ONLY,
  api,
  call,
  deferred,
  fixture,
  message,
  observedCompletion,
  outputs,
  packet,
  send,
} from './fixtures/agent-collaboration.js';
import { sse } from './fixtures/loopback-provider.js';

const guideConfig = {
  enabled: true,
  work: 'The Copper Observatory',
  reference: 'The keeper knows the harbor route, but the visitor does not.',
  position: 'Before the visitor learns the keeper is her sister.',
  followCanon: true,
};

test('automatic guide reads frozen evidence and reaches the actual writer HTTP request without becoming story prose', async () => {
  const advice = 'GUIDE_ONLY: Keep the sister relationship undisclosed in the visitor viewpoint.';
  const prose = 'The visitor followed the keeper toward the harbor.';
  const state = await fixture(
    async (body, target, number) => {
      const input = packet(body);
      expect(body.model).toBe(state.mainModel.modelId);
      if (number <= 2) {
        expect(input.controls.purpose).toBe('story-guide');
        expect(input.source.config).toEqual(guideConfig);
        expect(JSON.stringify(body)).not.toContain(MAIN_ONLY);
        expect(JSON.stringify(body)).not.toContain(state.foreign.text);
        if (number === 1) {
          await send(target, [
            call(body, 'knowledge.read', { ids: [state.lore.id] }, 'guide-evidence'),
          ]);
        } else {
          expect(outputs(body)[0]).toMatchObject({
            items: [{ denied: false, read: { text: state.lore.text } }],
          });
          state.app.store.storyGuide.update(state.chat.id, {
            expectedRevision: 1,
            config: { ...guideConfig, position: 'A newer choice for the next scene' },
          });
          await send(target, [message(advice)]);
        }
      } else {
        expect(number).toBe(3);
        expect(JSON.stringify(body)).toContain(MAIN_ONLY);
        expect(input.source.storyGuide).toMatchObject({
          kind: 'derived-story-guide',
          text: advice,
        });
        expect(input.source.storyGuide.guidance).toBeTruthy();
        expect(input.source.notes ?? []).toEqual([]);
        await send(target, [message(prose)]);
      }
    },
    { collaboration: null }
  );
  state.app.store.storyGuide.update(state.chat.id, { expectedRevision: 0, config: guideConfig });

  const run = await observedCompletion(state, (await state.start()).id);

  expect(run.status).toBe('completed');
  expect(run.usage).toEqual({ modelCalls: 4, inputTokens: 28, outputTokens: 12, costUsd: null });
  expect(state.provider.requests).toHaveLength(3);
  expect((await state.detail()).sources.map((source) => source.text)).toEqual([prose]);
  expect(state.app.store.storyGuide.get(state.chat.id).brief).toBeNull();
  const detail = (await state.app.inject(`/api/chats/${state.chat.id}/story-guide`)).json();
  expect(detail).toMatchObject({ revision: 2, latestRun: { used: true } });
  expect(detail.brief).toMatchObject({
    text: advice,
    parentRevision: null,
    configRevision: 1,
    runId: run.id,
    modelTitle: state.mainModel.title,
  });
  expect(state.app.store.run(run.id).snapshot.storyGuideReceipt?.brief?.text).toBe(advice);
});

test('a failed fresh guide continues writing without injecting the previous successful guide', async () => {
  const oldAdvice = 'OLD_GUIDE_ONLY: The visitor may enter the observatory.';
  const partialAdvice = 'INCOMPLETE_GUIDE_ONLY: Reveal the secret';
  let guideCalls = 0;
  let writerCalls = 0;
  const state = await fixture(
    async (body, target) => {
      const input = packet(body);
      if (input.controls.purpose === 'story-guide') {
        guideCalls++;
        expect(JSON.stringify(body)).not.toContain(oldAdvice);
        if (guideCalls === 1) await send(target, [message(oldAdvice)]);
        else {
          expect(guideCalls).toBe(2);
          await send(target, [message(partialAdvice)], 'incomplete');
        }
      } else {
        writerCalls++;
        if (writerCalls === 1) expect(input.source.storyGuide.text).toBe(oldAdvice);
        else {
          expect(writerCalls).toBe(2);
          expect(input.source.storyGuide).toBeUndefined();
          expect(JSON.stringify(body)).not.toContain(oldAdvice);
          expect(JSON.stringify(body)).not.toContain(partialAdvice);
        }
        await send(target, [message(`Only writer scene ${writerCalls}.`)]);
      }
    },
    { collaboration: null }
  );
  state.app.store.storyGuide.update(state.chat.id, { expectedRevision: 0, config: guideConfig });
  const first = await observedCompletion(state, (await state.start()).id);
  expect(first.status).toBe('completed');
  expect(state.app.store.storyGuide.get(state.chat.id).brief?.text).toBe(oldAdvice);

  const current = state.app.store.chat(state.chat.id);
  const next = await api<Run>(state.app, `/api/chats/${state.chat.id}/runs`, {
    ...state.command,
    request: 'Continue after the visitor leaves the harbor.',
    expectedRevision: current.headRevision,
    idempotencyKey: randomUUID(),
  });
  const second = await observedCompletion(state, next.id);

  expect(second.status).toBe('completed');
  expect(second.usage).toEqual({ modelCalls: 3, inputTokens: 21, outputTokens: 9, costUsd: null });
  expect(state.app.store.run(second.id).snapshot.storyGuideReceipt).toMatchObject({
    error: 'STORY_GUIDE_PROVIDER_FAILED',
  });
  expect(state.app.store.run(second.id).snapshot.storyGuideReceipt?.brief).toBeUndefined();
  expect(state.provider.requests).toHaveLength(4);
  expect((await state.detail()).sources.map((source) => source.text).sort()).toEqual([
    'Only writer scene 1.',
    'Only writer scene 2.',
  ]);
});

test('cancelling a guide read continuation closes HTTP and preserves spent usage without starting the writer', async () => {
  const received = deferred();
  const closed = deferred();
  const state = await fixture(
    async (body, target, number) => {
      expect(packet(body).controls.purpose).toBe('story-guide');
      if (number === 1) {
        await send(target, [
          call(body, 'knowledge.read', { ids: [state.lore.id] }, 'guide-read-before-cancel'),
        ]);
      } else {
        expect(number).toBe(2);
        target.once('close', closed.release);
        target.writeHead(200, { 'content-type': 'text/event-stream' });
        target.write(sse({ type: 'response.created', response: { id: 'waiting-guide' } }));
        received.release();
      }
    },
    { collaboration: null }
  );
  state.app.store.storyGuide.update(state.chat.id, { expectedRevision: 0, config: guideConfig });
  const started = await state.start();
  await received.promise;
  await api(state.app, `/api/runs/${started.id}/cancel`, {});
  const run = await observedCompletion(state, started.id);
  await closed.promise;
  await expect
    .poll(
      () =>
        state.app.store.product.attempts(state.chat.id).filter((item) => item.status === 'running')
          .length
    )
    .toBe(0);
  await expect.poll(() => state.app.store.run(started.id).usage.modelCalls).toBe(2);

  expect(run.status).toBe('cancelled');
  expect(state.provider.requests).toHaveLength(2);
  expect((await state.detail()).sources).toEqual([]);
  expect(state.app.store.storyGuide.get(state.chat.id).brief).toBeNull();
  expect(state.app.store.product.attempts(state.chat.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: 'tool_calls',
        inputTokens: 7,
        outputTokens: 3,
        costUsd: null,
      }),
      expect.objectContaining({ status: 'cancelled' }),
    ])
  );
});
