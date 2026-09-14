import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One bounded update transition for a Compose install: prepare, close admission, drain, stop,
 * back up, verify a candidate, switch, reopen. Docker and HTTP are injected so the decision
 * logic runs without either. The app's own maintenance gate owns admission; this controller
 * owns the image, the volume and the point of no return.
 */
export const STAGES = [
  'prepare',
  'close',
  'drain',
  'stop',
  'backup',
  'candidate',
  'switch',
  'reopen',
];
/** Automatic rollback is allowed only while no user write has been accepted on the new image. */
const CUTOVER = 'switch';
const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/iu;
const DIGEST = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;
const TAG = /^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]{0,127}$/u;

export class UpdateError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'UpdateError';
    this.stage = stage;
  }
}

export function validateConfig(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const required = ['composeFile', 'envFile', 'releaseRoot', 'dataVolume', 'image', 'appOrigin'];
  for (const key of required)
    if (typeof value[key] !== 'string' || !value[key].trim())
      throw new UpdateError('prepare', `Configuration needs a ${key}`);
  const composeFile = path.resolve(value.composeFile);
  const envFile = path.resolve(value.envFile);
  const releaseRoot = path.resolve(value.releaseRoot);
  const appService = value.appService ?? 'app';
  if (!NAME.test(appService) || !NAME.test(value.dataVolume))
    throw new UpdateError('prepare', 'Service and volume names must be plain Docker names');
  if (!DIGEST.test(value.image) && !TAG.test(value.image))
    throw new UpdateError('prepare', 'The image must be a full reference with a digest or tag');
  const projectDirectory = path.dirname(composeFile);
  const within = path.relative(projectDirectory, releaseRoot);
  if (!within || (!within.startsWith('..') && !path.isAbsolute(within)))
    throw new UpdateError('prepare', 'The release root must stay outside the project directory');
  if (
    !/^https:\/\/[^/]+$/u.test(value.appOrigin) &&
    !/^http:\/\/127\.0\.0\.1(:\d+)?$/u.test(value.appOrigin)
  )
    throw new UpdateError('prepare', 'The app origin must be an exact HTTPS origin or loopback');
  return {
    composeFile,
    envFile,
    releaseRoot,
    projectDirectory,
    appService,
    dataVolume: value.dataVolume,
    image: value.image,
    appOrigin: value.appOrigin,
    drainTimeoutMs: Number.isFinite(value.drainTimeoutMs) ? value.drainTimeoutMs : 30 * 60_000,
  };
}

/** Replaces only the named keys and keeps every other byte of the environment file. */
export function updateEnvironment(text, values) {
  const lines = text.split('\n');
  const remaining = new Map(Object.entries(values));
  const next = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  const tail = [...remaining].map(([key, value]) => `${key}=${value}`);
  if (!tail.length) return next.join('\n');
  const body = next.join('\n');
  return `${body}${body.endsWith('\n') ? '' : '\n'}${tail.join('\n')}\n`;
}

export const journalPath = (config) => path.join(config.releaseRoot, 'update-journal.json');

export function readJournal(config) {
  try {
    const value = JSON.parse(readFileSync(journalPath(config), 'utf8'));
    return value && value.version === 1 ? value : null;
  } catch {
    return null;
  }
}

function saveJournal(config, journal) {
  mkdirSync(config.releaseRoot, { recursive: true });
  writeFileSync(journalPath(config), `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

export function requestCancel(config, requestKey) {
  const journal = readJournal(config);
  if (!journal || journal.requestKey !== requestKey)
    throw new UpdateError('cancel', 'No update with that request key is in progress');
  // Once the new image serves writes, reversing it is a recovery decision, not a cancel.
  if (journal.stages.some((stage) => stage.name === CUTOVER && stage.status === 'done'))
    throw new UpdateError('cancel', 'The new image already serves writes; use a recovery instead');
  if (journal.status !== 'running') return journal;
  return saveJournal(config, { ...journal, cancelRequested: true });
}

/** The app's gate answers admission; the controller never guesses from container state alone. */
async function appSession(io, config) {
  const token = io.accessToken();
  const login = await io.http(`${config.appOrigin}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: config.appOrigin },
    body: JSON.stringify({ token }),
  });
  if (!login.ok)
    throw new UpdateError('close', `The app refused the access token (${login.status})`);
  const cookie = login.cookie;
  if (!cookie) throw new UpdateError('close', 'The app returned no session cookie');
  return {
    maintenance: async (status) => {
      const response = await io.http(`${config.appOrigin}/api/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: config.appOrigin, Cookie: cookie },
        body: JSON.stringify({ status, reason: 'update' }),
      });
      if (!response.ok)
        throw new UpdateError('close', `The app refused the gate change (${response.status})`);
      return response.body;
    },
    status: async () => {
      const response = await io.http(`${config.appOrigin}/api/maintenance`, {
        headers: { Cookie: cookie, Origin: config.appOrigin },
      });
      if (!response.ok)
        throw new UpdateError('drain', `The app did not report its gate (${response.status})`);
      return response.body;
    },
  };
}

export async function runUpdate({ config: raw, requestKey, io }) {
  const config = validateConfig(raw);
  if (typeof requestKey !== 'string' || !/^[\w.-]{8,100}$/u.test(requestKey))
    throw new UpdateError('prepare', 'The request key must be 8-100 plain characters');
  const existing = readJournal(config);
  // The same key never updates twice; a finished transition returns its own receipt.
  if (existing && existing.requestKey === requestKey && existing.status !== 'running')
    return existing;
  if (existing && existing.requestKey !== requestKey && existing.status === 'running')
    throw new UpdateError('prepare', 'Another update is still running');
  let journal = saveJournal(config, {
    version: 1,
    requestKey,
    status: 'running',
    startedAt: io.now(),
    image: config.image,
    dataVolume: config.dataVolume,
    stages: [],
    rollback: 'NOT_NEEDED',
  });
  let running = 'prepare';
  const record = (name, status, detail) => {
    if (status === 'running') running = name;
    journal = saveJournal(config, {
      ...journal,
      ...(cancelled() ? { cancelRequested: true } : {}),
      stages: [
        ...journal.stages.filter((stage) => stage.name !== name),
        { name, status, at: io.now(), ...(detail ? { detail } : {}) },
      ],
    });
  };
  // A cancel is written straight to the journal file; keep it once observed and once saved.
  let cancelRequested = false;
  const cancelled = () => {
    cancelRequested ||= readJournal(config)?.cancelRequested === true;
    return cancelRequested;
  };
  const compose = (...args) =>
    io.docker([
      'compose',
      '--project-directory',
      config.projectDirectory,
      '-f',
      config.composeFile,
      '--env-file',
      config.envFile,
      ...args,
    ]);
  const id = `${requestKey}-${createHash('sha256').update(`${requestKey}:${config.image}`).digest('hex').slice(0, 12)}`;
  const candidateVolume = `${config.dataVolume}-${id}`.slice(0, 63);
  const backup = path.join(config.releaseRoot, `${id}.tar`);
  const originalEnv = readFileSync(config.envFile, 'utf8');
  let app;
  try {
    record('prepare', 'running');
    const inspected = io.docker([
      'image',
      'inspect',
      '--format',
      '{{index .RepoDigests 0}}',
      config.image,
    ]);
    record('prepare', 'done', {
      candidate: inspected.trim(),
      previousEnvSha256: createHash('sha256').update(originalEnv).digest('hex'),
    });
    if (cancelled()) throw new UpdateError('prepare', 'Cancelled before any change');

    record('close', 'running');
    app = await appSession(io, config);
    await app.maintenance('closed');
    record('close', 'done');

    record('drain', 'running');
    const deadline = io.now() + config.drainTimeoutMs;
    for (;;) {
      const state = await app.status();
      if (!state.activeWork) break;
      if (cancelled()) throw new UpdateError('drain', 'Cancelled while draining');
      if (io.now() > deadline)
        throw new UpdateError('drain', 'Work did not settle before the deadline');
      await io.sleep(5_000);
    }
    record('drain', 'done');
    if (cancelled()) throw new UpdateError('drain', 'Cancelled before stopping the app');

    record('stop', 'running');
    compose('stop', config.appService);
    record('stop', 'done');

    record('backup', 'running');
    io.docker([
      'run',
      '--rm',
      '-v',
      `${config.dataVolume}:/data:ro`,
      '-v',
      `${config.releaseRoot}:/backup`,
      config.image,
      'tar',
      '-cf',
      `/backup/${path.basename(backup)}`,
      '-C',
      '/data',
      '.',
    ]);
    io.docker([
      'run',
      '--rm',
      '-v',
      `${config.releaseRoot}:/backup:ro`,
      config.image,
      'tar',
      '-tf',
      `/backup/${path.basename(backup)}`,
    ]);
    record('backup', 'done', { archive: backup });

    record('candidate', 'running');
    io.docker(['volume', 'create', candidateVolume]);
    io.docker([
      'run',
      '--rm',
      '-v',
      `${candidateVolume}:/data`,
      '-v',
      `${config.releaseRoot}:/backup:ro`,
      config.image,
      'tar',
      '-xf',
      `/backup/${path.basename(backup)}`,
      '-C',
      '/data',
    ]);
    const probe = io.docker([
      'run',
      '--rm',
      '-e',
      'NR_MAINTENANCE=1',
      '-e',
      'NR_DB=/data/narrative.sqlite',
      '-v',
      `${candidateVolume}:/data`,
      config.image,
    ]);
    if (!probe.includes('"event":"ready"'))
      throw new UpdateError('candidate', 'The candidate did not finish migration and read health');
    record('candidate', 'done', { volume: candidateVolume });
    if (cancelled()) throw new UpdateError('candidate', 'Cancelled before the switch');

    record('switch', 'running');
    writeFileSync(
      config.envFile,
      updateEnvironment(originalEnv, {
        UIMORI_IMAGE: config.image,
        UIMORI_DATA_VOLUME: candidateVolume,
      })
    );
    compose('up', '-d', config.appService);
    const health = await io.http(`${config.appOrigin}/api/session`, {
      headers: { Origin: config.appOrigin },
    });
    if (!health.ok)
      throw new UpdateError('switch', `The new image did not answer (${health.status})`);
    record('switch', 'done');

    record('reopen', 'running');
    app = await appSession(io, config);
    await app.maintenance('open');
    record('reopen', 'done');
    return saveJournal(config, { ...journal, status: 'completed', finishedAt: io.now() });
  } catch (error) {
    // A raw failure still belongs to the stage that was running, never to an unnamed step.
    const failure =
      error instanceof UpdateError
        ? error
        : new UpdateError(running, error instanceof Error ? error.message : String(error));
    const done = (name) =>
      journal.stages.some((stage) => stage.name === name && stage.status === 'done');
    record(failure.stage, 'failed', { message: failure.message });
    let rollback = 'NOT_NEEDED';
    if (!done(CUTOVER) && (done('stop') || done('switch'))) {
      try {
        writeFileSync(config.envFile, originalEnv);
        compose('up', '-d', config.appService);
        rollback = 'DONE';
      } catch {
        rollback = 'FAILED';
      }
    }
    if (!done(CUTOVER) && done('close') && rollback !== 'FAILED') {
      try {
        (app ?? (await appSession(io, config))).maintenance('open');
      } catch {
        rollback = rollback === 'DONE' ? 'PARTIAL' : 'PARTIAL';
      }
    }
    return saveJournal(config, {
      ...journal,
      ...(cancelRequested ? { cancelRequested: true } : {}),
      status: cancelRequested ? 'cancelled' : 'failed',
      error: failure.message,
      failedStage: failure.stage,
      rollback,
      finishedAt: io.now(),
    });
  }
}
