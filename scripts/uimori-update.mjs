import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readJournal, requestCancel, runUpdate, validateConfig } from './update-controller.mjs';

/**
 * Operator entry point for one Compose update. Verification belongs to a real Docker host;
 * this file only wires the injected effects to the local Docker CLI and fetch.
 */
function options(argv) {
  const parsed = { command: argv[0] ?? 'status' };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error('Use --config <path>, --image <reference> and --key <request key>');
    parsed[key.slice(2)] = value;
  }
  if (!['start', 'status', 'cancel'].includes(parsed.command))
    throw new Error('Commands are start, status and cancel');
  if (!parsed.config) throw new Error('Pass --config with the update configuration file');
  return parsed;
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`docker ${args[0]} failed to start: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `docker ${args[0]} exited ${result.status}: ${result.stderr.trim().slice(0, 500)}`
    );
  return `${result.stdout}${result.stderr}`;
}

async function http(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null,
  };
}

const parsed = options(process.argv.slice(2));
const raw = JSON.parse(readFileSync(path.resolve(parsed.config), 'utf8'));
const config = validateConfig({ ...raw, ...(parsed.image ? { image: parsed.image } : {}) });
if (parsed.command === 'status') {
  const journal = readJournal(config);
  console.log(JSON.stringify(journal ?? { status: 'none' }, null, 2));
} else if (parsed.command === 'cancel') {
  console.log(JSON.stringify(requestCancel(config, parsed.key ?? ''), null, 2));
} else {
  const token = process.env.NR_ACCESS_TOKEN;
  if (!token) throw new Error('Set NR_ACCESS_TOKEN in the environment for the update session');
  const summary = await runUpdate({
    config,
    requestKey: parsed.key ?? '',
    io: {
      docker,
      http,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      accessToken: () => token,
    },
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== 'completed') process.exitCode = 1;
}
