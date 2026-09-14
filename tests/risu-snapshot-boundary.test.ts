import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The RisuAI snapshot is GPL-3.0 code kept behind a compat layer. These rules keep it that way:
// snapshot code never reaches into Uimori, and Uimori reaches the snapshot only through
// server/compat/risu. Tests may import the snapshot directly to pin its behavior.
const root = fileURLToPath(new URL('../', import.meta.url));
const SNAPSHOT_ROOT = 'third_party/risuai';
const COMPAT_LAYER = 'server/compat/risu';
const specifier = /^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm;

function walk(dir: string, out: string[] = []): string[] {
  const absolute = join(root, dir);
  if (!statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function specifiers(file: string): string[] {
  return [...readFileSync(join(root, file), 'utf8').matchAll(specifier)].map((match) => match[1]);
}

function resolveRelative(file: string, spec: string): string {
  return relative(root, resolve(dirname(join(root, file)), spec)).replaceAll('\\', '/');
}

const snapshotDirs = walk(SNAPSHOT_ROOT)
  .map((file) => file.split('/').slice(0, 3).join('/'))
  .filter((dir, index, all) => all.indexOf(dir) === index);

test('snapshot code imports nothing from Uimori', () => {
  for (const file of walk(SNAPSHOT_ROOT))
    for (const spec of specifiers(file)) {
      if (!spec.startsWith('.')) continue;
      expect(resolveRelative(file, spec), `${file} imports ${spec}`).toMatch(
        new RegExp(`^${SNAPSHOT_ROOT}/`)
      );
    }
});

test('only the compat layer and tests import the snapshot', () => {
  for (const dir of ['core', 'server', 'web', 'scripts'])
    for (const file of walk(dir)) {
      if (file.startsWith(`${COMPAT_LAYER}/`)) continue;
      for (const spec of specifiers(file))
        expect(
          spec.startsWith('.') && resolveRelative(file, spec).startsWith(`${SNAPSHOT_ROOT}/`),
          `${file} imports the snapshot directly: ${spec}`
        ).toBe(false);
    }
});

test('every snapshot directory carries its license and manifest, and every file is listed', () => {
  for (const dir of snapshotDirs) {
    const manifest = JSON.parse(readFileSync(join(root, dir, 'SNAPSHOT.json'), 'utf8')) as {
      upstream: { commit: string; licenseFile: string };
      files: { path: string; upstreamSha256: Record<string, string> }[];
    };
    expect(dir.endsWith(`/${manifest.upstream.commit.slice(0, 8)}`)).toBe(true);
    expect(statSync(join(root, dir, manifest.upstream.licenseFile)).isFile()).toBe(true);
    const listed = new Set(manifest.files.map((file) => `${dir}/${file.path}`));
    for (const file of walk(dir)) {
      expect(listed.has(file), `${file} is missing from ${dir}/SNAPSHOT.json`).toBe(true);
      const header = readFileSync(join(root, file), 'utf8').slice(0, 600);
      expect(header, `${file} lacks an SPDX identifier`).toMatch(/SPDX-License-Identifier:/);
      expect(header, `${file} does not name the upstream commit`).toContain(
        manifest.upstream.commit
      );
    }
    for (const file of manifest.files) {
      expect(statSync(join(root, dir, file.path)).isFile()).toBe(true);
      for (const digest of Object.values(file.upstreamSha256))
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  }
});
