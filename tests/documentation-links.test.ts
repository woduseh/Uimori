import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

test('README and current guides link to existing local files', () => {
  const files = [
    'README.md',
    ...readdirSync(resolve(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `docs/${name}`),
  ];
  const broken: string[] = [];
  for (const file of files) {
    const content = readFileSync(resolve(root, file), 'utf8');
    for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/gu)) {
      if (/^(?:https?:|mailto:|#)/u.test(match[1])) continue;
      const path = decodeURIComponent(match[1].split('#')[0]);
      if (!existsSync(resolve(root, dirname(file), path))) broken.push(`${file}: ${match[1]}`);
    }
  }
  expect(broken).toEqual([]);
});

test('verification entry points reference existing test files', () => {
  const broken: string[] = [];
  for (const file of readdirSync(resolve(root, 'scripts')).filter(
    (name) => name.startsWith('verify-') && name.endsWith('.mjs')
  )) {
    for (const match of readFileSync(resolve(root, 'scripts', file), 'utf8').matchAll(
      /['"](tests\/[^'"`$]+\.(?:test\.ts|spec\.ts))['"]/gu
    )) {
      if (!existsSync(resolve(root, match[1]))) broken.push(`${file}: ${match[1]}`);
    }
  }
  expect(broken).toEqual([]);
});
