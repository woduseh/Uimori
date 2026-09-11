import { createHash } from 'node:crypto';
import { sealOutlineSnapshot } from '../core/outline.js';
import { isSourceOnlyTranscript } from '../core/authored-history.js';
import type { RunSnapshot } from '../core/types.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import { measureMainContext } from './context-planning.js';
import { forkImageInput } from './package-images.js';
import type { BackupRemap, BackupRow } from './chat-backup-remap.js';

const parse = (value: string | null) => (value === null ? null : JSON.parse(value));

/** Core/chat/image/outline identities; feature-owned JSON is remapped by its own adapter. */
export function remapBackupRecords(ctx: BackupRemap): void {
  const assetIds = new Map(
    ctx.originalTables.assets.map((row) => [row.id as string, ctx.id(row.id) as string])
  );
  const sourceAnchorPrefixes = new Map(
    ctx.originalTables.sources.map((row) => [
      createHash('sha256').update(row.id).digest('hex').slice(0, 10),
      createHash('sha256').update(ctx.id(row.id)).digest('hex').slice(0, 10),
    ])
  );
  const sourceAnchor = (value: string) =>
    value.replace(/^b-([a-f0-9]{10})-(\d+)-([a-f0-9]{10})$/u, (anchor, prefix, index, hash) => {
      const copied = sourceAnchorPrefixes.get(prefix);
      return copied ? `b-${copied}-${index}-${hash}` : anchor;
    });
  const imageReference = (value: BackupRow) => {
    const ref = assetIds.get(value.ref);
    return ref
      ? { ...value, ref, ...(Object.hasOwn(value, 'url') ? { url: `/api/assets/${ref}` } : {}) }
      : value;
  };
  const jsonFields: Record<string, string[]> = {
    profiles: ['body'],
    runs: ['snapshot', 'command'],
    jobs: ['input'],
    job_results: ['result'],
    assets: ['body'],
    illustration_references: ['body'],
    illustration_jobs: ['input', 'diagnostic'],
    illustration_images: ['body'],
    outline_batches: ['operations', 'created'],
    model_inputs: ['input'],
  };
  for (const [table, fields] of Object.entries(jsonFields))
    for (const row of ctx.tables[table])
      for (const field of fields)
        if (row[field] !== null) row[field] = JSON.stringify(ctx.structured(parse(row[field])));
  for (const row of ctx.tables.runs) {
    const snapshot = parse(row.snapshot);
    if (snapshot.logicalHistory)
      for (const message of snapshot.logicalHistory) message.id = ctx.key(message.id);
    if (snapshot.outline) {
      const { hash: _hash, ...outline } = snapshot.outline;
      snapshot.outline = sealOutlineSnapshot(outline);
    }
    row.snapshot = JSON.stringify(snapshot);
  }
  for (const row of ctx.tables.assets) {
    const body = parse(row.body);
    body.id = row.id;
    body.chatId = row.chat_id;
    body.url = `/api/assets/${row.id}`;
    row.body = JSON.stringify(body);
  }
  for (const row of ctx.tables.jobs) {
    const input = parse(row.input);
    if (!input) continue;
    if (input.imageCatalog) input.imageCatalog = forkImageInput(input, assetIds).imageCatalog;
    if (input.translationImageSelection?.imageCatalog)
      input.translationImageSelection.imageCatalog = forkImageInput(
        input.translationImageSelection,
        assetIds
      ).imageCatalog;
    row.input = JSON.stringify(input);
  }
  for (const row of ctx.tables.illustration_references)
    row.body = JSON.stringify(parse(row.body).map(imageReference));
  for (const row of ctx.tables.job_results) {
    const result = parse(row.result);
    if (Array.isArray(result.annotations))
      result.annotations = result.annotations.map((entry: BackupRow) => ({
        ...entry,
        blockAnchor: sourceAnchor(entry.blockAnchor),
      }));
    if (Array.isArray(result.display))
      result.display = result.display.map((entry: BackupRow) => ({
        ...entry,
        anchor: sourceAnchor(entry.anchor),
      }));
    row.result = JSON.stringify(result);
  }
  for (const row of ctx.tables.illustration_jobs) {
    const input = parse(row.input);
    if (input.codex?.references)
      input.codex.references = input.codex.references.map(imageReference);
    row.input = JSON.stringify(input);
    const diagnostic = parse(row.diagnostic);
    if (diagnostic?.attempts)
      diagnostic.attempts = diagnostic.attempts.map((id: string) => ctx.id(id));
    row.diagnostic = JSON.stringify(diagnostic);
  }
  // Events and raw provider request/response bodies are historical evidence. Only known event
  // identity envelopes are remapped; authored strings and provider payload bytes are unchanged.
  for (const row of ctx.tables.events) {
    if (row.kind === 'chat.backup-imported') row.kind = 'chat.backup-imported.history';
    else if (ctx.ids.has(row.entity_id)) row.entity_id = ctx.id(row.entity_id);
    else if (row.kind === 'chat.forked') {
      try {
        row.entity_id = JSON.stringify(ctx.structured(parse(row.entity_id)));
      } catch {
        /* The original archive validator owns malformed receipts. */
      }
    }
  }
  for (const row of ctx.tables.tool_events) {
    const event = parse(row.event);
    // Host-owned source lookup results and arguments contain typed source IDs. Text is untouched.
    if (/^(story\.|context\.|notes\.|outline\.|chat\.)/u.test(event.name)) {
      event.args = ctx.structured(event.args);
      event.result = ctx.structured(event.result);
    }
    row.event = JSON.stringify(event);
  }
}

/** Rebuild only derived request projections after source/notes/summary identities are settled. */
export function finishBackupSnapshots(ctx: BackupRemap): void {
  const finish = (value: BackupRow) => {
    if (value.writing) finish(value.writing);
    if (!Array.isArray(value.history) || typeof value.chatId !== 'string') return;
    const snapshot = value as RunSnapshot;
    if (snapshot.logicalHistory)
      for (const message of snapshot.logicalHistory) message.id = ctx.key(message.id);
    if (snapshot.outline) {
      const { hash: _hash, ...outline } = snapshot.outline;
      snapshot.outline = sealOutlineSnapshot(ctx.structured(outline));
    }
    if (isSourceOnlyTranscript(snapshot)) return;
    if (snapshot.promptCompilation) {
      const compiled = compileSnapshotPrompt({ ...snapshot, promptCompilation: undefined });
      snapshot.promptCompilation = compiled.promptCompilation;
    }
    if (snapshot.contextPlan?.status === 'ready')
      snapshot.contextPlan.estimatedInputTokens = measureMainContext(snapshot).estimatedInputTokens;
  };
  for (const rows of Object.values(ctx.tables))
    for (const row of rows)
      if (typeof row.snapshot === 'string') {
        const snapshot = parse(row.snapshot);
        finish(snapshot);
        row.snapshot = JSON.stringify(snapshot);
      }
  const finishResult = (result: BackupRow) => {
    if (result.snapshot) finish(result.snapshot);
    for (const job of result.jobs ?? []) if (job.snapshot) finish(job.snapshot);
  };
  for (const row of ctx.tables.context_commands) {
    const result = parse(row.result);
    finishResult(result);
    row.result = JSON.stringify(result);
  }
  for (const row of ctx.tables.helper_events) {
    if (row.kind !== 'tool.finished') continue;
    const event = parse(row.data);
    if (
      event &&
      !event.denied &&
      typeof event.name === 'string' &&
      event.name.startsWith('context.') &&
      event.result &&
      typeof event.result === 'object'
    ) {
      finishResult(event.result);
      row.data = JSON.stringify(event);
    }
  }
  // A context tool result can own a recompiled writing snapshot. Sign its final event bytes.
  const events = new Map(ctx.tables.helper_events.map((row) => [Number(row.seq), row]));
  for (const row of ctx.tables.context_checkpoints) {
    const snapshot = parse(row.snapshot);
    if (snapshot.kind !== 'helper') continue;
    snapshot.eventRefs = snapshot.eventRefs.map((ref: BackupRow) => {
      const event = events.get(Number(ref.seq));
      if (!event || event.task_id !== snapshot.taskId)
        throw new Error('BACKUP_HELPER_CONTEXT_EVENT_MISSING');
      return {
        ...ref,
        hash: createHash('sha256')
          .update(JSON.stringify([event.kind, parse(event.data)]))
          .digest('hex'),
      };
    });
    row.snapshot = JSON.stringify(snapshot);
  }
}
