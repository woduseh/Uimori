#!/usr/bin/env node
// Report-only comparison between the RisuAI snapshot manifest and a local RisuAI checkout.
// It never edits the snapshot; whether to adopt an upstream change stays a human decision.
//
//   node scripts/risu-vendor-diff.mjs --risu /path/to/RisuAI [--ref HEAD] [--snapshot third_party/risuai/cad8595a]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  args.set(process.argv[index], process.argv[index + 1]);
const risu = args.get('--risu');
const ref = args.get('--ref') ?? 'HEAD';
const snapshot = args.get('--snapshot') ?? 'third_party/risuai/cad8595a';
if (!risu || !existsSync(join(risu, '.git'))) {
  console.error('usage: node scripts/risu-vendor-diff.mjs --risu <RisuAI checkout> [--ref HEAD]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(snapshot, 'SNAPSHOT.json'), 'utf8'));
const show = (path) => {
  try {
    return execFileSync('git', ['-C', risu, 'show', `${ref}:${path}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

console.log(`snapshot ${manifest.upstream.commit.slice(0, 8)} vs ${risu} @ ${ref}`);
let changed = 0;
for (const file of manifest.files) {
  for (const [upstreamPath, recorded] of Object.entries(file.upstreamSha256)) {
    const bytes = show(upstreamPath);
    const status = bytes === null ? 'MISSING' : sha256(bytes) === recorded ? 'same' : 'CHANGED';
    if (status !== 'same') changed += 1;
    console.log(`${status.padEnd(8)} ${file.path.padEnd(28)} ${upstreamPath}`);
  }
}
console.log(
  changed ? `${changed} upstream source(s) differ; review before adopting.` : 'no upstream change.'
);
