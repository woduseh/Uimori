import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function docsOnly(files) {
  return (
    files.length > 0 &&
    files.every((file) => /^(?:docs\/[^\r\n]+\.md|README\.md|AGENTS\.md|LICENSE)$/.test(file))
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let docs = false;
  const base = process.env.UIMORI_DIFF_BASE;
  if (
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' &&
    /^[a-f0-9]{40}$/.test(base ?? '') &&
    !/^0+$/.test(base)
  ) {
    try {
      const files = execFileSync('git', ['diff', '--name-only', '-z', base, 'HEAD'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
      docs = docsOnly(files);
    } catch {
      // Missing history must run the full checks, never silently skip them.
    }
  }
  const result = `docs_only=${docs}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, result);
  process.stdout.write(result);
}
