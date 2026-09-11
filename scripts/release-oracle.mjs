import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { assertBuild, json, newId, root } from './lib.mjs';
import { readAccessEnv, runOracleSmoke } from './oracle-smoke.mjs';
import { requiredChecks, runReleaseChecks, verifyReleaseReceipt } from './release-check.mjs';
import {
  identityKey,
  isMain,
  parseOptions,
  readJson,
  releaseFingerprint,
  requireSuccess,
  runExternal,
  shellQuote,
} from './release-common.mjs';

export const remoteFiles = [
  'deploy/oracle-update.sh',
  'deploy/oracle-update.py',
  'scripts/oracle-data.mjs',
  'scripts/oracle-image-probe.mjs',
];

function remoteDirectory(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\/[a-zA-Z0-9_./-]+$/u.test(value) ||
    path.posix.normalize(value) !== value ||
    value === '/' ||
    value.endsWith('/') ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error(`Invalid ${label}: use a dedicated absolute POSIX directory`);
  return value;
}

export function validateConfig(input, configDirectory = root) {
  const allowed = new Set([
    'host',
    'identityFile',
    'knownHostsFile',
    'appDirectory',
    'releaseRoot',
    'accessEnvFile',
    'area',
  ]);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Oracle configuration must be an object');
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error('Unknown Oracle configuration field; secrets belong in the private env file');
  if (!/^(?:[a-z_][a-z0-9_-]*@)?[a-z0-9][a-z0-9.-]*$/u.test(input.host ?? ''))
    throw new Error('Invalid SSH host');
  const appDirectory = remoteDirectory(input.appDirectory ?? '/opt/uimori/app', 'appDirectory');
  const releaseRoot = remoteDirectory(input.releaseRoot ?? '/opt/uimori/releases', 'releaseRoot');
  if (releaseRoot !== '/opt/uimori/releases')
    throw new Error('This Oracle runner uses /opt/uimori/releases as its dedicated release root');
  if (
    releaseRoot === appDirectory ||
    releaseRoot.startsWith(appDirectory + '/') ||
    appDirectory.startsWith(releaseRoot + '/')
  )
    throw new Error('The app and release directories must be separate');
  const config = {
    host: input.host,
    appDirectory,
    releaseRoot,
    area: input.area ?? 'verify:browser-smoke',
  };
  for (const key of ['identityFile', 'knownHostsFile', 'accessEnvFile']) {
    if (typeof input[key] !== 'string' || !input[key] || /[\0\r\n]/u.test(input[key]))
      throw new Error(`Missing or invalid ${key}`);
    config[key] = path.resolve(configDirectory, input[key]);
  }
  return config;
}

export function sshOptions(config) {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${config.knownHostsFile}`,
    '-i',
    config.identityFile,
  ];
}

function openSsh(tool) {
  const candidate =
    process.platform === 'win32'
      ? path.join(process.env.WINDIR ?? 'C:/Windows', 'System32', 'OpenSSH', `${tool}.exe`)
      : tool;
  if (process.platform === 'win32' && !existsSync(candidate))
    throw new Error(`Windows OpenSSH ${tool} is unavailable`);
  return candidate;
}

export function remoteCommand({
  config,
  commit,
  build,
  releaseDirectory,
  origin,
  fresh,
  image,
  checkOnly,
}) {
  if (
    !/^[a-f0-9]{40}$/u.test(commit) ||
    !/^[a-f0-9]{64}$/u.test(build.buildId) ||
    !/^[a-f0-9]{64}$/u.test(build.distHash)
  )
    throw new Error('Invalid release identity');
  remoteDirectory(releaseDirectory, 'releaseDirectory');
  if (!releaseDirectory.startsWith(config.releaseRoot + '/'))
    throw new Error('Release directory escaped configured root');
  if (image && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,499}$/u.test(image))
    throw new Error('Invalid Docker image reference');
  const args = [
    'sh',
    `${releaseDirectory}/deploy/oracle-update.sh`,
    '--app-dir',
    config.appDirectory,
    '--commit',
    commit,
    '--build-id',
    build.buildId,
    '--dist-hash',
    build.distHash,
    '--release-dir',
    releaseDirectory,
    '--expected-origin',
    origin,
    ...(fresh ? ['--fresh'] : []),
    ...(image ? ['--image', image] : []),
    ...(checkOnly ? ['--check-only'] : []),
  ];
  return args.map(shellQuote).join(' ');
}

export function parseRemoteSummary(output) {
  const records = output.split(/\r?\n/u).filter((line) => line.startsWith('ORACLE_SUMMARY '));
  if (records.length !== 1)
    throw new Error(
      'Remote release summary missing or ambiguous; inspect remote state before retrying'
    );
  return JSON.parse(records[0].slice('ORACLE_SUMMARY '.length));
}

export async function releaseOracle(options, dependencies = {}) {
  const execute = dependencies.execute ?? runExternal;
  const check = dependencies.check ?? runReleaseChecks;
  const smoke = dependencies.smoke ?? runOracleSmoke;
  const currentIdentity = dependencies.fingerprint ?? releaseFingerprint;
  const currentBuild = dependencies.assertBuild ?? assertBuild;
  const accessReader = dependencies.readAccessEnv ?? readAccessEnv;
  const log = dependencies.log ?? console.log;
  const configuration = path.resolve(options.config ?? '.local/oracle-release.json');
  let input;
  try {
    input = await readJson(configuration);
  } catch {
    throw new Error('Oracle configuration is missing or invalid JSON');
  }
  const config = validateConfig(input, path.dirname(configuration));
  for (const key of ['identityFile', 'knownHostsFile', 'accessEnvFile'])
    if (!(await stat(config[key])).isFile())
      throw new Error(`${key} must be an existing private file`);
  const access = await accessReader(config.accessEnvFile);
  const redact = (value) => String(value).split(access.token).join('[redacted]');
  const area = options.area ?? config.area;
  const scripts = dependencies.scripts ?? (await readJson(path.join(root, 'package.json'))).scripts;
  const checks = requiredChecks(area, options.full, scripts);
  const git = async (...args) =>
    requireSuccess(
      await execute('git', args, { timeoutMs: 30_000, signal: options.signal, redact }),
      'git'
    ).output.trim();
  const commit = await git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Git HEAD is unavailable');
  const dirty = Boolean(await git('status', '--porcelain'));
  const runId = `${newId()}-${commit.slice(0, 7)}`;
  const releaseDirectory = `${config.releaseRoot}/${runId}`;
  const summary = {
    schema: 1,
    status: 'FAIL',
    commit,
    mode: options.fresh ? 'fresh' : 'update',
    imageSource: options.image ?? 'remote-build',
    host: config.host,
    publicOrigin: access.origin,
    appDirectory: config.appDirectory,
    releaseDirectory,
    startedAt: new Date().toISOString(),
    stages: [],
    limitations: [
      'Production HTTPS/API smoke does not prove browser rendering or real model behavior.',
    ],
  };
  if (options.plan)
    return { ...summary, status: 'PLAN', dirty, requiredChecks: checks, remoteContacted: false };
  if (dirty)
    throw new Error(
      'Review and commit local changes before deploying; the release command never stages, commits or pushes'
    );
  const remoteHead = await git('ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/main');
  if (remoteHead.split(/\s+/u)[0] !== commit)
    throw new Error('HEAD must match origin/main; push the reviewed commit before deploying');
  const outputDirectory = path.join(
    dependencies.outputRoot ?? path.join(root, 'output/release/oracle'),
    runId
  );
  const report = path.join(outputDirectory, 'summary.json');
  summary.report = report;
  await json(report, summary);
  const stage = async (name, action) => {
    const entry = { name, status: 'FAIL', startedAt: new Date().toISOString() };
    summary.stages.push(entry);
    log(`RUN ${name}`);
    try {
      const value = await action();
      entry.status = 'PASS';
      return value;
    } catch (error) {
      entry.error = redact(error.message);
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
      entry.elapsedMs = Date.parse(entry.finishedAt) - Date.parse(entry.startedAt);
      await json(report, summary);
    }
  };
  let remoteStarted = false;
  try {
    const receipt = await stage('verification', async () => {
      const result = await check({ area, full: options.full, signal: options.signal });
      await verifyReleaseReceipt(result, await currentIdentity(), checks);
      return result;
    });
    summary.verificationReport = receipt.report;
    summary.identity = receipt.identity;
    const build = await currentBuild();
    summary.buildId = build.buildId;
    summary.distHash = build.distHash;
    const command = remoteCommand({
      config,
      commit,
      build,
      releaseDirectory,
      origin: access.origin,
      fresh: options.fresh,
      image: options.image,
      checkOnly: options['check-only'],
    });
    const ssh = dependencies.ssh ?? openSsh('ssh'),
      scp = dependencies.scp ?? openSsh('scp');
    const sshArgs = sshOptions(config);
    const sshRun = (text, name, timeoutMs = 60_000) =>
      execute(ssh, [...sshArgs, config.host, text], {
        timeoutMs,
        log: path.join(outputDirectory, `${name}.log`),
        signal: options.signal,
        redact,
      });
    await stage('stage-runner', async () => {
      for (const name of remoteFiles) {
        if (!(await stat(path.join(root, name))).isFile())
          throw new Error(`Release helper unavailable: ${name}`);
      }
      requireSuccess(
        await sshRun(
          ['mkdir', '-p', '--', `${releaseDirectory}/deploy`, `${releaseDirectory}/scripts`]
            .map(shellQuote)
            .join(' '),
          'stage-directories'
        ),
        'Create release directories'
      );
      for (const directory of ['deploy', 'scripts']) {
        const sources = remoteFiles
          .filter((name) => name.startsWith(directory + '/'))
          .map((name) => path.join(root, name));
        const result = await execute(
          scp,
          [...sshArgs, ...sources, `${config.host}:${releaseDirectory}/${directory}/`],
          {
            timeoutMs: 60_000,
            log: path.join(outputDirectory, `stage-${directory}.log`),
            signal: options.signal,
            redact,
          }
        );
        requireSuccess(result, `Stage ${directory}`);
      }
    });
    if (
      identityKey(await currentIdentity()) !== identityKey(receipt.identity) ||
      (await git('rev-parse', 'HEAD')) !== commit ||
      (await git('status', '--porcelain'))
    )
      throw new Error('Source changed after verification; staged release was not executed');
    const remote = await stage(options['check-only'] ? 'prepare-image' : 'deploy', async () => {
      remoteStarted = true;
      const result = await sshRun(command, 'remote-release', 1_200_000);
      try {
        summary.remote = parseRemoteSummary(result.output);
      } catch (error) {
        summary.remoteState = 'UNKNOWN';
        throw error;
      }
      requireSuccess(result, 'Oracle runner');
      if (summary.remote.status !== 'PASS') throw new Error('Oracle runner did not report PASS');
      if (
        summary.remote.commit !== commit ||
        summary.remote.buildId !== build.buildId ||
        summary.remote.distHash !== build.distHash ||
        summary.remote.mode !== summary.mode ||
        summary.remote.checkOnly !== Boolean(options['check-only'])
      )
        throw new Error('Remote release identity or action differs from the requested release');
      return summary.remote;
    });
    if (remote.publicOrigin !== access.origin)
      throw new Error('Remote public origin differs from private access settings');
    if (!options['check-only']) {
      summary.smoke = await stage('https-smoke', async () => {
        const result = await smoke({
          ...access,
          buildId: build.buildId,
          outputFile: path.join(outputDirectory, 'https-smoke.json'),
        });
        if (result.status !== 'PASS')
          throw new Error('HTTPS/API smoke failed; deployment state is recorded separately');
        return result;
      });
    }
    summary.status = 'PASS';
  } catch (error) {
    summary.error = redact(error.message);
    if (remoteStarted && !summary.remote) summary.remoteState = 'UNKNOWN';
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.elapsedMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
    await json(report, summary);
    log(`Oracle release ${summary.status}. Report: ${report}`);
  }
  return summary;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), {
      values: ['config', 'area', 'image'],
      flags: ['full', 'fresh', 'check-only', 'plan', 'help'],
    });
    if (options.help)
      console.log(
        'npm run release:oracle -- [--config .local/oracle-release.json] [--area verify:browser-smoke] [--full] [--fresh] [--image reference] [--check-only | --plan]'
      );
    else {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await releaseOracle({ ...options, signal: controller.signal });
        if (options.plan) console.log(JSON.stringify(result, null, 2));
        process.exitCode = ['PASS', 'PLAN'].includes(result.status) ? 0 : 1;
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
