import { existsSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildFingerprint, json, newId, root } from './lib.mjs';
import { requireCi } from './ci-gate.mjs';
import {
  isMain,
  parseOptions,
  readJson,
  requireSuccess,
  runExternal,
  shellQuote,
} from './release-common.mjs';

export const remoteFiles = [
  'deploy/oracle-update.sh',
  'deploy/oracle-update.py',
  'deploy/oracle_gc.py',
  'scripts/oracle-data.mjs',
  'scripts/oracle-image-probe.mjs',
  'scripts/oracle-smoke.mjs',
  'scripts/oracle-host-control.mjs',
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

export function validateSourceRef(value = 'main') {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.includes('..') ||
    value.includes('/./') ||
    value.endsWith('/') ||
    value.endsWith('.')
  )
    throw new Error('Invalid sourceRef');
  return value;
}

export function validateConfig(input, configDirectory = root) {
  const allowed = new Set([
    'host',
    'identityFile',
    'knownHostsFile',
    'appDirectory',
    'releaseRoot',
    'expectedOrigin',
    'sourceRef',
  ]);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Oracle configuration must be an object');
  if ('accessEnvFile' in input || 'area' in input)
    throw new Error(
      'Replace accessEnvFile/area with expectedOrigin; Oracle deployment now uses CI and host-side credentials.'
    );
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error('Unknown Oracle configuration field; secrets belong in the private env file');
  if (!/^(?:[a-z_][a-z0-9_-]*@)?[a-z0-9][a-z0-9.-]*$/u.test(input.host ?? ''))
    throw new Error('Invalid SSH host');
  const appDirectory = remoteDirectory(input.appDirectory ?? '/opt/uimori/app', 'appDirectory');
  const releaseRoot = remoteDirectory(input.releaseRoot ?? '/opt/uimori/releases', 'releaseRoot');
  const sourceRef = validateSourceRef(input.sourceRef ?? 'main');
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
    expectedOrigin: input.expectedOrigin,
    sourceRef,
  };
  for (const key of ['identityFile', 'knownHostsFile']) {
    if (typeof input[key] !== 'string' || !input[key] || /[\0\r\n]/u.test(input[key]))
      throw new Error(`Missing or invalid ${key}`);
    config[key] = path.resolve(configDirectory, input[key]);
  }
  const origin = new URL(config.expectedOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== config.expectedOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error('expectedOrigin must be one exact HTTPS origin');
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
  sourceRef = 'main',
  fresh,
  image,
  checkOnly,
}) {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{64}$/u.test(build.buildId))
    throw new Error('Invalid release identity');
  remoteDirectory(releaseDirectory, 'releaseDirectory');
  sourceRef = validateSourceRef(sourceRef);
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
    '--source-ref',
    sourceRef,
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
  const checkCi = dependencies.checkCi ?? ((input) => requireCi(input, execute));
  const fingerprint = dependencies.fingerprint ?? buildFingerprint;
  const log = dependencies.log ?? console.log;
  const configuration = path.resolve(options.config ?? '.local/oracle-release.json');
  const config = validateConfig(await readJson(configuration), path.dirname(configuration));
  const sourceRef = validateSourceRef(options.sourceRef ?? config.sourceRef);
  for (const key of ['identityFile', 'knownHostsFile'])
    if (!(await stat(config[key])).isFile())
      throw new Error(`${key} must be an existing private file`);
  const ssh = dependencies.ssh ?? openSsh('ssh'),
    scp = dependencies.scp ?? openSsh('scp');
  const sshArgs = sshOptions(config);
  if (options.status || options['cleanup-plan']) {
    if (options.runId && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.runId))
      throw new Error('Invalid run ID');
    const script = await readFile(
      path.join(root, options['cleanup-plan'] ? 'deploy/oracle_gc.py' : 'deploy/oracle-status.py'),
      'utf8'
    );
    const command = [
      'python3',
      '-c',
      script,
      config.appDirectory,
      config.releaseRoot,
      options.runId ?? '',
    ]
      .map(
        (value) =>
          // Python source is trusted repository code, not a remote user argument.
          `'${value.replaceAll("'", "'\\''")}'`
      )
      .join(' ');
    const result = requireSuccess(
      await execute(ssh, [...sshArgs, config.host, command], {
        timeoutMs: 30_000,
        signal: options.signal,
      }),
      'Oracle status'
    );
    return JSON.parse(result.output);
  }
  const git = async (...args) =>
    requireSuccess(
      await execute('git', args, { timeoutMs: 30_000, signal: options.signal }),
      'git'
    ).output.trim();
  const commit = await git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Git HEAD unavailable');
  const dirty = Boolean(await git('status', '--porcelain'));
  const runId = `${newId()}-${commit.slice(0, 7)}`;
  const releaseDirectory = `${config.releaseRoot}/${runId}`;
  const summary = {
    schema: 2,
    status: 'FAIL',
    commit,
    sourceRef,
    runId,
    mode: options.fresh ? 'fresh' : 'update',
    imageSource: options.image ?? 'remote-build',
    host: config.host,
    publicOrigin: config.expectedOrigin,
    appDirectory: config.appDirectory,
    releaseDirectory,
    startedAt: new Date().toISOString(),
    stages: [],
    limitations: [
      'CI verifies source; host-side HTTPS checks do not prove external-device access or paid-provider behavior.',
    ],
  };
  if (options.plan)
    return {
      ...summary,
      status: 'PLAN',
      dirty,
      remoteContacted: false,
      verification:
        'Exact SHA, full required Quality workflow; no local build/browser/token needed',
    };
  if (dirty) throw new Error('Review and commit local changes before deploying');
  const remoteHead = await git(
    'ls-remote',
    '--exit-code',
    '--heads',
    'origin',
    `refs/heads/${sourceRef}`
  );
  if (remoteHead.split(/\s+/u)[0] !== commit)
    throw new Error(`HEAD must match origin/${sourceRef}`);
  const directory = path.join(
    dependencies.outputRoot ?? path.join(root, 'output/release/oracle'),
    runId
  );
  summary.report = path.join(directory, 'summary.json');
  const persist = () => json(summary.report, summary);
  const stage = async (name, action) => {
    const item = { name, status: 'RUNNING', startedAt: new Date().toISOString() };
    summary.stages.push(item);
    await persist();
    log(`RUN ${name}`);
    try {
      const result = await action();
      item.status = 'PASS';
      return result;
    } catch (error) {
      item.status = 'FAIL';
      item.error = error.message;
      throw error;
    } finally {
      item.finishedAt = new Date().toISOString();
      item.elapsedMs = Date.parse(item.finishedAt) - Date.parse(item.startedAt);
      await persist();
      log(`${item.status} ${name} (${item.elapsedMs}ms)`);
    }
  };
  let remoteStarted = false;
  try {
    summary.ci = await stage('ci-verification', () =>
      checkCi({ commit, branch: sourceRef, signal: options.signal })
    );
    if (summary.ci.status !== 'PASS' || summary.ci.commit !== commit)
      throw new Error('CI identity mismatch');
    const input = await fingerprint();
    const build = { buildId: input.hash };
    summary.buildId = build.buildId;
    const sshRun = (text, name, timeoutMs = 60_000) =>
      execute(ssh, [...sshArgs, config.host, text], {
        timeoutMs,
        signal: options.signal,
        log: path.join(directory, `${name}.log`),
        progress:
          name === 'remote-release'
            ? (line) => {
                if (line.startsWith('ORACLE_STAGE ')) log(line);
              }
            : undefined,
      });
    await stage('stage-runner', async () => {
      for (const name of remoteFiles)
        if (!(await stat(path.join(root, name))).isFile())
          throw new Error(`Missing runner: ${name}`);
      requireSuccess(
        await sshRun(
          ['mkdir', '-p', '--', `${releaseDirectory}/deploy`, `${releaseDirectory}/scripts`]
            .map(shellQuote)
            .join(' '),
          'stage-directories'
        ),
        'Create release directories'
      );
      for (const folder of ['deploy', 'scripts'])
        requireSuccess(
          await execute(
            scp,
            [
              ...sshArgs,
              ...remoteFiles
                .filter((name) => name.startsWith(folder + '/'))
                .map((name) => path.join(root, name)),
              `${config.host}:${releaseDirectory}/${folder}/`,
            ],
            {
              timeoutMs: 60_000,
              signal: options.signal,
              log: path.join(directory, `stage-${folder}.log`),
            }
          ),
          `Stage ${folder}`
        );
    });
    if (
      (await git('rev-parse', 'HEAD')) !== commit ||
      (await git('status', '--porcelain')) ||
      (await fingerprint()).hash !== input.hash
    )
      throw new Error('Source changed after CI lookup; remote release was not executed');
    await stage(options['check-only'] ? 'prepare-image' : 'deploy', async () => {
      const command = remoteCommand({
        config,
        commit,
        build,
        releaseDirectory,
        origin: config.expectedOrigin,
        sourceRef,
        fresh: options.fresh,
        image: options.image,
        checkOnly: options['check-only'],
      });
      remoteStarted = true;
      const result = await sshRun(command, 'remote-release', 1_200_000);
      summary.remote = parseRemoteSummary(result.output);
      requireSuccess(result, 'Oracle runner');
      const remote = summary.remote;
      if (
        remote.status !== 'PASS' ||
        remote.commit !== commit ||
        remote.sourceRef !== sourceRef ||
        remote.buildId !== build.buildId ||
        remote.mode !== summary.mode ||
        remote.checkOnly !== Boolean(options['check-only'])
      )
        throw new Error('Remote release identity or outcome mismatch');
      if (remote.publicOrigin !== config.expectedOrigin)
        throw new Error('Remote public origin mismatch');
      if (!options['check-only'] && (remote.smoke?.status !== 'PASS' || remote.writes !== 'OPEN'))
        throw new Error('Host HTTPS/API smoke or write reopening not confirmed');
      summary.smoke = remote.smoke;
    });
    summary.status = 'PASS';
  } catch (error) {
    summary.error = error.message;
    if (remoteStarted && !summary.remote) summary.remoteState = 'UNKNOWN';
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.elapsedMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
    await persist();
    log(`Oracle release ${summary.status}. Report: ${summary.report}`);
  }
  return summary;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), {
      values: ['config', 'image', 'source-ref', 'run-id'],
      flags: ['fresh', 'check-only', 'plan', 'status', 'cleanup-plan', 'help'],
    });
    if (options.help)
      console.log(
        'release:oracle -- [--config path] [--source-ref main] [--image reference] [--check-only | --plan | --cleanup-plan | --status [--run-id id]]'
      );
    else {
      if (
        [options.plan, options.status, options['check-only'], options['cleanup-plan']].filter(
          Boolean
        ).length > 1 ||
        (options['run-id'] && !options.status) ||
        ((options.status || options['cleanup-plan']) && (options.fresh || options.image))
      )
        throw new Error('Conflicting Oracle modes');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await releaseOracle({
          ...options,
          sourceRef: options['source-ref'],
          runId: options['run-id'],
          signal: controller.signal,
        });
        if (options.plan || options.status || options['cleanup-plan'])
          console.log(JSON.stringify(result, null, 2));
        process.exitCode = ['PASS', 'PLAN', 'STATUS'].includes(result.status) ? 0 : 1;
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
