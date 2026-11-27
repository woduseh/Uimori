import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { docsOnly, windowsSensitive } from './change-classifier.mjs';
import { browserShards } from './ci-summary.mjs';
import { readFeatureMap, selectChanged } from './feature-map.mjs';

export { docsOnly, windowsSensitive };

export function versionChanged(packageJsonAt, base, head = 'HEAD') {
  return JSON.parse(packageJsonAt(base)).version !== JSON.parse(packageJsonAt(head)).version;
}

function runsInChangedJob(entry) {
  const launch = entry.launch ?? {};
  return launch.runner !== 'self-host' && !(launch.requiredEnv ?? []).length;
}

export function browserSelection(map, files) {
  const { domains, uncovered } = selectChanged(map, files);
  const runnable = (name) => map.domains[name].specs.filter(runsInChangedJob);
  const selected = domains.filter((name) => runnable(name).length);
  const specs = new Set(selected.flatMap((name) => runnable(name).map((entry) => entry.file))).size;
  const total = Object.values(map.domains).reduce((sum, domain) => sum + domain.specs.length, 0);
  const cap = Math.ceil(total / browserShards);
  const full = specs > cap || uncovered.length > 0;
  return { domains: full ? [] : selected, specs, cap, uncovered, full };
}

export function selectionSummary(selection) {
  if (selection.uncovered.length)
    return `No feature-map domain covers ${selection.uncovered.join(', ')}; running the full browser shards`;
  return `Changed browser specs: ${selection.specs} of cap ${selection.cap}; ${selection.full ? 'running the full browser shards' : `domains: ${selection.domains.join(' ') || 'none'}`}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.GITHUB_EVENT_NAME;
  let docs = false;
  let windows = true;
  let files;
  let fullBrowser = event === 'workflow_dispatch' && process.env.UIMORI_BROWSER_INPUT === 'true';
  let browserDomains = [];
  const base = process.env.UIMORI_DIFF_BASE;
  if (event !== 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(base ?? '') && !/^0+$/.test(base)) {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
    try {
      files = git('diff', '--no-renames', '--name-only', '-z', base, 'HEAD')
        .split('\0')
        .filter(Boolean);
      docs = docsOnly(files);
      windows = windowsSensitive(files);
    } catch {}
    try {
      fullBrowser = versionChanged((revision) => git('show', `${revision}:package.json`), base);
    } catch {
      fullBrowser = !docs;
    }
  }
  if (event === 'pull_request' && !docs && !fullBrowser) {
    const selection = files
      ? browserSelection(readFeatureMap(), files)
      : { domains: [], full: true };
    if (files) console.log(selectionSummary(selection));
    fullBrowser = selection.full;
    browserDomains = selection.domains;
  }
  const result = `docs_only=${docs}\nfull_browser=${fullBrowser}\nwindows_sensitive=${windows}\nbrowser_domains=${browserDomains.join(' ')}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, result);
  process.stdout.write(result);
}
