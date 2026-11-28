import ignore from '@balena/dockerignore';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFingerprint } from './lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shown = 8;

export function contextErrors(files, dockerignore) {
  if (!files.length) return ['the build fingerprint counts no files'];
  const rules = ignore().add(dockerignore);
  const excluded = files.filter((file) => rules.ignores(file));
  if (!excluded.length) return [];
  return [
    `${excluded.length} file(s) are counted by the build fingerprint (scripts/lib.mjs) but excluded from the Docker build context by .dockerignore, so the image cannot contain them and the Oracle image check would fail with "Image build identity or artifact hash mismatch". Re-include them in .dockerignore or stop counting them in buildFingerprint:`,
    ...excluded.slice(0, shown).map((file) => `  ${file}`),
    ...(excluded.length > shown ? [`  ... and ${excluded.length - shown} more`] : []),
  ];
}

export async function buildContextErrors(sourceRoot = root) {
  const { files } = await buildFingerprint(sourceRoot);
  return contextErrors(files, readFileSync(path.join(sourceRoot, '.dockerignore'), 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await buildContextErrors();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
}
