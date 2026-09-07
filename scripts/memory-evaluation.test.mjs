import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCorpus, scoreAnswers, preflight } from './memory-evaluation-data.mjs';

const corpus = generateCorpus();
const oracle = () => corpus.questions.map(q => ({ id: q.id, text: q.expected.join('; '), evidence: structuredClone(q.evidence) }));
test('corpus is deterministic, distributed, hash-bound and reports estimates honestly at both endpoints', () => {
  assert.equal(generateCorpus().corpusHash, corpus.corpusHash);
  for (const target of [150000, 200000]) {
    const c = generateCorpus(target);
    assert.ok(c.size.estimatedTokens >= target && c.size.estimatedTokens < target + 1500);
    assert.ok(c.sources.length >= 220);
    assert.equal(c.size.actualTokens, null);
    assert.equal(new Set(c.sources.map(s => s.contentHash)).size, c.sources.length);
    for (const p of c.probes) {
      const source = c.sources.find(s => s.revision === p.evidence.revision);
      assert.equal(source.text.slice(p.evidence.start, p.evidence.end), p.evidence.quote);
      assert.equal(source.contentHash, p.evidence.hash);
    }
  }
});
test('scorer detects omissions, contaminated knowledge, wrong ordering and forged evidence independently', () => {
  assert.equal(scoreAnswers(corpus, oracle()).passed, corpus.questions.length);
  const answers = oracle();
  answers.find(a => a.id === 'private').text = 'unknown to Mira Vale; beneath the clinic stairs';
  answers.find(a => a.id === 'order-b').text = 'festival began; ferry repaired; bell cracked';
  answers.find(a => a.id === 'old-fact').evidence[0].hash = 'forged';
  answers.find(a => a.id === 'similar-name').text = 'silver compass';
  const result = scoreAnswers(corpus, answers);
  assert.equal(result.contaminatedQuestions, 1);
  assert.equal(result.passed, corpus.questions.length - 4);
  assert.ok(result.citationPrecision < 1 && result.citationRecall < 1 && result.answerRecall < 1);
  assert.equal(scoreAnswers(corpus, []).passed, 0);
  assert.throws(() => scoreAnswers(corpus, [answers[0], answers[0]]));
});
test('all questions require their distinct gold citations; duplicate citation cannot cover another source', () => {
  const answers = oracle(); const a = answers.find(a => a.id === 'uncertainty'); a.evidence = [a.evidence[0], a.evidence[0]];
  assert.equal(scoreAnswers(corpus, answers).rows.find(r => r.id === 'uncertainty').pass, false);
});
test('preflight is offline and blocks absent authorization, fake token scope and insufficient call budgets', () => {
  assert.equal(preflight(corpus).status, 'BLOCKED');
  const config = { resumeQualityEvaluation: true, syntheticOnly: true, corpusHash: corpus.corpusHash, provider: 'review-only', model: 'synthetic-model', approvalReference: 'test-only', maxCalls: 1000, maxUsd: 1000, maxInputTokensPerCall: 200000, maxOutputTokensPerCall: 1000, tokenCount: { corpusHash: corpus.corpusHash, model: 'synthetic-model', tokens: 180000, method: 'test attestation only' }, pricing: { source: 'test fixture, not real pricing', inputUsdPerMillion: 1, outputUsdPerMillion: 1 } };
  const valid = preflight(corpus, config); assert.equal(valid.status, 'READY_FOR_REVIEW'); assert.equal(valid.executeSupported, false); assert.equal(valid.networkCalls, 0); assert.equal(valid.costUsd, null);
  for (const patch of [{ resumeQualityEvaluation: false }, { corpusHash: 'stale' }, { maxCalls: 1 }, { maxUsd: 0 }, { maxUsd: 1 }, { maxInputTokensPerCall: 100 }, { tokenCount: { ...config.tokenCount, model: 'other-model' } }, { tokenCount: { ...config.tokenCount, tokens: 200001 } }, { pricing: null }]) assert.equal(preflight(corpus, { ...config, ...patch }).status, 'BLOCKED');
});
