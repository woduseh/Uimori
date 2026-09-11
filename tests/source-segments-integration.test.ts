import { updateTestProfile } from './fixtures/model-workspace.js';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import { translationInput } from '../core/auxiliary.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import { validateTranslationArtifact } from '../server/source-editing.js';
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
function fixture() {
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
        { id: 'memory-slot', title: 'Memory', kind: 'slot', role: 'system', slot: 'notes' },
        { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
      ],
    },
  });
  const prior = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: prior.revision,
    attachments: prior.attachments,

    routes: prior.routes,
    image: false,
  });
  updatePromptWorkspace(store, {
    expectedRevision: promptWorkspace(store).revision,
    main: { title: preset.title, program: preset.program, values: {} },
  });
  const state = store.story.configForBranch(chat.id, branchId);
  store.story.saveConfig(chat.id, {
    branchId,
    expectedRevision: state.revision,
    module: state.module,
    stateModel: null,
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
function translate(f: ReturnType<typeof fixture>, s: ReturnType<typeof source>) {
  const job = f.store.requestTranslation(s.id);
  const snapshot = f.store.product.resolveJobPrompt(f.store.run(s.runId).snapshot, job.input);
  const initial = translationInput(s, sourceTimeContext(snapshot, 'translation'), snapshot);
  const claim = f.store.claimJob(job.id, 'synthetic-translation', { initial })!;
  expect(
    f.store.completeJob(job.id, claim.generation, 'synthetic-translation', {
      mock: true,
      sourceRevision: s.id,
      sourceHash: s.hash,
      text: initial.sourceText,
    })
  ).toBe(true);
  validateTranslationArtifact(f.store, f.store.job(job.id), s);
  return f.store.job(job.id);
}

describe('Source segment memory, translation and fork provenance (synthetic only)', () => {
  test('completed hidden translation fork regenerates mapped context segment ranges and roundtrips archive', () => {
    const f = fixture();
    const s = source(f);
    const original = translate(f, s);
    const fork = forkChat(f.store, f.chatId, {
      fromRevision: s.id,
      idempotencyKey: 'hidden-translation-fork',
    });
    const copiedSource = f.store.source(fork.headRevision!);
    const copied = f.store.detail(fork.id).jobs.find((j) => j.kind === 'translation')!;
    expect(copied.result!.text).toBe(original.result!.text);
    const snapshot = f.store.product.resolveJobPrompt(
      f.store.run(copiedSource.runId).snapshot,
      copied.input
    );
    const input = {
      initial: translationInput(copiedSource, sourceTimeContext(snapshot, 'translation'), snapshot),
    };
    expect(copied.result).toMatchObject({ sourceRevision: copiedSource.id, sourceHash: s.hash });
    expect(input.initial.sourceRevision).toBe(copiedSource.id);
    expect(input.initial.sourceHash).toBe(s.hash);
    expect(input.initial.sourceText).toBe(s.text);
    expect(JSON.stringify(input.initial.context)).not.toContain('actorKnowledge');
    const restored = database();
    expect(restored.product.import(f.store.product.export())).toEqual({ restored: true, chats: 2 });
  });
});
