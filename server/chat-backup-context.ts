import { createHash } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';
import type { StoryConfig, StoryState } from '../core/story.js';
import type { AuthorNote } from '../core/notes.js';
import type { ContextCheckpointRef, ContextPlan } from '../core/context-plan.js';
import type { BackupRemap, BackupRow } from './chat-backup-remap.js';
import { lineageHash, storyDependencyKey } from './story-store.js';
import { contextDependencyKey, contextSourceRefs } from './context-planning.js';
import { checkpointHash } from './context-store.js';

const parse = (value: any): any => (typeof value === 'string' ? JSON.parse(value) : value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Runs after the outer graph and helper domains have mapped their owned identities.
 * Rebuild identity-dependent receipts while preserving authored prose and state values. */
export function remapBackupContext(ctx: BackupRemap): void {
  const { tables, id } = ctx;
  const rows = (table: string): BackupRow[] => tables[table] ?? [];
  const canonHashes = new Map<string, string>();
  const checkpointRefs = new Map<string, ContextCheckpointRef>();
  const checkpointPlans = new Map<string, ContextPlan>();
  const stateId = (value: string | null) => {
    const prefix = `initial:${ctx.oldChatId}:`;
    return value?.startsWith(prefix)
      ? `initial:${ctx.chatId}:${value.slice(prefix.length)}`
      : id(value);
  };
  const config = (value: StoryConfig): StoryConfig => ({
    ...value,
    activatedAt: value.activatedAt
      ? { ...value.activatedAt, revision: id(value.activatedAt.revision) }
      : null,
  });
  const state = (value: StoryState | null): StoryState | null =>
    value
      ? {
          ...value,
          id: stateId(value.id)!,
          sourceRevision: id(value.sourceRevision),
        }
      : null;
  const note = (value: AuthorNote): AuthorNote => ({
    ...value,
    id: id(value.id),
    chatId: id(value.chatId),
    atRevision: id(value.atRevision),
  });
  const command = (value: BackupRow): BackupRow => ({
    ...ctx.structured(value),
    ...(Object.hasOwn(value, 'expectedHeadRevision')
      ? { expectedHeadRevision: id(value.expectedHeadRevision) }
      : {}),
  });
  for (const row of rows('story_configs')) row.body = JSON.stringify(config(parse(row.body)));
  for (const row of rows('story_states')) {
    row.parent_state_id = stateId(row.parent_state_id);
    row.body = JSON.stringify(state(parse(row.body)));
  }
  for (const row of rows('author_notes')) row.entry = JSON.stringify(note(parse(row.entry)));
  for (const row of rows('author_note_commands')) {
    row.command = JSON.stringify(command(parse(row.command)));
    const result = parse(row.result);
    row.result = JSON.stringify({ ...result, note: note(result.note) });
  }

  const snapshots: { row: BackupRow; value: BackupRow }[] = [];
  function prepareSnapshot(value: BackupRow): void {
    // Helper task owners hold their source-time writing snapshot one level below.
    if (value.writing) prepareSnapshot(value.writing);
    if (!Array.isArray(value.history) || typeof value.chatId !== 'string') return;
    const snapshot = value as RunSnapshot;
    snapshot.chatId = id(snapshot.chatId);
    snapshot.parentRevision = id(snapshot.parentRevision);
    if (snapshot.branchId) snapshot.branchId = id(snapshot.branchId);
    snapshot.history = snapshot.history.map((item) => ({ ...item, revision: id(item.revision) }));
    if (snapshot.story) {
      const story = snapshot.story;
      const previous = story.canonHash;
      story.config = config(story.config);
      story.state = state(story.state);
      story.notes = story.notes.map(note);
      story.lineageHash = lineageHash(snapshot.history);
      story.canonHash = hash([...story.notes].sort((a, b) => a.id.localeCompare(b.id)));
      canonHashes.set(previous, story.canonHash);
      if (story.sceneCommandId) story.sceneCommandId = id(story.sceneCommandId);
    }
    if (snapshot.contextBase)
      snapshot.contextBase.scopeKey = ctx.key(snapshot.contextBase.scopeKey);
    if (snapshot.contextPlan) {
      const plan = snapshot.contextPlan;
      plan.dependencyKey = contextDependencyKey(snapshot);
      plan.compacted = contextSourceRefs(snapshot).slice(0, plan.compacted.length);
      plan.recentSourceRevisions = snapshot.history
        .slice(plan.compacted.length)
        .map((item) => item.revision);
    }
  }
  // Each table keeps its own immutable snapshot, including failed and historical jobs.
  for (const list of Object.values(tables))
    for (const row of list) {
      if (typeof row.snapshot !== 'string') continue;
      const value = ctx.structured(parse(row.snapshot));
      prepareSnapshot(value);
      snapshots.push({ row, value });
    }
  // Operation receipts and successful helper tool results retain their own historical jobs.
  // Those embedded snapshots can differ from the job's eventual terminal snapshot.
  const contextResults: { row: BackupRow; column: string; value: BackupRow; result: BackupRow }[] =
    [];
  for (const row of rows('context_commands')) {
    const value = ctx.structured(parse(row.result));
    contextResults.push({ row, column: 'result', value, result: value });
  }
  for (const row of rows('helper_events')) {
    if (row.kind !== 'tool.finished') continue;
    const value = parse(row.data);
    if (
      !value ||
      value.denied ||
      typeof value.name !== 'string' ||
      !value.name.startsWith('context.')
    )
      continue;
    const result = value.result;
    if (result && typeof result === 'object' && !Array.isArray(result))
      contextResults.push({ row, column: 'data', value, result });
  }
  for (const { result } of contextResults) {
    if (result.snapshot) prepareSnapshot(result.snapshot);
    for (const job of result.jobs ?? []) if (job.snapshot) prepareSnapshot(job.snapshot);
  }
  for (const { row, value } of snapshots)
    if (rows('story_jobs').includes(row)) {
      row.dependency_key = storyDependencyKey(
        row.kind,
        { id: row.source_revision, hash: row.source_hash },
        value as RunSnapshot
      );
      if (row.result !== null) {
        const result = parse(row.result);
        // Operation IDs, evidence quotes and proposed field values are model output.
        row.result = JSON.stringify({ ...result, sourceRevision: id(result.sourceRevision) });
      }
    }
  const helperEvents = new Map(rows('helper_events').map((row) => [Number(row.seq), row]));
  for (const helper of [false, true]) {
    // Main context receipts in helper events must settle before helper checkpoint event hashes.
    if (helper)
      for (const { row, column, value, result } of contextResults) {
        finishContextResult(result);
        row[column] = JSON.stringify(value);
      }
    for (const row of rows('context_checkpoints')) {
      const value = snapshots.find((entry) => entry.row === row)!.value;
      if ((value.kind === 'helper') !== helper) continue;
      let plan: ContextPlan;
      if (value.kind === 'helper') {
        plan = ctx.structured(parse(row.plan));
        plan.dependencyKey = row.scope_key;
        value.conversationId = id(value.conversationId);
        value.taskId = id(value.taskId);
        value.messageRefs = plan.compacted;
        value.eventRefs = value.eventRefs.map((event: BackupRow) => {
          const seq = ctx.sequences.helper_events?.get(event.seq) ?? event.seq;
          const source = helperEvents.get(seq);
          if (!source || source.task_id !== value.taskId)
            throw new Error('BACKUP_HELPER_CONTEXT_EVENT_MISSING');
          return { ...event, seq, hash: hash([source.kind, parse(source.data)]) };
        });
      } else {
        if (!value.contextPlan) throw new Error('BACKUP_CONTEXT_PLAN_MISSING');
        plan = { ...value.contextPlan };
        delete plan.checkpoint;
      }
      row.plan = JSON.stringify(plan);
      row.hash = checkpointHash(row.scope_key, Number(row.revision), plan);
      checkpointRefs.set(row.id, { id: row.id, revision: Number(row.revision), hash: row.hash });
      checkpointPlans.set(row.id, plan);
    }
  }
  function checkpoint(value: any): any {
    if (!value) return value;
    const mappedId = id(value.id),
      ref = checkpointRefs.get(mappedId);
    if (!ref) throw new Error('BACKUP_CONTEXT_CHECKPOINT_MISSING');
    return {
      ...ctx.structured(value),
      ...ref,
      ...(value.plan
        ? {
            plan: Object.fromEntries(
              Object.entries(value.plan).map(([name, original]) => [
                name,
                Object.hasOwn(checkpointPlans.get(mappedId)!, name)
                  ? (checkpointPlans.get(mappedId)! as unknown as BackupRow)[name]
                  : original,
              ])
            ),
          }
        : {}),
    };
  }
  function finishSnapshot(value: BackupRow): void {
    if (value.writing) finishSnapshot(value.writing);
    if (value.contextBase?.checkpoint)
      value.contextBase.checkpoint = checkpoint(value.contextBase.checkpoint);
    if (value.contextPlan?.checkpoint)
      value.contextPlan.checkpoint = checkpoint(value.contextPlan.checkpoint);
    if (value.context?.checkpoint) value.context.checkpoint = checkpoint(value.context.checkpoint);
    if (value.kind === 'helper' && value.base?.checkpoint)
      value.base.checkpoint = checkpoint(value.base.checkpoint);
    for (const name of ['loreContext', 'forkedLoreReads']) {
      const context = value[name];
      if (context && canonHashes.has(context.canonHash))
        context.canonHash = canonHashes.get(context.canonHash);
    }
  }
  function finishContextResult(result: BackupRow): void {
    if (result.snapshot) finishSnapshot(result.snapshot);
    if (result.checkpoint) result.checkpoint = checkpoint(result.checkpoint);
    if (result.checkpoints) result.checkpoints = result.checkpoints.map(checkpoint);
    for (const job of result.jobs ?? []) {
      if (job.snapshot) finishSnapshot(job.snapshot);
      if (job.checkpoint) job.checkpoint = checkpoint(job.checkpoint);
    }
  }
  for (const { row, value } of snapshots) {
    finishSnapshot(value);
    row.snapshot = JSON.stringify(value);
  }
  for (const row of rows('context_jobs')) {
    row.command = JSON.stringify(command(parse(row.command)));
    if (row.checkpoint !== null) row.checkpoint = JSON.stringify(checkpoint(parse(row.checkpoint)));
  }
  for (const row of rows('context_commands')) {
    const input = command(parse(row.command));
    if (input.restoreCheckpoint) input.restoreCheckpoint = checkpoint(input.restoreCheckpoint);
    row.command = JSON.stringify(input);
  }
}
