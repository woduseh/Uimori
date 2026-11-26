import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { versionChanged } from '../scripts/ci-changes.mjs';

const missing = /^0+$/u;

export function pushRefusals(lines, { remote, env = process.env, cwd = process.cwd() }) {
  if (env.UIMORI_ALLOW_RELEASE === '1') return [];
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const comparedWith = (localSha, remoteSha) => {
    if (remoteSha && !missing.test(remoteSha)) return remoteSha;
    for (const ref of [
      `refs/remotes/${remote}/HEAD`,
      `refs/remotes/${remote}/main`,
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]) {
      try {
        return git('merge-base', localSha, ref).trim();
      } catch {}
    }
    return null;
  };
  const refusals = [];
  for (const line of lines) {
    const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/u);
    if (remoteRef?.startsWith('refs/tags/')) {
      refusals.push(`${remoteRef}: pushing or deleting a tag publishes a release`);
      continue;
    }
    if (!localSha || missing.test(localSha)) continue;
    const base = comparedWith(localSha, remoteSha);
    if (!base) continue;
    try {
      if (versionChanged((revision) => git('show', `${revision}:package.json`), base, localSha))
        refusals.push(`${remoteRef}: the push changes the package.json version`);
    } catch {}
  }
  return refusals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refusals = pushRefusals(readFileSync(0, 'utf8').split('\n').filter(Boolean), {
    remote: process.argv[2],
  });
  if (refusals.length) {
    for (const refusal of refusals) console.error(`pre-push: ${refusal}`);
    console.error(
      'A release push is the user\'s to make: set UIMORI_ALLOW_RELEASE=1 for a release you started yourself.'
    );
    process.exit(1);
  }
}
