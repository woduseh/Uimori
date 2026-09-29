import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

export function documentationErrors(directory = root) {
  const broken = [];
  const files = [
    ...['README.md', 'AGENTS.md'].map((file) => resolve(directory, file)),
    ...markdownFiles(resolve(directory, 'docs')),
  ];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu)) {
      if (/^(?:https?:|mailto:|#)/u.test(match[1])) continue;
      const path = decodeURIComponent(match[1].split('#')[0]);
      if (!existsSync(resolve(dirname(file), path))) broken.push(`${file}: ${match[1]}`);
    }
  }
  for (const file of readdirSync(resolve(directory, 'scripts')).filter(
    (name) => name.startsWith('verify-') && name.endsWith('.mjs')
  )) {
    for (const match of readFileSync(resolve(directory, 'scripts', file), 'utf8').matchAll(
      /['"](tests\/[^'"`$]+\.(?:test\.ts|spec\.ts))['"]/gu
    )) {
      if (!existsSync(resolve(directory, match[1]))) broken.push(`${file}: ${match[1]}`);
    }
  }
  return broken;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broken = documentationErrors();
  if (broken.length) {
    console.error(broken.join('\n'));
    process.exitCode = 1;
  } else console.log('Documentation links and verification entry points PASS');
}
