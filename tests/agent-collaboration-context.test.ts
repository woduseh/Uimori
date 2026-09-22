import { expect, test } from 'vitest';
import type { Json } from '../core/transport.js';
import {
  agent,
  call,
  collaboration,
  consults,
  fixture,
  message,
  outputs,
  packet,
  send,
  observedCompletion,
} from './fixtures/agent-collaboration.js';

const _selectedRead = 'SELECTED_MAIN_READ: the copper door is locked.';
const _omittedRead = 'UNSELECTED_MAIN_READ: the keeper has a silver key.';
const selectedAdvice = 'SELECTED_A_ADVICE: the keeper could wait; this is proposed fiction.';
const _omittedAdvice = 'UNSELECTED_C_ADVICE: an optional alternative for the main writer.';
const _automaticDraft = 'UNSHARED_MAIN_PARTIAL_DRAFT: a bell rang.';
const _explicitDraft = 'EXPLICIT_UNCOMMITTED_DRAFT: the keeper considers the door.';
const finalText = 'The keeper stopped at the locked copper door.';

test('identical explicit context caches failures; a changed reference or draft spends the shared advisor budget', async () => {
  let mainCalls = 0;
  const contextHashes: string[] = [];
  const state = await fixture(
    async (body, target, _number, wire) => {
      if (wire.agentId) {
        contextHashes.push(packet(body).source.consultationContext.hash);
        if (contextHashes.length === 1) {
          target.writeHead(503, { 'content-type': 'application/json' });
          target.end('{"error":"synthetic unavailable"}');
        } else await send(target, [message(`Advice for context ${contextHashes.length}.`)]);
        return;
      }
      switch (++mainCalls) {
        case 1:
          await send(target, [
            call(body, 'knowledge.read', { id: state.lore.id, limit: 10 }, 'reference-1'),
            call(body, 'knowledge.read', { id: state.lore.id, offset: 10 }, 'reference-2'),
          ]);
          break;
        case 2:
          await send(target, [
            call(
              body,
              'agents.consult',
              {
                agentId: 'advisor',
                question: 'Review the draft.',
                contextRefs: ['reference-1'],
                draft: 'draft one',
              },
              'failed-context'
            ),
          ]);
          break;
        case 3:
          await send(target, [
            call(
              body,
              'agents.consult',
              {
                agentId: 'advisor',
                question: '  Review the draft.  ',
                contextRefs: ['reference-1'],
                draft: 'draft one',
              },
              'cached-failure'
            ),
            call(
              body,
              'agents.consult',
              {
                agentId: 'advisor',
                question: 'Review the draft.',
                contextRefs: ['reference-2'],
                draft: 'draft one',
              },
              'changed-reference'
            ),
            call(
              body,
              'agents.consult',
              {
                agentId: 'advisor',
                question: 'Review the draft.',
                contextRefs: ['reference-2'],
                draft: 'draft two',
              },
              'changed-draft'
            ),
            call(
              body,
              'agents.consult',
              {
                agentId: 'advisor',
                question: 'Review the draft.',
                contextRefs: ['reference-2'],
                draft: 'draft three',
              },
              'budget-context'
            ),
            call(
              body,
              'agents.consult',
              {
                agentId: 'advisor',
                question: 'Review the draft.',
                contextRefs: ['reference-2'],
                draft: 'draft three',
              },
              'cached-budget'
            ),
          ]);
          break;
        default:
          expect(mainCalls).toBe(4);
          await send(target, [message(finalText)]);
      }
    },
    {
      maxCalls: 10,
      collaboration: collaboration({ maxCalls: 3, agents: [agent('advisor', { maxCalls: 3 })] }),
    }
  );
  const run = await observedCompletion(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(run.usage.modelCalls).toBe(8);
  expect(new Set(contextHashes).size).toBe(3);
  const events = Object.fromEntries(consults(run).map((event) => [event.callId, event.result]));
  expect(events['failed-context']).toMatchObject({
    status: 'unavailable',
    usage: { modelCalls: 1 },
  });
  expect(events['cached-failure']).toMatchObject({ ...events['failed-context'], cached: true });
  for (const id of ['changed-reference', 'changed-draft'])
    expect(events[id]).toMatchObject({ status: 'completed', usage: { modelCalls: 1 } });
  expect(events['budget-context']).toMatchObject({
    status: 'unavailable',
    error: 'ADVISOR_CALL_BUDGET_EXHAUSTED',
    usage: { modelCalls: 0 },
  });
  expect(events['cached-budget']).toMatchObject({ ...events['budget-context'], cached: true });
  expect(state.provider.requests).toHaveLength(7);
});

test('future, missing and private advisor references are recoverable and corrected selection reaches the advisor once', async () => {
  let mainCalls = 0;
  let aCalls = 0;
  let bCalls = 0;
  const invalid: { id: string; args: Json; code: string }[] = [
    { id: 'future', args: { contextRefs: ['future-read'] }, code: 'ADVISOR_CONTEXT_UNAVAILABLE' },
    {
      id: 'foreign',
      args: { contextRefs: ['another-run-read'] },
      code: 'ADVISOR_CONTEXT_UNAVAILABLE',
    },
    {
      id: 'private',
      args: { contextRefs: ['__advisor_before_a:private-read'] },
      code: 'ADVISOR_CONTEXT_UNAVAILABLE',
    },
    {
      id: 'unknown-field',
      args: { context: 'Cannot invent forwarded context.' },
      code: 'INVALID_ADVISOR_REQUEST',
    },
    {
      id: 'too-many',
      args: { contextRefs: Array.from({ length: 9 }, (_, i) => `ref-${i}`) },
      code: 'INVALID_ADVISOR_REQUEST',
    },
  ];
  const state = await fixture(
    async (body, target, _number, wire) => {
      if (wire.agentId === 'a') {
        if (++aCalls === 1)
          await send(target, [call(body, 'knowledge.read', { id: state.lore.id }, 'private-read')]);
        else await send(target, [message(selectedAdvice)]);
        return;
      }
      if (wire.agentId === 'b') {
        bCalls++;
        expect(
          packet(body).source.consultationContext.references.map((event: any) => event.callId)
        ).toEqual(['future-read', 'denied-read']);
        expect(packet(body).source.consultationContext.references[1]).toMatchObject({
          name: 'knowledge.read',
          kind: 'read-result',
          denied: true,
          errorKind: 'recoverable',
          result: { code: 'RESOURCE_UNAVAILABLE' },
        });
        expect(JSON.stringify(body)).not.toContain(selectedAdvice);
        expect(JSON.stringify(body)).not.toContain(state.foreign.text);
        await send(target, [message('One repaired and grounded consultation.')]);
        return;
      }
      if (++mainCalls === 1) {
        await send(target, [
          call(body, 'knowledge.read', { id: state.foreign.id }, 'denied-read'),
          ...invalid.map(({ id, args }) =>
            call(
              body,
              'agents.consult',
              { agentId: 'b', question: 'Review the evidence.', ...(args as Record<string, Json>) },
              id
            )
          ),
          call(body, 'knowledge.read', { id: state.lore.id }, 'future-read'),
        ]);
      } else if (mainCalls === 2) {
        expect(outputs(body)).toEqual(
          expect.arrayContaining(invalid.map(({ code }) => expect.objectContaining({ code })))
        );
        await send(target, [
          call(
            body,
            'agents.consult',
            {
              agentId: 'b',
              question: 'Review the evidence.',
              contextRefs: ['future-read', 'denied-read'],
            },
            'repaired'
          ),
        ]);
      } else {
        expect(mainCalls).toBe(3);
        await send(target, [message(finalText)]);
      }
    },
    {
      maxCalls: 9,
      selectedAgents: ['a', 'b'],
      collaboration: collaboration({
        agents: [agent('a', { trigger: 'before' }), agent('b', { tools: [] })],
      }),
    }
  );
  const run = await observedCompletion(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(bCalls).toBe(1);
  expect(state.provider.requests).toHaveLength(6);
  for (const { id, code } of invalid)
    expect(consults(run).find((event) => event.callId === id)).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { code },
    });
  expect(consults(run).find((event) => event.callId === 'repaired')).toMatchObject({
    denied: false,
    result: { status: 'completed' },
  });
});

test('oversized serialized references and drafts can be corrected without spending an advisor call', async () => {
  let mainCalls = 0;
  let advisorCalls = 0;
  const state = await fixture(
    async (body, target, _number, wire) => {
      if (wire.agentId) {
        advisorCalls++;
        expect(packet(body).source.consultationContext).toMatchObject({
          references: [],
          draft: { status: 'uncommitted', text: 'A short uncommitted draft.' },
        });
        expect(JSON.stringify(body)).not.toContain('OVERSIZE_READ');
        await send(target, [message('A bounded draft review.')]);
        return;
      }
      if (++mainCalls === 1)
        await send(target, [
          call(body, 'knowledge.read', { id: state.lore.id, limit: 16384 }, 'large-1'),
          call(
            body,
            'knowledge.read',
            { id: state.lore.id, offset: 16384, limit: 16384 },
            'large-2'
          ),
        ]);
      else if (mainCalls === 2)
        await send(target, [
          call(
            body,
            'agents.consult',
            { agentId: 'advisor', question: 'Review.', contextRefs: ['large-1', 'large-2'] },
            'large-context'
          ),
          call(
            body,
            'agents.consult',
            { agentId: 'advisor', question: 'Review.', draft: 'x'.repeat(12001) },
            'large-draft'
          ),
        ]);
      else if (mainCalls === 3) {
        const rejected = outputs(body).filter(
          (result) => result.code === 'ADVISOR_CONTEXT_TOO_LARGE'
        );
        expect(rejected).toHaveLength(2);
        await send(target, [
          call(
            body,
            'agents.consult',
            { agentId: 'advisor', question: 'Review.', draft: 'A short uncommitted draft.' },
            'repaired-size'
          ),
        ]);
      } else {
        expect(mainCalls).toBe(4);
        await send(target, [message(finalText)]);
      }
    },
    {
      maxCalls: 8,
      loreText: 'OVERSIZE_READ'.padEnd(40000, 'x'),
      collaboration: collaboration({ agents: [agent('advisor', { tools: [] })] }),
    }
  );
  const run = await observedCompletion(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(advisorCalls).toBe(1);
  expect(state.provider.requests).toHaveLength(5);
  for (const id of ['large-context', 'large-draft'])
    expect(consults(run).find((event) => event.callId === id)).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { code: 'ADVISOR_CONTEXT_TOO_LARGE' },
    });
});

test('cached and forwarded advice retains original identity, read ranges and flat upstream attribution', async () => {
  let mainCalls = 0,
    aCalls = 0;
  const firstQuestion = 'What can the source establish about the keeper?';
  const state = await fixture(
    async (body, target, _number, wire) => {
      if (wire.agentId === 'a') {
        if (++aCalls === 1) {
          await send(target, [
            call(body, 'knowledge.read', { id: state.lore.id, offset: 3, limit: 42 }, 'a-read'),
          ]);
        } else
          await send(target, [
            message('A_INTERPRETATION: the keeper may be hesitant; not established fact.'),
          ]);
        return;
      }
      if (wire.agentId === 'b') {
        const ref = packet(body).source.consultationContext.references[0];
        expect(ref).toMatchObject({
          callId: 'a-cached',
          kind: 'advice',
          result: {
            kind: 'advice',
            agentId: 'a',
            consultationId: 'a-original',
            cached: true,
            evidence: [
              {
                tool: 'knowledge.read',
                args: { id: state.lore.id, offset: 3, limit: 42 },
                source: {
                  id: state.lore.id,
                  revision: state.lore.revision,
                  hash: expect.any(String),
                },
                range: { start: 3, end: 45 },
                truncated: true,
              },
            ],
          },
        });
        await send(target, [
          message('B_INTERPRETATION: A suggested hesitation; this remains uncertain.'),
        ]);
        return;
      }
      if (wire.agentId === 'c') {
        const ref = packet(body).source.consultationContext.references[0];
        expect(ref.result).toMatchObject({
          agentId: 'b',
          consultationId: 'b-original',
          basedOn: [{ agentId: 'a', consultationId: 'a-original' }],
        });
        await send(target, [
          message('C_PROPOSAL: let the keeper pause; no new event has occurred.'),
        ]);
        return;
      }
      switch (++mainCalls) {
        case 1:
          await send(target, [
            call(body, 'agents.consult', { agentId: 'a', question: firstQuestion }, 'a-original'),
          ]);
          break;
        case 2:
          await send(target, [
            call(body, 'agents.consult', { agentId: 'a', question: firstQuestion }, 'a-cached'),
            call(
              body,
              'agents.consult',
              { agentId: 'b', question: 'Assess that interpretation.', contextRefs: ['a-cached'] },
              'b-original'
            ),
          ]);
          break;
        case 3:
          await send(target, [
            call(
              body,
              'agents.consult',
              {
                agentId: 'c',
                question: 'Offer a possibility, not history.',
                contextRefs: ['b-original'],
              },
              'c-original'
            ),
          ]);
          break;
        default:
          expect(mainCalls).toBe(4);
          await send(target, [message(finalText)]);
      }
    },
    {
      maxCalls: 12,
      collaboration: collaboration({
        maxCalls: 6,
        agents: [agent('a', { maxCalls: 2 }), agent('b'), agent('c')],
      }),
    }
  );
  const run = await observedCompletion(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(aCalls).toBe(2); // The repeated question reuses the original opinion, not another model call.
  const results = consults(run).map((event) => event.result);
  expect(results.map((result) => result.consultationId)).toEqual([
    'a-original',
    'a-original',
    'b-original',
    'c-original',
  ]);
  expect(results.at(-1).basedOn).toEqual([
    { agentId: 'b', consultationId: 'b-original' },
    { agentId: 'a', consultationId: 'a-original' },
  ]);
  expect((await state.detail()).sources.map((source) => source.text)).toEqual([finalText]);
});
