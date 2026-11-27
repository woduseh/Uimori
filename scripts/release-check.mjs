import path from 'node:path';
import { assertBuild, json, newId, root } from './lib.mjs';
import { privateMaterialEnv, readFeatureMap, verificationNames } from './verify.mjs';
import {
  identityKey,
  isMain,
  npmCli,
  parseOptions,
  readJson,
  releaseFingerprint,
  runExternal,
} from './release-common.mjs';

const defaultArea = 'browser-smoke';
const fullRegression = 'verify -- all';

export function requiredChecks(area = defaultArea, full = false, featureMap = readFeatureMap()) {
  const kind = verificationNames(featureMap).get(area)?.kind;
  if (kind !== 'domain' && kind !== 'preset')
    throw new Error(
      'Choose a feature-map domain or preset for --area; use --full for the complete regression'
    );
  return [
    ...new Set([
      ...(full ? ['quality:full'] : ['quality', 'build']),
      ...(full && area === defaultArea ? [] : [`verify -- ${area}`]),
      ...(full ? [fullRegression] : []),
    ]),
  ];
}

export async function runReleaseChecks(
  { area = defaultArea, full = false, signal } = {},
  dependencies = {}
) {
  const sourceIdentity = dependencies.fingerprint ?? releaseFingerprint;
  const buildIdentity = dependencies.assertBuild ?? assertBuild;
  const execute = dependencies.execute ?? runExternal;
  const featureMap = dependencies.featureMap ?? readFeatureMap();
  const checks = requiredChecks(area, full, featureMap);
  const syntheticEnv = Object.fromEntries(
    ['UIMORI_VISUAL_REVIEW', 'UIMORI_BENCHMARK', ...privateMaterialEnv(featureMap)].map((name) => [
      name,
      undefined,
    ])
  );
  const identity = await sourceIdentity();
  const directory = path.join(
    dependencies.outputRoot ?? path.join(root, 'output/release/checks'),
    identityKey(identity)
  );
  const report = path.join(directory, 'summary.json');
  const cached = await readJson(report, null);
  const reusable = cached?.schema === 1 && identityKey(cached.identity) === identityKey(identity);
  const summary = {
    schema: 1,
    status: 'FAIL',
    identity,
    requested: checks,
    checks: reusable ? { ...cached.checks } : {},
    startedAt: new Date().toISOString(),
    report,
    limitations: ['Local synthetic validation; no provider calls or production deployment proof.'],
  };
  const log = dependencies.log ?? console.log;
  const cli = dependencies.npmCli ?? npmCli();
  for (const name of checks) summary.checks[name] ??= { command: name, status: 'NOT_RUN' };
  await json(report, summary);
  try {
    for (const name of checks) {
      if (signal?.aborted) throw new Error('Release checks cancelled');
      const reusableCheck = summary.checks[name].status === 'PASS';
      if (reusableCheck && (name === 'quality:full' || name === 'build')) {
        try {
          await buildIdentity();
        } catch {
          log('BUILD missing or stale; rebuilding without repeating quality tests');
          const rebuild = await execute(process.execPath, [cli, 'run', 'build'], {
            timeoutMs: 300_000,
            log: path.join(directory, `build-${newId()}.log`),
            signal,
          });
          if (rebuild.code !== 0 || rebuild.timedOut || rebuild.cancelled)
            throw new Error('Build refresh failed; cached quality does not certify this build');
          await buildIdentity();
        }
      }
      if (reusableCheck) {
        log(`REUSE ${name}`);
        continue;
      }
      log(`RUN ${name}`);
      summary.checks[name] = { command: name, status: 'RUNNING' };
      await json(report, summary);
      const result = await execute(process.execPath, [cli, 'run', ...name.split(' ')], {
        timeoutMs: name === fullRegression ? 3_900_000 : 1_200_000,
        log: path.join(directory, `${name.replaceAll(/[^a-z0-9]+/gu, '-')}-${newId()}.log`),
        signal,
        env: syntheticEnv,
      });
      const { output, ...record } = result;
      const passed = result.code === 0 && !result.timedOut && !result.cancelled;
      summary.checks[name] = {
        command: name,
        ...record,
        status: passed ? 'PASS' : 'FAIL',
        ...(passed ? {} : { error: output.slice(-1800) }),
      };
      await json(report, summary);
      if (!passed) throw new Error(`${name} failed. Evidence: ${record.log}`);
    }
    summary.build = await buildIdentity();
    summary.status = 'PASS';
  } catch (error) {
    summary.status = 'FAIL';
    summary.error = error.message;
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.elapsedMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
    await json(report, summary);
    log(`Release checks ${summary.status}. Report: ${report}`);
  }
  return summary;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), {
      values: ['area'],
      flags: ['full', 'help'],
    });
    if (options.help)
      console.log(
        `npm run release:check -- [--area <domain or preset, default ${defaultArea}>] [--full]`
      );
    else {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await runReleaseChecks({ ...options, signal: controller.signal });
        process.exitCode = result.status === 'PASS' ? 0 : 1;
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
