import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function docsOnly(files) {
  return (
    files.length > 0 &&
    files.every((file) =>
      /^(?:docs\/(?:dev|plans|releases)\/[^\r\n]+\.md|README(?:\.ko)?\.md|AGENTS\.md|LICENSE)$/.test(
        file
      )
    )
  );
}

export function versionChanged(packageJsonAt, base, head = 'HEAD') {
  return JSON.parse(packageJsonAt(base)).version !== JSON.parse(packageJsonAt(head)).version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let docs = false;
  let fullBrowser =
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    process.env.UIMORI_BROWSER_INPUT === 'true';
  const base = process.env.UIMORI_DIFF_BASE;
  if (
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' &&
    /^[a-f0-9]{40}$/.test(base ?? '') &&
    !/^0+$/.test(base)
  ) {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
    try {
      docs = docsOnly(
        git('diff', '--no-renames', '--name-only', '-z', base, 'HEAD').split('\0').filter(Boolean)
      );
    } catch {}
    try {
      fullBrowser = versionChanged((revision) => git('show', `${revision}:package.json`), base);
    } catch {
      fullBrowser = !docs;
    }
  }
  const result = `docs_only=${docs}\nfull_browser=${fullBrowser}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, result);
  process.stdout.write(result);
}
