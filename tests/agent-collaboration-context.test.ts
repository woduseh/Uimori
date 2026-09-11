import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Run } from '../core/types.js';
import type { Json, WireRecord } from '../core/transport.js';
import { OUTLINE_CONTRACT } from '../core/outline.js';
import { Store } from '../server/store.js';
import {
  type Body,
  MAIN_ONLY,
  agent,
  api,
  call,
  collaboration,
  consults,
  fixture,
  message,
  outputs,
  packet,
  send,
  settled,
} from './fixtures/agent-collaboration.js';

const selectedRead = 'SELECTED_MAIN_READ: the copper door is locked.';
const omittedRead = 'UNSELECTED_MAIN_READ: the keeper has a silver key.';
const selectedAdvice = 'SELECTED_A_ADVICE: the keeper could wait; this is proposed fiction.';
const omittedAdvice = 'UNSELECTED_C_ADVICE: an optional alternative for the main writer.';
const automaticDraft = 'UNSHARED_MAIN_PARTIAL_DRAFT: a bell rang.';
const explicitDraft = 'EXPLICIT_UNCOMMITTED_DRAFT: the keeper considers the door.';
const finalText = 'The keeper stopped at the locked copper door.';

test('selected advice, reads and draft cross a context window with frozen outline; other advisors, reads and partial prose stay private', async () => {
  let mainCalls = 0;
  let firstAdvisorCalls = 0;
  const advisorPackets: any[] = [];
  const state = await fixture(
    async (body, target, _number, wire) => {
      if (wire.agentId === 'a') {
        if (++firstAdvisorCalls === 1)
          await send(target, [
            call(body, 'knowledge.read', { id: state.lore.id, limit: 8 }, 'private-A-read'),
          ]);
        else await send(target, [message(selectedAdvice)]);
        return;
      }
      if (wire.agentId === 'c') {
        expect(JSON.stringify(body)).not.toContain(selectedAdvice);
        await send(target, [message(omittedAdvice)]);
        return;
      }
      if (wire.agentId === 'b') {
        const data = packet(body);
        advisorPackets.push(structuredClone(data));
        expect(body.instructions).toContain(OUTLINE_CONTRACT);
        expect(JSON.stringify(body)).not.toContain(MAIN_ONLY);
        expect(JSON.stringify(body)).not.toContain(omittedAdvice);
        expect(JSON.stringify(body)).not.toContain(omittedRead);
        expect(JSON.stringify(body)).not.toContain(automaticDraft);
        expect(JSON.stringify(body)).not.toContain(state.foreign.text);
        if (advisorPackets.length === 1) {
          expect(data.source.consultationContext).toMatchObject({
            hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
            references: [
              {
                callId: '__advisor_before_a',
                name: 'agents.consult',
                kind: 'advice',
                denied: false,
                result: { agentId: 'a', text: selectedAdvice, status: 'completed' },
              },
              {
                callId: 'selected-read',
                name: 'knowledge.read',
                kind: 'read-result',
                denied: false,
                result: { text: selectedRead },
              },
            ],
            draft: { status: 'uncommitted', text: explicitDraft },
          });
          expect(data.source.consultationContext.references).toHaveLength(2);
        } else {
          expect(data.source).not.toHaveProperty('consultationContext');
          expect(JSON.stringify(body)).not.toContain(selectedAdvice);
          expect(JSON.stringify(body)).not.toContain(selectedRead);
          expect(JSON.stringify(body)).not.toContain(explicitDraft);
        }
        await send(target, [message('B_ONLY_PROPOSED_FICTION: the writer can choose an option.')]);
        return;
      }
      switch (++mainCalls) {
        case 1:
          await send(target, [
            message(automaticDraft),
            call(
              body,
              'knowledge.read',
              { id: state.lore.id, limit: selectedRead.length },
              'selected-read'
            ),
            call(
              body,
              'knowledge.read',
              { id: state.lore.id, offset: selectedRead.length + 1 },
              'unselected-read'
            ),
          ]);
          break;
        case 2:
          expect(outputs(body).some((result) => result.text === selectedRead)).toBe(true);
          await send(target, [
            call(
              body,
              'context.new',
              { summary: 'A proposed response is being considered; no new events have occurred.' },
              'main-window-switch'
            ),
          ]);
          break;
        case 3:
          expect(outputs(body)).toEqual(
            expect.arrayContaining([expect.objectContaining({ switched: true })])
          );
          await send(target, [
            call(
              body,
              'agents.consult',
              {
                agentId: 'b',
                question: 'Review this optional response using the chosen evidence.',
                contextRefs: ['__advisor_before_a', 'selected-read'],
                draft: explicitDraft,
              },
              'selected-consult'
            ),
          ]);
          break;
        case 4:
          expect(
            JSON.parse(
              body.input.find(
                (item) =>
                  item.type === 'function_call_output' && item.call_id === 'selected-consult'
              ).output
            )
          ).toMatchObject({ status: 'completed' });
          await send(target, [
            call(
              body,
              'agents.consult',
              {
                agentId: 'b',
                question: 'Do not forward an action receipt.',
                contextRefs: ['main-window-switch'],
              },
              'action-ref'
            ),
            call(
              body,
              'agents.consult',
              { agentId: 'b', question: 'Offer another independent perspective.' },
              'default-consult'
            ),
          ]);
          break;
        default:
          expect(mainCalls).toBe(5);
          expect(outputs(body)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: 'ADVISOR_CONTEXT_UNAVAILABLE' }),
            ])
          );
          await send(target, [message(finalText)]);
      }
    },
    {
      maxCalls: 12,
      contextTools: true,
      loreText: `${selectedRead}\n${omittedRead}`,
      selectedAgents: ['a', 'b', 'c'],
      collaboration: collaboration({
        agents: [
          agent('a', { trigger: 'before' }),
          agent('c', { trigger: 'before', tools: [] }),
          agent('b', { tools: [] }),
        ],
      }),
    }
  );
  state.app.store.outline.apply(
    state.chat.id,
    {
      idempotencyKey: randomUUID(),
      operations: [
        { op: 'create', ref: 'theme', level: 'theme', title: 'Trust', intent: 'Trust is tested.' },
        {
          op: 'create',
          ref: 'story',
          parentRef: 'theme',
          level: 'mainStory',
          title: 'The locked observatory',
          intent: 'A keeper returns to the observatory.',
        },
        {
          op: 'create',
          ref: 'arc',
          parentRef: 'story',
          level: 'arc',
          title: 'A later revelation',
          intent: 'FUTURE_OUTLINE_PLAN: the keeper will discover a betrayal in a later episode.',
        },
        {
          op: 'create',
          ref: 'episode',
          parentRef: 'arc',
          level: 'episode',
          title: 'The closed door',
          intent: 'The current unit ends at the locked door without revealing the betrayal.',
        },
      ],
    },
    'user'
  );
  const episode = state.app.store.outline
    .detail(state.chat.id)
    .nodes.find((node) => node.level === 'episode')!;
  const command = state.app.store.outline.sceneCommand(episode.id, {
    idempotencyKey: randomUUID(),
  });
  const { request: _request, ...reservation } = state.command;
  const started = await api<Run>(state.app, `/api/scene-commands/${command.id}/run`, reservation);
  const run = await settled(state, started.id);
  expect(run.status).toBe('completed');
  expect(run.usage.modelCalls).toBe(10);
  expect(advisorPackets).toHaveLength(2);
  for (const data of advisorPackets) expect(data.source.outline).toEqual(run.snapshot.outline);
  expect(run.snapshot.outline?.path.at(-1)?.id).toBe(episode.id);
  expect(consults(run).find((event) => event.callId === 'action-ref')).toMatchObject({
    denied: true,
    errorKind: 'recoverable',
  });
  const detail = await state.detail();
  expect(detail.sources.map((source) => source.text)).toEqual([finalText]);
  expect(detail.jobs).toEqual([]);
  const restored = new Store(join(state.owner.directory, 'restored-context.sqlite'));
  try {
    restored.product.import(state.app.store.product.export());
    expect(restored.run(run.id).toolEvents).toEqual(run.toolEvents);
    expect(restored.run(run.id).snapshot.outline).toEqual(run.snapshot.outline);
    const restoredAdvisorInputs = restored.product
      .attempts(state.chat.id)
      .map((attempt) => attempt.request as WireRecord)
      .filter((wire) => wire.agentId === 'b')
      .map((wire) => packet(wire.body as unknown as Body));
    expect(restoredAdvisorInputs.map((input) => input.source.consultationContext)).toEqual(
      advisorPackets.map((input) => input.source.consultationContext)
    );
    expect(restored.detail(state.chat.id).sources.map((source) => source.text)).toEqual([
      finalText,
    ]);
  } finally {
    restored.close();
  }
});

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
  const run = await settled(state, (await state.start()).id);
  expect(run.status).toBe('completed');
  expect(run.usage.modelCalls).toBe(7);
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
  const run = await settled(state, (await state.start()).id);
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
  const run = await settled(state, (await state.start()).id);
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
