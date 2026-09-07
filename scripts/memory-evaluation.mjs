import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import assert from 'node:assert/strict';
import { generateCorpus, preflight, scoreAnswers, sizeOf } from './memory-evaluation-data.mjs';

// This entry point has no provider/auth imports. Even accidental fetch use fails closed.
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error('MEMORY_EVALUATION_OFFLINE');
};
const args = process.argv.slice(2);
const mode = args.shift() ?? 'local';
if (!['local', 'preflight', 'score'].includes(mode))
  throw new Error(
    'Usage: node scripts/memory-evaluation.mjs local|preflight|score [--target 180000] [--config file] [--answers file]'
  );
const options = {};
while (args.length) {
  const key = args.shift();
  if (!['--target', '--config', '--answers'].includes(key) || !args.length || options[key])
    throw new Error(`Invalid argument ${key}`);
  options[key] = args.shift();
}
const corpus = generateCorpus(Number(options['--target'] ?? 180000));
const directory = resolve(
  'output/memory-evaluation',
  `${new Date().toISOString().replaceAll(':', '-')}-${mode}`
);
await mkdir(directory, { recursive: true });
const json = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
await json('corpus.json', corpus);
await json(
  'questions.json',
  corpus.questions.map(({ id, question }) => ({ id, question }))
);
await json('declarations.json', corpus.declarations);
await writeFile(
  join(directory, 'sources.jsonl'),
  corpus.sources.map((s) => JSON.stringify(s)).join('\n') + '\n'
);
await json('approval-template.json', {
  resumeQualityEvaluation: false,
  syntheticOnly: true,
  corpusHash: corpus.corpusHash,
  provider: '',
  model: '',
  approvalReference: '',
  maxCalls: null,
  maxUsd: null,
  maxInputTokensPerCall: null,
  maxOutputTokensPerCall: null,
  tokenCount: { corpusHash: corpus.corpusHash, model: '', tokens: null, method: '' },
  pricing: { source: '', inputUsdPerMillion: null, outputUsdPerMillion: null },
});
await json('evaluation-protocol.json', {
  corpusHash: corpus.corpusHash,
  executeSupported: false,
  modelVisibleFiles: [
    'sources.jsonl',
    'questions.json',
    'declarations.json (select the appropriate declaration, not both)',
  ],
  goldFile: 'corpus.json (never send to evaluated model)',
  arms: [
    {
      name: 'main-only',
      input:
        'Selected main ancestry source bodies, appropriate authored declaration, question, citation schema. No gold or sibling source.',
      minimumAnswerCalls: corpus.questions.length,
    },
    {
      name: 'memory-assisted',
      input:
        'Run sequential per-source extraction using existing StoryStore/StoryRunner; retain typed entries with source refs. Prepare production context, then answer with scoped memory/story tools; never seed oracle entries for quality evaluation.',
      minimumExtractionCalls: corpus.sources.length,
      minimumAnswerCalls: corpus.questions.length,
    },
  ],
  cases: corpus.questions.map((q) => ({
    id: q.id,
    declarationIds: q.id === 'declared-past' ? ['past'] : ['retcon'],
    branch: 'main',
    sourceVersion: 'original',
    knowledgePerspective:
      q.id === 'private'
        ? 'Mira Vale only; narrator knowledge is not character knowledge'
        : 'narrator',
  })),
  answerSchema: {
    corpusHash: corpus.corpusHash,
    arm: 'main-only | memory-assisted',
    model: 'exact model/version',
    answers: [
      {
        id: 'question-id',
        text: 'answer',
        evidence: [
          { revision: 'scene-N', hash: 'sha256', start: 0, end: 1, quote: 'exact source slice' },
        ],
      },
    ],
    usage:
      'per-attempt ledger, including extraction/tool rounds/retries/failures/uncertain attempts',
    pricing: 'dated official basis, never billing',
  },
  manualReview: [
    'Name/value attribution',
    'Unsupported extra claims beyond the exact-atom rubric',
    'Conflict and uncertainty preserved rather than flattened',
    'Private information is not acted on by an uninformed character',
    'Summary omissions and false claims against source refs',
    'Report each arm separately, including extraction cost and repeated history input',
  ],
  safety:
    'No live executor in this harness. After explicit resumption, integrate with existing host attempt reservations/permission checks/cancellation/owner generation; interrupted or uncertain calls require explicit recovery. Actual assembled token counts must fit approved/model context limits.',
});
if (mode === 'preflight') {
  const config = options['--config'] ? JSON.parse(await readFile(options['--config'], 'utf8')) : {};
  const report = preflight(corpus, config);
  await json('summary.json', report);
  console.log(JSON.stringify({ directory, ...report }, null, 2));
  if (report.status === 'BLOCKED') process.exitCode = 2;
} else if (mode === 'score') {
  if (!options['--answers']) throw new Error('--answers required');
  const artifact = JSON.parse(await readFile(options['--answers'], 'utf8'));
  if (
    artifact.corpusHash !== corpus.corpusHash ||
    !['main-only', 'memory-assisted'].includes(artifact.arm)
  )
    throw new Error('Corpus hash and evaluation arm required');
  const report = {
    corpusHash: corpus.corpusHash,
    arm: artifact.arm,
    model: artifact.model ?? null,
    metrics: scoreAnswers(corpus, artifact.answers),
    usage: artifact.usage ?? null,
    costUsd: null,
    pricing: artifact.pricing ?? null,
    qualityStatus: 'REQUIRES_MANUAL_REVIEW',
    networkAttempts,
  };
  await json('summary.json', report);
  console.log(JSON.stringify({ directory, ...report }, null, 2));
} else {
  const { memoryHash, planMemoryContext, visibleMemoryEntries, validateMemoryEntry } = await import(
    pathToFileURL(resolve('dist/core/memory.js')).href
  );
  const { executeStoryRead, STORY_RESULT_MAX_BYTES } = await import(
    pathToFileURL(resolve('dist/core/story-context.js')).href
  );
  const scope = {
    chatId: 'synthetic-memory-evaluation',
    history: corpus.sources.map(({ revision, text, contentHash }) => ({
      revision,
      text,
      contentHash,
    })),
  };
  const entries = corpus.probes.map((p) => ({
    id: p.id,
    chatId: scope.chatId,
    atRevision: p.evidence.revision,
    atHash: p.evidence.hash,
    text: p.text,
    kind:
      p.id === 'private' || p.id === 'belief-a' || p.id === 'uncertainty'
        ? 'character-belief'
        : 'observed-story',
    ...(p.id === 'private' || p.id === 'belief-a' || p.id === 'uncertainty'
      ? {
          actor: p.id === 'private' ? 'Neri Moss' : p.id === 'belief-a' ? 'Tavi Reed' : 'Sera Lake',
        }
      : {}),
    sources: [p.evidence],
  }));
  // Seeded extraction is oracle data: validates transport/visibility, not extraction quality.
  for (const entry of entries) validateMemoryEntry(entry, scope);
  const canon = corpus.declarations.map((d) => ({
    id: d.id,
    chatId: scope.chatId,
    atRevision: null,
    atHash: null,
    kind: 'author-canon',
    text: d.text,
    declaration: { author: d.author, text: d.text },
  }));
  const checkpoint = {
    chatId: scope.chatId,
    indexed: scope.history.map((s) => ({ revision: s.revision, hash: s.contentHash })),
  };
  const seededSummaries = scope.history.map((s) => {
    const start = s.text.indexOf('Record ');
    const end = s.text.indexOf('\n', start);
    const quote = s.text.slice(start, end);
    return {
      id: `summary-${s.revision}`,
      chatId: scope.chatId,
      atRevision: s.revision,
      atHash: s.contentHash,
      kind: 'derived-summary',
      text: quote,
      sources: [{ revision: s.revision, hash: s.contentHash, start, end, quote }],
    };
  });
  const allEntries = [...entries, ...seededSummaries, canon[1]]; // Store retcon selection covered separately by SQLite regression suite.
  const snapshot = { ...scope, story: { memory: { entries: allEntries } } };
  const calls = [];
  const call = (name, args) => {
    const start = performance.now();
    const result = executeStoryRead(snapshot, { callId: `evaluation-${calls.length}`, name, args });
    const bytes = Buffer.byteLength(JSON.stringify(result.result));
    calls.push({ name, args, ms: performance.now() - start, bytes, denied: result.denied });
    assert.ok(bytes <= STORY_RESULT_MAX_BYTES);
    return result;
  };
  const timings = [];
  let plan;
  for (let i = 0; i < 6; i++) {
    const start = performance.now();
    plan = planMemoryContext({
      scope,
      entries: allEntries,
      checkpoint,
      recentCount: 2,
      maxPacketChars: 24000,
    });
    const ms = performance.now() - start;
    if (i) timings.push(ms);
  }
  assert.equal(plan.ready, true);
  assert.equal(plan.recentHistory.length, 2);
  assert.ok(plan.omittedMemories > 0);
  const oldMemory = call('memory.search', { query: 'blue ceramic kettle' });
  assert.equal(oldMemory.result.total, 1);
  const retrieved = [];
  for (const probe of corpus.probes) {
    const found = call('story.search', { query: probe.text.slice(0, 60), limit: 100 });
    assert.equal(found.denied, false);
    assert.ok(found.result.results.some((r) => r.revision === probe.evidence.revision));
    const read = call('story.read', {
      id: probe.evidence.revision,
      offset: probe.evidence.start,
      limit: probe.evidence.end - probe.evidence.start,
    });
    assert.equal(read.denied, false);
    assert.equal(read.result.text, probe.text);
    assert.equal(read.result.source.hash, probe.evidence.hash);
    retrieved.push(probe.id);
  }
  const siblingRead = call('story.read', { id: corpus.foreignSource.revision });
  assert.equal(siblingRead.denied, true);
  const siblingSearch = call('story.search', { query: 'cedar-five' });
  assert.equal(siblingSearch.result.total, 0);
  const changed = structuredClone(scope);
  const edited = changed.history.find((s) => s.revision === 'scene-121');
  edited.text = edited.text.replace('eleven bronze tokens', 'thirteen copper tokens');
  edited.contentHash = memoryHash(edited.text);
  assert.ok(!visibleMemoryEntries(changed, entries).some((e) => e.id === 'editable'));
  const changedPlan = planMemoryContext({
    scope: changed,
    entries: allEntries,
    checkpoint,
    recentCount: 2,
    maxPacketChars: 24000,
  });
  assert.equal(changedPlan.indexedCount, 121);
  assert.equal(changedPlan.ready, false);
  const gap = {
    ...checkpoint,
    indexed: checkpoint.indexed.filter((s) => s.revision !== 'scene-28'),
  };
  assert.equal(
    planMemoryContext({ scope, entries: [], checkpoint: gap, maxPacketChars: 24000 }).indexedCount,
    28
  );
  const forged = structuredClone(entries[0]);
  forged.sources[0].quote = 'fabricated';
  assert.throws(() => validateMemoryEntry(forged, scope));
  // Actor tagging is descriptive. Shared narrator tools do not authorize an actor-only view.
  const privateRead = call('memory.read', { id: 'private' });
  assert.equal(privateRead.denied, false);
  const mockAnswers = corpus.questions.map((q) => ({
    id: q.id,
    text: q.expected.join('; '),
    evidence: q.evidence,
  }));
  const oracleScore = scoreAnswers(corpus, mockAnswers);
  assert.equal(oracleScore.passed, corpus.questions.length);
  const sorted = [...timings].sort((a, b) => a - b);
  assert.equal(networkAttempts, 0);
  const summary = {
    status: 'PASS',
    qualityStatus: 'BLOCKED_NOT_EXECUTED',
    corpusHash: corpus.corpusHash,
    size: corpus.size,
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
    },
    boundaries: [
      'Pure production core planning/read/validation with synthetic ancestry; no DB/server/browser in this runner',
      'Oracle-seeded memory and exact search queries are not semantic recall or extraction evaluation',
      'English template corpus with distributed hand-authored probes, not Korean creative quality',
      'Five warm-cache samples; p95 is maximum, no timing pass threshold',
    ],
    context: {
      packet: sizeOf(
        JSON.stringify({
          watermark: plan.watermark,
          recentHistory: plan.recentHistory,
          memories: plan.memories,
        })
      ),
      packetChars: plan.packetChars,
      recentSources: plan.recentHistory.length,
      omittedMemories: plan.omittedMemories,
      visibleMemories: plan.visibleMemoryCount,
    },
    timings: { warmups: 1, samplesMs: timings, medianMs: sorted[2], p95Ms: sorted[4] },
    pipeline: {
      probesRetrieved: retrieved.length,
      totalProbes: corpus.probes.length,
      siblingReadDenied: siblingRead.denied,
      siblingSearchMatches: siblingSearch.result.total,
      sourceEditInvalidated: true,
      watermarkAfterEdit: changedPlan.indexedCount,
      editedTailBlocked: !changedPlan.ready,
      forgedQuoteRejected: true,
    },
    knowledgeBoundary: {
      actorMetadataPreserved: privateRead.result.entry.actor === 'Neri Moss',
      privateMemoryAvailableToNarrator: true,
      actorOnlyIsolation:
        'NOT_IMPLEMENTED_BY_SHARED_TOOL_SCOPE; requires model-level knowledge evaluation, not a host authorization promise',
    },
    oracleRubricSelfCheck: oracleScore,
    calls,
    modelCalls: 0,
    networkAttempts,
    usage: { inputTokens: null, outputTokens: null },
    costUsd: null,
    pricingBasis: null,
  };
  await json('oracle-answers.json', {
    corpusHash: corpus.corpusHash,
    arm: 'memory-assisted',
    model: 'deterministic-oracle-NOT-QUALITY',
    answers: mockAnswers,
  });
  await json('summary.json', summary);
  console.log(
    JSON.stringify(
      {
        directory,
        ...summary,
        calls: `${calls.length} local tool calls in summary.json`,
        oracleRubricSelfCheck: { passed: oracleScore.passed, total: oracleScore.total },
      },
      null,
      2
    )
  );
}
