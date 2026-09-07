import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { parseSourceSegments } from '../core/source-segments.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import {
  createTranslationPlan,
  validateTranslationChunk,
  aggregateTranslation,
} from '../core/auxiliary.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import { validateTranslationArtifact } from '../server/source-editing.js';
import { buildMainInput } from '../core/provider.js';
import { executeStoryRead } from '../core/story-context.js';
import type { RunSnapshot } from '../core/types.js';

const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});
function database() {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), 'Uimori hidden fork synthetic ')), 'test.sqlite')
  );
  stores.push(store);
  return store;
}
const hiddenText =
  'MAIN_VISIBLE_BEFORE.\n\n@hsTitle: Synthetic secret\n⟦Library @ Morning @ Companion⟧\n\nHIDDEN_EVIDENCE_SENTINEL stays in a sealed notebook.\n@hs\n\nMAIN_VISIBLE_AFTER.\n\n<EvaluationReport><RevisionReport>[88]<DevelopmentReport>EVALUATION_SENTINEL.</EvaluationReport>';
function fixture(memory = true) {
  const store = database(),
    input = fixtureBotInput('Segment fixture');
  input.package!.controls = [
    { id: 'exclude-asides', label: 'Exclude asides', type: 'boolean', default: false },
    { id: 'exclude-annotations', label: 'Exclude annotations', type: 'boolean', default: false },
  ];
  input.package!.sourceSegments = createSourceSegmentFixture({ excludeAnnotations: false });
  input.package!.sourceSegments.rules[0].excludeWhen = { control: 'exclude-asides' };
  input.package!.sourceSegments.rules[1].excludeWhen = { control: 'exclude-annotations' };
  const bot = store.product.content(input);
  const chat = createFixtureChat(store, 'Segment fixture', 'calm', { botId: bot.id });
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
  });
  const branchId = `main:${chat.id}`,
    packageKey = `${bot.id}@${bot.revision}:bot`;
  const preset = store.product.promptPreset({
    title: 'Synthetic memory-slot program',
    role: 'main',
    text: '',
    program: {
      version: 1,
      controls: [],
      blocks: [
        {
          id: 'host',
          title: 'Host',
          kind: 'message',
          role: 'system',
          template: [{ kind: 'text', text: 'Keep exact provenance.' }],
        },
        { id: 'memory-slot', title: 'Memory', kind: 'slot', role: 'system', slot: 'memory' },
        { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
      ],
    },
  });
  const prior = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: prior.revision,
    attachments: prior.attachments,
    personaReference: prior.personaReference,
    routes: prior.routes,
    image: false,
    prompts: { main: { id: preset.id, revision: preset.revision } },
  });
  const state = store.story.configForBranch(chat.id, branchId);
  store.story.saveConfig(chat.id, {
    branchId,
    expectedRevision: state.revision,
    module: state.module,
    stateModel: null,
    memory: { enabled: memory, model: null, recentCount: 1, maxPacketChars: 60000 },
  });
  return { store, chatId: chat.id, branchId, packageKey };
}
function queued(f: ReturnType<typeof fixture>, request = 'Continue synthetic story') {
  const chat = f.store.chat(f.chatId),
    branch = f.store.product.branch(f.chatId, f.branchId);
  return f.store.createRun(
    f.chatId,
    {
      branchId: f.branchId,
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => {
      const profile = f.store.product.snapshot(f.chatId)!;
      return {
        chatId: f.chatId,
        parentRevision: selected.headRevision,
        settingsRevision: selected.settingsRevision,
        settings: selected.settings,
        request,
        history: f.store.history(selected.headRevision),
        resources: f.store.product.resources(f.chatId, profile),
        profile,
      } satisfies RunSnapshot;
    }
  ).run;
}
function source(f: ReturnType<typeof fixture>, text = hiddenText) {
  const run = queued(f);
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}
function remember(
  f: ReturnType<typeof fixture>,
  s: ReturnType<typeof source>,
  quote = 'HIDDEN_EVIDENCE_SENTINEL stays in a sealed notebook.'
) {
  const job = f.store.story
    .detail(f.chatId)
    .jobs.find((j) => j.kind === 'memory' && j.sourceRevision === s.id)!;
  const claim = f.store.story.claim(job.id, 'synthetic-memory')!;
  expect(claim).not.toBeNull();
  const start = s.text.indexOf(quote);
  const entry = {
    id: 'discard-provider-id',
    chatId: f.chatId,
    kind: 'observed-story',
    atRevision: s.id,
    atHash: s.hash,
    text: quote,
    sources: [{ revision: s.id, hash: s.hash, start, end: start + quote.length, quote }],
  };
  const finished = f.store.story.finish(job.id, claim.generation, 'synthetic-memory', {
    status: 'completed',
    result: { entries: [entry] },
    error: null,
    mock: true,
  });
  expect(finished.status).toBe('completed');
  return (finished.result as { entries: any[] }).entries[0];
}
function translate(f: ReturnType<typeof fixture>, s: ReturnType<typeof source>) {
  const job = f.store.requestTranslation(s.id);
  const snapshot = f.store.product.resolveJobPrompt(f.store.run(s.runId).snapshot, job.input);
  const plan = createTranslationPlan(s, sourceTimeContext(snapshot, 'translation'));
  const claim = f.store.claimJob(job.id, 'synthetic-translation', {}, plan)!;
  const results = plan.chunks.map((chunk) =>
    validateTranslationChunk(plan, chunk.id, {
      sourceRevision: s.id,
      sourceHash: s.hash,
      chunkId: chunk.id,
      segments: chunk.blocks.map((block) => ({ anchors: [block.anchor], text: block.text })),
    })
  );
  for (const result of results)
    f.store.product.chunk(job.id, result.chunkId, 'completed', {}, result);
  const aggregate = aggregateTranslation(plan, results);
  expect(
    f.store.completeJob(job.id, claim.generation, 'synthetic-translation', {
      mock: true,
      sourceRevision: s.id,
      sourceHash: s.hash,
      segments: aggregate.segments,
      text: aggregate.segments.map((s) => s.text).join('\n\n'),
      completedChunks: aggregate.completedChunks,
      totalChunks: aggregate.totalChunks,
    })
  ).toBe(true);
  validateTranslationArtifact(f.store, f.store.job(job.id), s);
  return f.store.job(job.id);
}

describe('Source segment memory, translation and fork provenance (synthetic only)', () => {
  test('completed hidden-memory fork remaps segment source identities and compiled memory slot provenance', () => {
    const f = fixture();
    const first = source(f);
    const memory = remember(f, first);
    expect(memory.knowledge.segments[0].sourceRevision).toBe(first.id);
    source(f, 'A second visible scene.');
    const third = source(f, 'A third visible scene.');
    const originalRun = f.store.run(third.runId);
    const originalSource = f.store.source(first.id);
    const before = originalRun.snapshot;
    expect(JSON.stringify(before.promptCompilation)).toContain('HIDDEN_EVIDENCE_SENTINEL');
    const fork = forkChat(f.store, f.chatId, {
      fromRevision: third.id,
      idempotencyKey: 'hidden-memory-fork',
    });
    const copied = f.store.run(f.store.source(fork.headRevision!).runId).snapshot;
    const copiedFirst = f.store.history(fork.headRevision!)[0];
    const entry = f.store.story.memory
      .entries(f.store.story.memory.scope(fork.id, fork.headRevision!))
      .find((e) => e.text.includes('HIDDEN_EVIDENCE_SENTINEL'))!;
    const copiedRows = f.store.db
      .prepare('SELECT entry FROM story_memories WHERE chat_id=?')
      .all(fork.id) as { entry: string }[];
    const stored = copiedRows
      .map((row) => JSON.parse(row.entry))
      .find((e) => e.text.includes('HIDDEN_EVIDENCE_SENTINEL'));
    expect(
      stored.knowledge.segments[0].sourceRevision,
      'stored hidden provenance must use copied source ID'
    ).toBe(copiedFirst.revision);
    expect(entry, 'valid copied memory must remain visible').toBeDefined();
    expect(entry.knowledge!.segments[0].sourceHash).toBe(first.hash);
    expect(entry.knowledge!.worldStatus).toBe('unspecified');
    expect(entry.knowledge!.knownByActorIds).toBeNull();
    const slot = copied.promptCompilation!.messages.find(
      (m) => m.provenance.blockId === 'memory-slot'
    )!;
    expect(slot.content[0].text).toContain(copiedFirst.revision);
    expect(slot.content[0].text).not.toContain(first.id);
    expect(f.store.source(first.id).text).toBe(hiddenText);
    expect(stored.knowledge.segments).toEqual(
      memory.knowledge.segments.map((segment: any) => ({
        ...segment,
        sourceRevision: copiedFirst.revision,
      }))
    );
    expect(f.store.run(third.runId)).toEqual(originalRun);
    expect(f.store.source(first.id)).toEqual(originalSource);
    const restored = database();
    expect(restored.product.import(f.store.product.export())).toEqual({ restored: true, chats: 2 });
  });
  test('completed hidden translation fork regenerates mapped context segment ranges and roundtrips archive', () => {
    const f = fixture(false);
    const s = source(f);
    const original = translate(f, s);
    const fork = forkChat(f.store, f.chatId, {
      fromRevision: s.id,
      idempotencyKey: 'hidden-translation-fork',
    });
    const copiedSource = f.store.source(fork.headRevision!);
    const copied = f.store.detail(fork.id).jobs.find((j) => j.kind === 'translation')!;
    expect(copied.result!.text).toBe(original.result!.text);
    const plan = f.store.product.plan(copied.id);
    expect(plan.context.segmentKnowledge.sourceRevision).toBe(copiedSource.id);
    expect(plan.context.segmentKnowledge.sourceHash).toBe(s.hash);
    expect(plan.context.segmentKnowledge.segments.map((x: any) => x.range)).toEqual(
      parseSourceSegments(
        {
          sourceRevision: copiedSource.id,
          sourceHash: s.hash,
          text: s.text,
        },
        createSourceSegmentFixture()
      ).segments.map((x) => x.range)
    );
    const restored = database();
    expect(restored.product.import(f.store.product.export())).toEqual({ restored: true, chats: 2 });
  });
  test('excluded hidden history stays out of memory slots/read/search and source edits retire old knowledge', () => {
    const f = fixture();
    const first = source(f);
    const entry = remember(f, first);
    source(f, 'A later visible scene.');

    const { chatId: _chat, revision, ...body } = f.store.product.profile(f.chatId);
    f.store.product.updateProfile(f.chatId, {
      ...body,
      expectedRevision: revision,
      packageValues: { [f.packageKey]: { 'exclude-asides': true, 'exclude-annotations': true } },
    });
    const run = queued(f);
    const snapshot = run.snapshot;
    const main = JSON.stringify(buildMainInput(snapshot));
    expect(main).not.toMatch(/HIDDEN_EVIDENCE_SENTINEL|EVALUATION_SENTINEL/);
    expect(JSON.stringify(snapshot.promptCompilation)).not.toMatch(
      /HIDDEN_EVIDENCE_SENTINEL|EVALUATION_SENTINEL/
    );
    const read = executeStoryRead(snapshot, {
      callId: 'read-hidden-source',
      name: 'story.read',
      args: { id: first.id, limit: 16000 },
    });
    expect(read.denied).toBe(false);
    expect(JSON.stringify(read.result)).not.toMatch(/HIDDEN_EVIDENCE_SENTINEL|EVALUATION_SENTINEL/);
    expect(
      executeStoryRead(snapshot, {
        callId: 'read-memory',
        name: 'memory.read',
        args: { id: entry.id },
      }).denied
    ).toBe(true);
    const search = executeStoryRead(snapshot, {
      callId: 'search-memory',
      name: 'memory.search',
      args: { query: 'HIDDEN_EVIDENCE_SENTINEL' },
    });
    expect((search.result as { total: number }).total).toBe(0);
    f.store.finishRun(run.id, 'cancelled', 'synthetic boundary');
    f.store.editSource(first.id, { text: 'An edited visible-only scene.', expectedRevision: 0 });
    expect(
      f.store.story.memory
        .entries(
          f.store.story.memory.scope(f.chatId, f.store.product.branch(f.chatId).headRevision)
        )
        .some((e) => e.id === entry.id)
    ).toBe(false);
    const restored = database();
    expect(restored.product.import(f.store.product.export())).toEqual({ restored: true, chats: 1 });
  });
});
