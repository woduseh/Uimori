import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { get_encoding } from 'tiktoken';
import { JevCredentialStore } from '../dist/server/jev-credentials.js';
import { judgeMainRefusal, mainJudgmentInput } from '../dist/server/main-judgment.js';
import { judgeTranslationRefusal } from '../dist/server/translation-judgment.js';
import { jevProbePassed } from './jev-probe-result.mjs';

// Explicit opt-in: synthetic content only, no automatic retries. Published input budgets
// reject maximum-size cases before transport; --within-budget makes two long live calls.
if (!process.argv.includes('--live')) {
  console.error('Run npm run build, then node scripts/verify-jev-input.mjs --live [output.json]');
  process.exit(1);
}
const output = resolve(
  process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ??
    '.local/jev-input-verification.json'
);
const credential = new JevCredentialStore(resolve('.local/uimori.sqlite')).resolve;
const diagnostic = process.argv.includes('--diagnostic-max-main');
const withinBudget = process.argv.includes('--within-budget');
if (diagnostic && withinBudget) throw new Error('PROBE_MODE_CONFLICT');
if (!credential()) throw new Error('JEV_CREDENTIAL_REQUIRED');
const tokenizer = get_encoding('o200k_base');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const report = {
  startedAt: new Date().toISOString(),
  model: 'jev-latest',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  estimator: 'o200k_base',
  appMaxOutputTokens: 500_000,
  timeoutMs: 60_000,
  syntheticOnly: true,
  automaticRetries: 0,
  cases: [],
};
await mkdir(dirname(output), { recursive: true });
try {
  for (const targetTokens of diagnostic ? [500_000] : withinBudget ? [16_000] : [128, 16_000]) {
    const candidate = ' story'.repeat(targetTokens);
    const candidateTokens = tokenizer.encode(candidate).length;
    if (candidateTokens !== targetTokens) throw new Error('SYNTHETIC_TOKEN_COUNT_MISMATCH');
    for (const kind of diagnostic ? ['main'] : ['main', 'translation']) {
      const entry = {
        kind,
        targetTokens,
        candidateTokens,
        candidateCharacters: candidate.length,
        candidateSha256: hash(candidate),
        startedAt: new Date().toISOString(),
        attemptCount: 0,
        transportCount: 0,
        expected: diagnostic ? 'budget-rejected' : 'completed',
      };
      const started = performance.now();
      const hooks = {
        signal: new AbortController().signal,
        credential,
        timeoutMs: report.timeoutMs,
        async fetch(url, options) {
          entry.transportCount++;
          const response = await fetch(url, options);
          if (!response.ok && diagnostic) {
            const reader = response.clone().body?.getReader();
            const chunks = [];
            let size = 0;
            if (reader) {
              while (size < 8192) {
                const part = await reader.read();
                if (part.done) break;
                chunks.push(part.value.slice(0, 8192 - size));
                size += part.value.length;
              }
              await reader.cancel();
            }
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const payload = JSON.parse(body);
              entry.providerErrorPath =
                payload.error != null ? 'error' : payload.detail != null ? 'detail' : 'message';
              const error = payload.error ?? payload.detail ?? payload.message;
              entry.providerError = JSON.stringify(error)?.replaceAll(credential(), '[REDACTED]');
            } catch {
              entry.providerError = 'Non-JSON or oversized error response; body omitted';
            }
          }
          return response;
        },
        onAttemptStart(wire) {
          entry.attemptCount++;
          entry.wholeStateMatches = wire.body.state.response === candidate;
          entry.requestBytes = Buffer.byteLength(JSON.stringify(wire.body));
          entry.requestTokens = tokenizer.encode(JSON.stringify(wire.body)).length;
          entry.requestSha256 = wire.bodySha256;
          entry.questions = Object.keys(wire.body.questions);
          if (!entry.wholeStateMatches || entry.questions.join(',') !== 'explicitRefusal')
            throw new Error('JEV_PROBE_WIRE_MISMATCH');
          return `live-${kind}-${targetTokens}`;
        },
        onAttemptFinish(_id, result) {
          entry.status = result.status;
          entry.errorCode = result.error?.code ?? null;
          entry.usage = result.usage;
        },
      };
      try {
        const result =
          kind === 'main'
            ? await judgeMainRefusal(mainJudgmentInput(candidate), hooks)
            : await judgeTranslationRefusal(
                candidate,
                hash('synthetic source'),
                { threshold: 0.9 },
                hooks
              );
        entry.verdict = result.verdict;
        entry.explicitRefusal = result.scores.explicitRefusal;
      } catch (error) {
        entry.status = 'error';
        entry.errorCode = error.code ?? 'PROBE_FAILED';
      }
      entry.elapsedMs = Math.round(performance.now() - started);
      entry.passed = jevProbePassed(entry);
      report.cases.push(entry);
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify(entry));
    }
  }
} finally {
  tokenizer.free();
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.cases.some((entry) => !entry.passed)) process.exitCode = 1;
