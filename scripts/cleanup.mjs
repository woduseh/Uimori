import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { artifactRoot, ownedPath, removeOwned, json } from './lib.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const runs = [];
    if (existsSync(artifactRoot)) for (const id of await readdir(artifactRoot)) {
      const file = path.join(artifactRoot, id, 'ownership.json');
      if (existsSync(file)) { const owner = JSON.parse(await readFile(file, 'utf8')); runs.push({ runId: id, active: owner.active, runtimeExists: existsSync(path.join(artifactRoot, id, 'runtime')), cleanup: owner.cleanup?.status }); }
    }
    console.log(JSON.stringify({ usage: 'npm run cleanup -- --run <run-id>; removes only inactive run runtime, preserves evidence. Active old PIDs require inspection (never killed automatically).', runs }, null, 2));
  } else {
    if (args.length !== 2 || args[0] !== '--run' || !/^[A-Za-z0-9-]+$/.test(args[1])) throw new Error('Usage: npm run cleanup -- --run <run-id>');
    const directory = ownedPath(artifactRoot, path.join(artifactRoot, args[1]));
    const owner = JSON.parse(await readFile(path.join(directory, 'ownership.json'), 'utf8'));
    if (owner.active) throw new Error('Active or interrupted run: inspect recorded process identity first. Refusing to kill old/reused PIDs or remove live DB.');
    if (owner.directory !== directory || owner.runId !== args[1]) throw new Error('Ownership manifest mismatch');
    const runtime = path.join(directory, 'runtime'); await removeOwned(directory, runtime);
    const cleanup = { status: 'PASS', runId: args[1], removed: runtime, evidencePreserved: true, noProcessKilled: true, at: new Date().toISOString() };
    await json(path.join(directory, 'manual-cleanup.json'), cleanup); console.log(JSON.stringify(cleanup, null, 2));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
