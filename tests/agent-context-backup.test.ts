import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { Run } from '../core/types.js';
import type { WireRecord } from '../core/transport.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import {
  type Body,
  agent,
  api,
  call,
  collaboration,
  consults,
  fixture,
  message,
  packet,
  send,
  settled,
} from './fixtures/agent-collaboration.js';

test('repeated chat backup restores preserve advisor transmission context and digest while remapping ordinary input history', async () => {
  const firstText = 'The keeper reached the copper observatory.';
  const finalText = 'The keeper waited beside the locked door.';
  const advice = 'UNCOMMITTED_ADVICE: the keeper could check the hinges.';
  const draft = 'UNCOMMITTED_DRAFT: the keeper considers opening the door.';
  let mainCalls = 0;
  const state = await fixture(
    async (body, target, _number, wire) => {
      if (wire.agentId) {
        await send(target, [message(advice)]);
      } else if (++mainCalls === 1) {
        await send(target, [message(firstText)]);
      } else if (mainCalls === 2) {
        await send(target, [
          call(body, 'knowledge.read', { id: state.lore.id }, 'selected-read'),
          call(
            body,
            'agents.consult',
            {
              agentId: 'b',
              question: 'Review the selected evidence and draft.',
              contextRefs: ['__advisor_before_a', 'selected-read'],
              draft,
            },
            'selected-consult'
          ),
        ]);
      } else {
        expect(mainCalls).toBe(3);
        await send(target, [message(finalText)]);
      }
    },
    {
      selectedAgents: ['a', 'b'],
      collaboration: collaboration({
        agents: [agent('a', { trigger: 'before', tools: [] }), agent('b', { tools: [] })],
      }),
    }
  );
  const first = await settled(state, (await state.start()).id);
  expect(first.status).toBe('completed');
  const started = await api<Run>(state.app, `/api/chats/${state.chat.id}/runs`, {
    ...state.command,
    expectedRevision: first.sourceRevision,
    idempotencyKey: randomUUID(),
  });
  const run = await settled(state, started.id);
  expect(run.status).toBe('completed');
  const originalInput = run.inputs.find((input) => input.agentId === 'b')!;
  const originalContext = originalInput.consultationContext!;
  expect(originalContext).toMatchObject({
    references: [
      {
        kind: 'advice',
        result: { source: { chatId: state.chat.id, parentRevision: first.sourceRevision } },
      },
      { kind: 'read-result', callId: 'selected-read' },
    ],
    draft: { status: 'uncommitted', text: draft },
  });
  expect(originalInput.history.map((entry) => entry.revision)).toEqual([first.sourceRevision]);
  const originalConsults = consults(run);
  const originalSnapshot = structuredClone(run.snapshot);
  const attemptsBefore = state.provider.requests.length;
  const backup = exportChatBackup(state.app.store, state.chat.id);
  const serializedBackup = JSON.stringify(backup);
  const copiedChatIds = new Set([state.chat.id]);
  const copiedRunIds = new Set([run.id]);
  const copiedSourceIds = new Set([first.sourceRevision, run.sourceRevision]);
  for (let index = 0; index < 2; index++) {
    const copied = importChatBackup(state.app.store, { backup, idempotencyKey: `copy-${index}` });
    expect(copiedChatIds.has(copied.chat.id)).toBe(false);
    copiedChatIds.add(copied.chat.id);
    const detail = state.app.store.detail(copied.chat.id);
    expect(detail.sources.map((source) => source.text)).toEqual([firstText, finalText]);
    expect(detail.jobs).toEqual([]);
    for (const source of detail.sources) {
      expect(copiedSourceIds.has(source.id)).toBe(false);
      copiedSourceIds.add(source.id);
    }
    const restored = state.app.store.run(state.app.store.source(copied.chat.headRevision!).runId);
    expect(copiedRunIds.has(restored.id)).toBe(false);
    copiedRunIds.add(restored.id);
    expect(restored.status).toBe('completed');
    expect(restored.snapshot.chatId).toBe(copied.chat.id);
    const restoredInput = restored.inputs.find((input) => input.agentId === 'b')!;
    expect(restoredInput.consultationContext).toEqual(originalContext);
    const { hash, ...content } = restoredInput.consultationContext!;
    expect(createHash('sha256').update(JSON.stringify(content)).digest('hex')).toBe(hash);
    expect(restoredInput.history.map((entry) => entry.revision)).toEqual([detail.sources[0].id]);
    expect(restoredInput.history.map((entry) => entry.text)).toEqual([firstText]);
    expect(consults(restored)).toEqual(originalConsults);
    const restoredWire = state.app.store.product
      .attempts(copied.chat.id)
      .map((attempt) => attempt.request as WireRecord)
      .find((wire) => wire.agentId === 'b')!;
    expect(packet(restoredWire.body as unknown as Body).source.consultationContext).toEqual(
      originalContext
    );
    const reexported = exportChatBackup(state.app.store, copied.chat.id);
    const reexportedInput = reexported.records.modelInputs
      .map((row) => row.input as typeof originalInput)
      .find((input) => input.agentId === 'b')!;
    expect(reexportedInput.consultationContext).toEqual(originalContext);
  }
  expect(state.provider.requests).toHaveLength(attemptsBefore);
  expect(state.app.store.run(run.id).snapshot).toEqual(originalSnapshot);
  expect((await state.detail()).sources.map((source) => source.text)).toEqual([
    firstText,
    finalText,
  ]);
  expect(JSON.stringify(backup)).toBe(serializedBackup);
});
