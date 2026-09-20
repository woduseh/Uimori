import { HttpError, fields, record, text } from './request-validation.js';
import { createHash, randomUUID } from 'node:crypto';
import { forkImageInput } from './package-images.js';
import { copyIllustrationsForFork } from './illustrations.js';
import { splitSource } from '../core/auxiliary.js';
import type { Resource, RunSnapshot } from '../core/types.js';
import type { Store, Chat, Source } from './store.js';
import { successfulTranslation, validateTranslationArtifact } from './source-editing.js';
import { mapForkSnapshot, validateRunSnapshot } from './snapshot-archive.js';
import { contextDependencyKey, measureMainContext } from './context-planning.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import { copyStoryFork } from './story-archive.js';
import { copyOutlineFork } from './outline-store.js';
import { copyChatOverridesInTransaction } from './chat-overrides.js';
import { copyChatOptionsInTransaction } from './chat-options.js';
import { copyChatVariableFork } from './chat-variables-archive.js';
import { historicalRunLoreReads } from './lore-context-archive.js';
import type { RetainedLore } from '../core/lore-context.js';
import { isSourceOnlyTranscript } from '../core/authored-history.js';
import { readerRequestOrder } from '../core/reader-conversation.js';

type Row = Record<string, any>;
const json = JSON.stringify;
const parse = (value: string | null): any => (value === null ? null : JSON.parse(value));
const zeroUsage = { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null };
function forkId(chatId: string, key: string) {
  const hash = createHash('sha256')
    .update(json(['chat-fork-v1', chatId, key]))
    .digest('hex')
    .slice(0, 32)
    .split('');
  hash[12] = '5';
  hash[16] = ((parseInt(hash[16], 16) & 3) | 8).toString(16);
  const value = hash.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

/** Copy stored artifacts only. This function never queues jobs or records provider attempts. */
export function forkChat(store: Store, chatId: string, value: unknown): Chat {
  const body = record(value);
  fields(body, ['fromRevision', 'title', 'idempotencyKey']);
  const fromRevision = text(body.fromRevision, 'source revision', 100);
  const key = text(body.idempotencyKey, 'idempotency key', 120);
  const suppliedTitle = body.title === undefined ? null : text(body.title, 'title', 200);
  const id = forkId(chatId, key);
  const branchId = 'main:' + id;
  const command = json({ chatId, fromRevision, title: suppliedTitle });
  return store.transaction(() => {
    const existing = store.db.prepare('SELECT id FROM chats WHERE id=?').get(id);
    if (existing) {
      const event = store.db
        .prepare(
          "SELECT entity_id FROM events WHERE chat_id=? AND kind='chat.forked' ORDER BY seq LIMIT 1"
        )
        .get(id) as Row | undefined;
      if (event?.entity_id !== command)
        throw new HttpError(409, 'Fork idempotency key reused with different selection');
      return store.chat(id);
    }
    const originalChat = store.chat(chatId);
    const selected = store.source(fromRevision);
    if (selected.chatId !== chatId) throw new HttpError(400, 'Source outside chat');
    const ancestors: Source[] = [];
    const seen = new Set<string>();
    let cursor: Source | null = selected;
    while (cursor) {
      if (cursor.chatId !== chatId || seen.has(cursor.id))
        throw new HttpError(400, 'Invalid fork ancestry');
      seen.add(cursor.id);
      ancestors.unshift(cursor);
      cursor = cursor.parentRevision ? store.source(cursor.parentRevision) : null;
    }
    const sourceIds = new Map(ancestors.map((source) => [source.id, randomUUID()]));
    const runIds = new Map(ancestors.map((source) => [source.runId, randomUUID()]));
    const translations = new Map(
      ancestors.map((source) => [source.id, successfulTranslation(store, source)])
    );
    const translationIds = new Map(
      [...translations.values()].filter((job) => job !== null).map((job) => [job.id, randomUUID()])
    );
    const originalRuns = new Map(
      ancestors.map((source) => [source.runId, store.run(source.runId)])
    );
    for (const source of ancestors) {
      const run = originalRuns.get(source.runId)!;
      if (
        run.status !== 'completed' ||
        run.sourceRevision !== source.id ||
        run.chatId !== chatId ||
        run.parentRevision !== source.parentRevision ||
        (!isSourceOnlyTranscript(run.snapshot) &&
          !store.validateHistory(run.snapshot.history, source.parentRevision))
      )
        throw new HttpError(400, 'Invalid completed fork source');
      if (run.snapshot.nativeRisuExecution || run.snapshot.nativeRisuAuthored)
        validateRunSnapshot(store, run.snapshot, run.id);
    }
    const admissionOrder = new Map(
      (
        store.db
          .prepare('SELECT id,rowid AS position FROM runs WHERE chat_id=?')
          .all(chatId) as Row[]
      ).map((row) => [row.id as string, Number(row.position)])
    );
    const orderedRuns = [...originalRuns.values()].sort(
      (a, b) => admissionOrder.get(a.id)! - admissionOrder.get(b.id)!
    );
    const orderingMetadata = new Map(
      (
        store.db
          .prepare(
            "SELECT id,rowid AS admissionOrder,json_extract(command,'$.retryOf') AS retryOf,json_extract(snapshot,'$.forkedFrom.requestOrder') AS forkRequestOrder FROM runs WHERE chat_id=?"
          )
          .all(chatId) as Row[]
      ).map((row) => [
        row.id as string,
        {
          id: String(row.id),
          admissionOrder: Number(row.admissionOrder),
          retryOf: row.retryOf as string | null,
          forkRequestOrder: row.forkRequestOrder as number | null,
        },
      ])
    );
    const logicalOrder = (runId: string) => readerRequestOrder(orderingMetadata, runId);
    // Relative logical ranks survive a portable backup into a database with fresh rowids.
    const logicalOrders = [...new Set(orderedRuns.map((run) => logicalOrder(run.id)))].sort(
      (a, b) => a - b
    );
    const orderRanks = new Map(
      logicalOrders.map((order, index) => [order, index - logicalOrders.length])
    );
    const sourceByRun = new Map(ancestors.map((source) => [source.runId, source]));
    // Preserve proven historical reads; current source/ancestor/canon checks still govern later reuse.
    const originalLoreReads = new Map(
      [...originalRuns].map(([runId, run]) => [
        runId,
        run.sourceRevision ? historicalRunLoreReads(store, run) : [],
      ])
    );
    const loreEntry = (entry: RetainedLore): RetainedLore => {
      const originSource = sourceIds.get(entry.origin.sourceRevision),
        originRun = runIds.get(entry.origin.runId),
        lastUsed = sourceIds.get(entry.lastUsed);
      if (!originSource || !originRun || !lastUsed)
        throw new HttpError(400, 'Invalid fork lore ancestry');
      return {
        ...structuredClone(entry),
        origin: { ...entry.origin, sourceRevision: originSource, runId: originRun },
        lastUsed,
      };
    };
    const loreDependencies = (items: { sourceRevision: string; sourceHash: string }[]) =>
      items.map((item) => {
        const sourceRevision = sourceIds.get(item.sourceRevision);
        if (!sourceRevision) throw new HttpError(400, 'Invalid fork lore dependency');
        return { ...item, sourceRevision };
      });
    const resource = (value: Resource): Resource => ({
      ...structuredClone(value),
      chatId: id,
    });
    const assetIds = new Map(store.product.assets(chatId).map((asset) => [asset.id, randomUUID()]));
    const time = new Date().toISOString();
    let title = suppliedTitle;
    if (title === null) {
      const titles = new Set(store.chats().map((chat) => chat.title));
      for (let number = 1; title === null; number++) {
        const suffix = ' · 포크 ' + number;
        const candidate = originalChat.title.slice(0, 200 - suffix.length) + suffix;
        if (!titles.has(candidate)) title = candidate;
      }
    }
    store.db
      .prepare('INSERT INTO chats VALUES(?,?,NULL,1,?,?)')
      .run(id, title, json(originalChat.settings), time);
    store.organization.copy(chatId, id);
    store.db.prepare('INSERT INTO branches VALUES(?,?,?,NULL,1,1)').run(branchId, id, '기본 분기');
    const profile = store.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chatId) as
      | Row
      | undefined;
    if (profile)
      store.db.prepare('INSERT INTO profiles VALUES(?,?)').run(
        id,
        json({
          ...Object.fromEntries(
            Object.entries(parse(profile.body)).filter(([key]) => key !== 'routes')
          ),
          chatId: id,
          revision: 1,
        })
      );
    for (const [oldId, newId] of assetIds) {
      const { asset, bytes } = store.product.asset(oldId);
      const copied = { ...asset, id: newId, chatId: id, url: '/api/assets/' + newId };
      store.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(newId, id, json(copied), bytes);
    }
    for (const run of orderedRuns) {
      const original = sourceByRun.get(run.id);
      const runId = runIds.get(run.id)!;
      const sourceId = original ? sourceIds.get(original.id)! : null;
      const parentRevision = run.parentRevision ? sourceIds.get(run.parentRevision)! : null;
      const snapshot: RunSnapshot = {
        ...structuredClone(run.snapshot),
        chatId: id,
        parentRevision,
        branchId,
        history: run.snapshot.history.map((item) => ({
          ...item,
          revision: sourceIds.get(item.revision)!,
        })),
        forkedFrom: {
          chatId,
          runId: run.id,
          sourceRevision: original?.id ?? null,
          requestOrder: orderRanks.get(logicalOrder(run.id))!,
        },
      };
      delete snapshot.candidateOf;
      delete snapshot.judgmentRecovery;
      delete snapshot.forkedLoreReads;
      if (snapshot.loreContext)
        snapshot.loreContext = {
          ...snapshot.loreContext,
          dependencies: loreDependencies(snapshot.loreContext.dependencies),
          entries: snapshot.loreContext.entries.map(loreEntry),
        };
      mapForkSnapshot(snapshot, sourceIds, runIds);
      if (snapshot.profile) {
        snapshot.profile.chatId = id;
        snapshot.resources = store.product.resources(id, snapshot.profile);
      } else snapshot.resources = snapshot.resources.map(resource);
      const originalCommand = parse(
        String(store.db.prepare('SELECT command FROM runs WHERE id=?').get(run.id)!.command)
      );
      const retryOf =
        typeof originalCommand.retryOf === 'string'
          ? runIds.get(originalCommand.retryOf)
          : undefined;
      store.db
        .prepare(
          'INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,usage,created_at,updated_at,branch_id,partial_text,error) VALUES(?,?,?,?,?,snapshot_pack(?),?,?,?,?,?,?,?,?,?)'
        )
        .run(
          runId,
          id,
          parentRevision,
          original
            ? 'completed'
            : ['queued', 'running'].includes(run.status)
              ? 'interrupted'
              : run.status,
          run.request,
          json(snapshot),
          'fork:' + run.id,
          json({ forkedFrom: snapshot.forkedFrom, ...(retryOf ? { retryOf } : {}) }),
          sourceId,
          json(zeroUsage),
          run.createdAt,
          run.createdAt,
          branchId,
          original ? null : (run.partialText ?? null),
          original ? null : (run.error ?? null)
        );
      if (!original) continue;
      const baseline = store.sourceOriginal(original.id);
      store.db
        .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)')
        .run(sourceId, id, runId, parentRevision, baseline.text, baseline.hash, baseline.createdAt);
      for (const edit of store.db
        .prepare('SELECT * FROM source_edits WHERE source_id=? ORDER BY revision')
        .all(original.id) as Row[])
        store.db
          .prepare('INSERT INTO source_edits VALUES(?,?,?,?,?)')
          .run(sourceId, edit.revision, edit.text, edit.hash, edit.created_at);
      const copiedSource = store.source(sourceId!);
      const oldBlocks = splitSource(original);
      const newBlocks = splitSource(copiedSource);
      const anchors = new Map(
        oldBlocks.map((block, index) => [block.anchor, newBlocks[index].anchor])
      );
      const translation = translations.get(original.id);
      if (translation?.result?.text) {
        const translated = {
          text: translation.result.text,
          hash: createHash('sha256').update(translation.result.text).digest('hex'),
        };
        const before = splitSource({ ...original, ...translated });
        const after = splitSource({ ...copiedSource, ...translated });
        for (const [index, block] of before.entries())
          anchors.set(block.anchor, after[index].anchor);
      }
      // Rewrite identity fields, never prose, prompt text, protected literals or provider payloads.
      const artifact = (value: unknown, field = ''): any => {
        if (typeof value === 'string') {
          if (field === 'sourceRevision') return sourceIds.get(value) ?? value;
          if (field === 'chatId') return value === chatId ? id : value;
          if (field === 'anchor' || field === 'blockAnchor' || field === 'anchors')
            return anchors.get(value) ?? value;
          if (field === 'assetRef') return assetIds.get(value) ?? value;
          if (field === 'translationJobId') return translationIds.get(value) ?? value;
          return value;
        }
        if (Array.isArray(value)) return value.map((item) => artifact(item, field));
        if (value && typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, artifact(item, name)])
          );
        return value;
      };
      const completed = store.db
        .prepare(
          "SELECT j.*,r.result,r.created_at AS result_created_at FROM jobs j JOIN job_results r ON r.job_id=j.id WHERE j.source_revision=? AND j.status='completed' ORDER BY j.created_at,j.id"
        )
        .all(original.id) as Row[];
      for (const job of completed) {
        if (job.chat_id !== chatId) throw new HttpError(400, 'Invalid completed fork job');
        if (job.source_hash !== original.hash) continue;
        if (job.kind === 'translation') {
          if (successfulTranslation(store, original)?.id !== job.id) continue;
          validateTranslationArtifact(store, store.job(job.id), original);
        }
        const jobId = translationIds.get(job.id) ?? randomUUID();
        const oldInput = parse(job.input);
        if (job.kind === 'image') {
          const target = oldInput?.imageTarget;
          if (
            target?.mode === 'translation' &&
            (target.translationJobId !== translation?.id ||
              target.translationRevision !== translation?.revision)
          )
            continue;
          const latest = store.db
            .prepare(
              "SELECT id FROM jobs WHERE source_revision=? AND kind='image' AND COALESCE(json_extract(input,'$.imageTarget.mode'),'original')=? ORDER BY revision DESC LIMIT 1"
            )
            .get(original.id, target?.mode ?? 'original') as { id: string } | undefined;
          if (latest?.id !== job.id) continue;
        }
        const input =
          job.kind === 'image'
            ? artifact(forkImageInput(oldInput, assetIds))
            : ['translation', 'status'].includes(job.kind) && oldInput
              ? structuredClone(
                  Object.fromEntries(
                    [
                      'translationPrompt',
                      'promptWorkspaceRevision',
                      'translationPolicy',
                      'translationModelSelection',
                      'translationModelSnapshot',
                      'statusModelSelection',
                      'statusModelSnapshot',
                    ]
                      .filter((key) => Object.hasOwn(oldInput, key))
                      .map((key) => [key, oldInput[key]])
                  )
                )
              : null;
        const result = artifact(parse(job.result));
        if (result.sourceRevision !== sourceId || result.sourceHash !== original.hash)
          throw new HttpError(400, 'Invalid completed fork result');
        store.db
          .prepare(
            "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,generation,owner,input,error,created_at,updated_at,revision) VALUES(?,?,?,?,?,'completed',?,NULL,?,NULL,?,?,?)"
          )
          .run(
            jobId,
            id,
            sourceId,
            original.hash,
            job.kind,
            job.generation,
            json(input),
            job.created_at,
            job.updated_at,
            job.revision
          );
        store.db
          .prepare('INSERT INTO job_results VALUES(?,?,?,?)')
          .run(jobId, job.generation, json(result), job.result_created_at);
      }
    }
    copyIllustrationsForFork(
      store,
      id,
      ancestors.map((original) => ({
        oldId: original.id,
        newId: sourceIds.get(original.id)!,
        hash: original.hash,
      }))
    );
    const head = sourceIds.get(fromRevision)!;
    store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(head, id);
    store.db.prepare('UPDATE branches SET head_revision=? WHERE id=?').run(head, branchId);
    copyChatOverridesInTransaction(store, chatId, id, sourceIds);
    copyChatOptionsInTransaction(store, chatId, id, branchId, sourceIds, runIds);
    const storyFork = copyStoryFork(store, chatId, id, sourceIds, runIds);
    copyOutlineFork(
      store,
      chatId,
      originalRuns.get(selected.runId)!.snapshot.branchId ?? `main:${chatId}`,
      id,
      branchId,
      storyFork.commands
    );
    copyChatVariableFork(store, id, branchId, sourceIds, head);
    const canonHashes = new Map<string, string>();
    for (const original of originalRuns.values()) {
      const canon = original.snapshot.loreContext?.canonHash;
      if (!canon) continue;
      const current = store.story.notes.canonHash(
        store.story.notes.scope(chatId, original.parentRevision)
      );
      if (canon === current) {
        const copied = store.run(runIds.get(original.id)!);
        canonHashes.set(
          canon,
          store.story.notes.canonHash(store.story.notes.scope(id, copied.parentRevision))
        );
      }
    }
    const loreCanon = (old: string) =>
      canonHashes.get(old) ??
      createHash('sha256')
        .update(json(['forked-stale-lore-canon-v1', id, old]))
        .digest('hex');
    for (const [oldId, copiedId] of runIds) {
      const copied = store.run(copiedId);
      let snapshot = copied.snapshot;
      if (snapshot.loreContext) {
        snapshot.loreContext = {
          ...snapshot.loreContext,
          canonHash: loreCanon(snapshot.loreContext.canonHash),
        };
        const entries = originalLoreReads.get(oldId)!.map(loreEntry);
        if (entries.length)
          snapshot.forkedLoreReads = {
            version: 1,
            canonHash: snapshot.loreContext.canonHash,
            dependencies: structuredClone(snapshot.loreContext.dependencies),
            entries,
          };
      }
      if (snapshot.contextPlan) snapshot.contextPlan.dependencyKey = contextDependencyKey(snapshot);
      if (!isSourceOnlyTranscript(snapshot) && !snapshot.nativeRisuAuthored)
        snapshot = compileSnapshotPrompt({ ...snapshot, promptCompilation: undefined });
      if (snapshot.contextPlan?.status === 'ready')
        snapshot.contextPlan.estimatedInputTokens =
          measureMainContext(snapshot).estimatedInputTokens;
      store.db
        .prepare('UPDATE runs SET snapshot=snapshot_pack(?) WHERE id=?')
        .run(json(snapshot), copiedId);
    }
    store.context.forkInTransaction(
      chatId,
      id,
      (original) => {
        const sourceId = (old: string | null): string | null => {
          if (old === null) return null;
          const mapped = sourceIds.get(old);
          if (!mapped) throw new Error('Checkpoint outside fork ancestry');
          return mapped;
        };
        let mapped: RunSnapshot = {
          ...structuredClone(original),
          chatId: id,
          branchId,
          parentRevision: sourceId(original.parentRevision),
          history: original.history.map((item) => ({
            ...item,
            revision: sourceId(item.revision)!,
          })),
        };
        delete mapped.candidateOf;
        delete mapped.judgmentRecovery;
        if (original.story) mapped.story = storyFork.mapStory(original.story, original.history);
        if (mapped.profile) {
          mapped.profile.chatId = id;
          mapped.resources = store.product.resources(id, mapped.profile);
        } else mapped.resources = mapped.resources.map(resource);
        if (mapped.loreContext)
          mapped.loreContext = {
            ...mapped.loreContext,
            dependencies: loreDependencies(mapped.loreContext.dependencies),
            entries: mapped.loreContext.entries.map(loreEntry),
            canonHash: loreCanon(mapped.loreContext.canonHash),
          };
        mapForkSnapshot(mapped, sourceIds, runIds);
        if (mapped.contextPlan) mapped.contextPlan.dependencyKey = contextDependencyKey(mapped);
        if (!mapped.nativeRisuAuthored)
          mapped = compileSnapshotPrompt({ ...mapped, promptCompilation: undefined });
        if (mapped.contextPlan?.status === 'ready')
          mapped.contextPlan.estimatedInputTokens = measureMainContext(mapped).estimatedInputTokens;
        return mapped;
      },
      runIds,
      store.context.scope(chatId, originalRuns.get(selected.runId)!.snapshot.branchId).scopeKey
    );
    store.event(id, 'chat.forked', command);
    return store.chat(id);
  });
}
