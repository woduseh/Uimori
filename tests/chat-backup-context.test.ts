import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { ContextPlan } from '../core/context-plan.js';
import type { RunSnapshot } from '../core/types.js';
import { BACKUP_COLLECTIONS, type BackupTables } from '../server/chat-backup-codec.js';
import { remapBackupContext } from '../server/chat-backup-context.js';
import { createBackupRemap } from '../server/chat-backup-remap.js';
import { contextDependencyKey, contextSourceRefs } from '../server/context-planning.js';
import { checkpointHash } from '../server/context-store.js';
import { lineageHash, storyDependencyKey } from '../server/story-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (value: string) => JSON.parse(value);
const blank = (): BackupTables =>
  Object.fromEntries(BACKUP_COLLECTIONS.map(({ table }) => [table, []]));
const plan = (dependencyKey: string): ContextPlan => ({
  version: 1,
  status: 'ready',
  budget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
  dependencyKey,
  estimatedInputTokens: 123,
  compacted: [],
  recentSourceRevisions: [],
  summary: 'source-a is a literal fictional code, not an identity reference.',
  summaryCalls: 1,
  usage: { modelCalls: 1, inputTokens: 100, outputTokens: 20, costUsd: null },
  error: null,
});

function mainFixture() {
  const tables = blank();
  tables.chats.push({ id: 'chat-a' });
  tables.branches.push({ id: 'main:chat-a', chat_id: 'chat-a' });
  tables.sources.push({ id: 'source-a', chat_id: 'chat-a' }, { id: 'source-b', chat_id: 'chat-a' });
  const note = {
    id: 'note-a',
    chatId: 'chat-a',
    atRevision: 'source-a',
    atHash: 'source-hash',
    text: 'source-a',
    kind: 'author-note' as const,
    declaration: { author: 'chat-a', text: 'source-a' },
  };
  const config = {
    revision: 1,
    module: null,
    stateModel: null,
    activatedAt: { revision: 'source-a', hash: 'source-hash' },
  };
  const snapshot: RunSnapshot = {
    chatId: 'chat-a',
    branchId: 'main:chat-a',
    parentRevision: 'source-b',
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 16 },
    request: 'chat-a',
    resources: [],
    history: [
      { revision: 'source-a', text: 'source-b', contentHash: 'source-hash' },
      { revision: 'source-b', text: 'chat-a', contentHash: 'second-hash' },
    ],
    story: {
      config,
      state: {
        id: 'initial:chat-a:1:rebuild:source-hash',
        sourceRevision: 'source-a',
        sourceHash: 'source-hash',
        moduleRevision: 1,
        values: { tag: 'source-a' },
        canonical: true,
      },
      waiting: false,
      lineageHash: '',
      canonHash: hash([note]),
      notes: [note],
      models: {},
    },
  };
  snapshot.story!.lineageHash = lineageHash(snapshot.history);
  snapshot.contextPlan = {
    ...plan(contextDependencyKey(snapshot)),
    compacted: contextSourceRefs(snapshot).slice(0, 1),
    recentSourceRevisions: ['source-b'],
  };
  const scopeKey = 'main:chat-a:main:chat-a';
  const ref = {
    id: 'checkpoint-a',
    revision: 1,
    hash: checkpointHash(scopeKey, 1, snapshot.contextPlan),
  };
  const checkpoint = {
    ...ref,
    scopeKey,
    chatId: 'chat-a',
    plan: structuredClone(snapshot.contextPlan),
  };
  tables.context_checkpoints.push({
    ...ref,
    scope_key: scopeKey,
    chat_id: 'chat-a',
    plan: JSON.stringify(snapshot.contextPlan),
    snapshot: JSON.stringify(snapshot),
  });
  snapshot.contextBase = { scopeKey, activeRevision: 1, notesRevision: 1, checkpoint: ref };
  snapshot.contextPlan.checkpoint = ref;
  tables.runs.push({ id: 'run-a', chat_id: 'chat-a', snapshot: JSON.stringify(snapshot) });
  tables.story_configs.push({ chat_id: 'chat-a', body: JSON.stringify(config) });
  tables.story_states.push({
    id: 'state-a',
    chat_id: 'chat-a',
    parent_state_id: 'initial:chat-a:1:rebuild:source-hash',
    body: JSON.stringify({ ...snapshot.story!.state, id: 'state-a' }),
  });
  tables.author_notes.push({ id: note.id, chat_id: 'chat-a', entry: JSON.stringify(note) });
  tables.author_note_commands.push({
    chat_id: 'chat-a',
    command: JSON.stringify({ expectedHeadRevision: 'source-a', declaration: note.declaration }),
    result: JSON.stringify({ note, revision: 1 }),
  });
  tables.story_jobs.push({
    id: 'story-job-a',
    kind: 'state',
    source_revision: 'source-b',
    source_hash: 'second-hash',
    snapshot: JSON.stringify(snapshot),
    dependency_key: storyDependencyKey('state', { id: 'source-b', hash: 'second-hash' }, snapshot),
    result: JSON.stringify({
      sourceRevision: 'source-b',
      operations: [{ id: 'source-a', field: 'tag', value: 'chat-a', evidence: 'source-b' }],
    }),
  });
  tables.context_jobs.push({
    id: 'context-job-a',
    snapshot: JSON.stringify(snapshot),
    checkpoint: JSON.stringify(ref),
    command: JSON.stringify({ expectedHeadRevision: 'source-b' }),
  });
  tables.context_commands.push({
    command: JSON.stringify({ restoreCheckpoint: ref, expectedHeadRevision: 'source-b' }),
    result: JSON.stringify({
      checkpoint,
      checkpoints: [checkpoint],
      jobs: [{ id: 'context-job-a', checkpoint: ref }],
    }),
  });
  return { tables, snapshot };
}

describe('chat backup state and context identity remapping', () => {
  test('rebuilds every context receipt and state dependency while preserving authored values on repeated imports', () => {
    const { tables, snapshot: original } = mainFixture();
    const before = JSON.stringify(tables);
    const copies = [createBackupRemap(tables), createBackupRemap(tables)];
    for (const ctx of copies) {
      remapBackupContext(ctx);
      const snapshot = parse(ctx.tables.runs[0].snapshot) as RunSnapshot;
      const row = ctx.tables.context_checkpoints[0];
      const checkpointSnapshot = parse(row.snapshot) as RunSnapshot;
      const checkpointPlan = parse(row.plan) as ContextPlan;
      const expectedRef = { id: row.id, revision: 1, hash: row.hash };
      expect(snapshot.chatId).toBe(ctx.chatId);
      expect(snapshot.history.map((entry) => entry.revision)).toEqual([
        ctx.id('source-a'),
        ctx.id('source-b'),
      ]);
      expect(snapshot.story!.lineageHash).not.toBe(original.story!.lineageHash);
      expect(snapshot.story!.lineageHash).toBe(lineageHash(snapshot.history));
      expect(snapshot.story!.canonHash).toBe(hash(snapshot.story!.notes));
      expect(snapshot.story!.canonHash).not.toBe(original.story!.canonHash);
      expect(snapshot.story!.state!.id).toBe(`initial:${ctx.chatId}:1:rebuild:source-hash`);
      expect(snapshot.story!.state!.values).toEqual({ tag: 'source-a' });
      expect(snapshot.story!.config.activatedAt!.revision).toBe(ctx.id('source-a'));
      expect(snapshot.story!.notes[0].declaration).toEqual(original.story!.notes[0].declaration);
      expect(snapshot.request).toBe('chat-a');
      expect(snapshot.history.map((entry) => entry.text)).toEqual(['source-b', 'chat-a']);
      expect(snapshot.contextPlan!.summary).toBe(original.contextPlan!.summary);
      expect(snapshot.contextPlan!.dependencyKey).toBe(contextDependencyKey(snapshot));
      expect(snapshot.contextPlan!.compacted).toEqual(contextSourceRefs(snapshot).slice(0, 1));
      expect(snapshot.contextPlan!.recentSourceRevisions).toEqual([ctx.id('source-b')]);
      expect(row.hash).toBe(checkpointHash(row.scope_key, 1, checkpointPlan));
      expect(checkpointSnapshot.contextPlan).toEqual(checkpointPlan);
      expect(snapshot.contextPlan!.checkpoint).toEqual(expectedRef);
      expect(snapshot.contextBase!.checkpoint).toEqual(expectedRef);
      expect(parse(ctx.tables.context_jobs[0].checkpoint)).toEqual(expectedRef);
      const result = parse(ctx.tables.context_commands[0].result);
      expect(result.checkpoint.hash).toBe(row.hash);
      expect(result.checkpoints[0].plan).toEqual(checkpointPlan);
      expect(result.jobs[0].checkpoint).toEqual(expectedRef);
      expect(parse(ctx.tables.context_commands[0].command).restoreCheckpoint).toEqual(expectedRef);
      expect(parse(ctx.tables.author_note_commands[0].command).expectedHeadRevision).toBe(
        ctx.id('source-a')
      );
      expect(parse(ctx.tables.author_note_commands[0].result).note).toEqual(
        snapshot.story!.notes[0]
      );
      const state = ctx.tables.story_states[0];
      expect(state.parent_state_id).toBe(snapshot.story!.state!.id);
      expect(parse(state.body).id).toBe(state.id);
      const job = ctx.tables.story_jobs[0];
      expect(job.dependency_key).toBe(
        storyDependencyKey(
          'state',
          { id: ctx.id('source-b'), hash: 'second-hash' },
          parse(job.snapshot)
        )
      );
      expect(parse(job.result)).toEqual({
        sourceRevision: ctx.id('source-b'),
        operations: [{ id: 'source-a', field: 'tag', value: 'chat-a', evidence: 'source-b' }],
      });
    }
    expect(copies[0].chatId).not.toBe(copies[1].chatId);
    expect(copies[0].tables.context_checkpoints[0].hash).not.toBe(
      copies[1].tables.context_checkpoints[0].hash
    );
    expect(JSON.stringify(tables)).toBe(before);
  });

  test('rebuilds helper event sequence and hash references from the already remapped event owner', () => {
    const tables = blank();
    tables.chats.push({ id: 'chat-a' });
    tables.helper_conversations.push({ id: 'conversation-a' });
    tables.helper_tasks.push({ id: 'task-a' });
    tables.helper_messages.push({ id: 'message-a' });
    tables.helper_events.push({
      seq: 17,
      task_id: 'task-a',
      kind: 'tool.finished',
      data: JSON.stringify({ name: 'notes.write', result: { sourceRevision: 'chat-a' } }),
    });
    const scopeKey = 'helper:conversation-a';
    const helperPlan = {
      ...plan(scopeKey),
      compacted: [{ revision: 'message-a', hash: hash(['user', 'chat-a']) }],
    };
    tables.context_checkpoints.push({
      id: 'checkpoint-a',
      scope_key: scopeKey,
      revision: 2,
      hash: checkpointHash(scopeKey, 2, helperPlan),
      plan: JSON.stringify(helperPlan),
      snapshot: JSON.stringify({
        kind: 'helper',
        conversationId: 'conversation-a',
        taskId: 'task-a',
        segment: 1,
        messageRefs: helperPlan.compacted,
        eventRefs: [{ seq: 17, hash: 'old-event-hash' }],
        base: { scopeKey, checkpoint: null },
      }),
    });
    const ctx = createBackupRemap(tables, { helper_events: 400 });
    const event = ctx.tables.helper_events[0];
    event.data = JSON.stringify(ctx.structured(parse(event.data)));
    remapBackupContext(ctx);
    const row = ctx.tables.context_checkpoints[0];
    const snapshot = parse(row.snapshot);
    expect(snapshot.messageRefs).toEqual([
      { revision: ctx.id('message-a'), hash: hash(['user', 'chat-a']) },
    ]);
    expect(snapshot.eventRefs).toEqual([{ seq: 401, hash: hash([event.kind, parse(event.data)]) }]);
    expect(snapshot.taskId).toBe(ctx.id('task-a'));
    expect(parse(row.plan).dependencyKey).toBe(row.scope_key);
    expect(row.hash).toBe(checkpointHash(row.scope_key, 2, parse(row.plan)));
    expect(parse(row.plan).summary).toBe(helperPlan.summary);
  });

  test('rejects a checkpoint receipt whose owner is absent instead of dropping it', () => {
    const { tables } = mainFixture();
    tables.context_checkpoints = [];
    expect(() => remapBackupContext(createBackupRemap(tables))).toThrow(
      'BACKUP_CONTEXT_CHECKPOINT_MISSING'
    );
  });
});
