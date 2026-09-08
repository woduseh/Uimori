import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const biomeCli = join(projectRoot, 'node_modules/@biomejs/biome/bin/biome');
// Biome ignores fixture files when the project root is only an alias of the
// real directory (macOS /var -> /private/var, Windows 8.3 short names), so
// resolve the temporary directory before creating the fixture project.
let temporaryRoot: string;
let fixtureRoot: string;
type Sample = { source: string; forbidden: boolean };
type BiomeReport = {
  summary: {
    unchanged: number;
    skipped: number;
    errors: number;
    warnings: number;
    diagnosticsNotPrinted: number;
  };
  diagnostics: { category: string; severity: string; location?: { start?: { line: number } } }[];
};

beforeAll(() => {
  temporaryRoot = realpathSync(tmpdir());
  fixtureRoot = mkdtempSync(join(temporaryRoot, 'uimori-architecture-'));
  const configuration = JSON.parse(readFileSync(join(projectRoot, 'biome.json'), 'utf8'));
  // Keep the actual rules, overrides and file filters. Only disable Git discovery
  // because the temporary fixture project is outside the user's repository.
  writeFileSync(
    join(fixtureRoot, 'biome.json'),
    JSON.stringify({ ...configuration, vcs: { enabled: false } })
  );
});

afterAll(() => {
  if (!fixtureRoot) return;
  const child = relative(temporaryRoot, resolve(fixtureRoot));
  if (isAbsolute(child) || !/^uimori-architecture-[^/\\]+$/.test(child)) {
    throw new Error(`Refusing cleanup outside the temporary fixture scope: ${fixtureRoot}`);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

// Biome 2.5 stdin lint does not expose these non-fixable diagnostics. Use real
// files exclusively in an isolated temporary project and request JSON output.
function checkImports(fixturePath: string, samples: Sample[]) {
  const fixture = `${samples.map(({ source }) => source).join('\n')}\n`;
  const expectedLines = samples.flatMap(({ forbidden }, index) => (forbidden ? [index + 1] : []));
  const target = resolve(fixtureRoot, fixturePath);
  const child = relative(fixtureRoot, target);
  if (isAbsolute(child) || child.startsWith('..'))
    throw new Error('Fixture escaped its temporary root');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fixture);
  const result = spawnSync(
    process.execPath,
    [
      biomeCli,
      'lint',
      '--only=style/noRestrictedImports',
      `--config-path=${fixtureRoot}`,
      '--error-on-warnings',
      '--max-diagnostics=none',
      '--colors=off',
      '--reporter=json',
      fixturePath,
    ],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }
  );
  if (result.error) throw result.error;
  const details = `${result.stderr}\n${result.stdout}`;
  expect(result.signal, details).toBeNull();
  expect(result.status, details).toBe(expectedLines.length ? 1 : 0);
  const report: BiomeReport = JSON.parse(result.stdout);
  // Configuration errors, parser errors, skipped files and truncated reports
  // must never pass as "zero import violations".
  expect(report.summary, details).toMatchObject({
    unchanged: 1,
    skipped: 0,
    errors: expectedLines.length,
    warnings: 0,
    diagnosticsNotPrinted: 0,
  });
  for (const diagnostic of report.diagnostics) {
    expect(diagnostic, details).toMatchObject({
      category: 'lint/style/noRestrictedImports',
      severity: 'error',
    });
  }
  const actualLines = report.diagnostics
    .map((diagnostic) => diagnostic.location?.start?.line)
    .filter((line): line is number => line !== undefined)
    .sort((left, right) => left - right);
  // Match each offending import's line, not just the error count. Allowed
  // imports alongside forbidden ones must remain free of diagnostics.
  expect(actualLines, details).toEqual(expectedLines);
  expect(readFileSync(target, 'utf8')).toBe(fixture);
}

function boundarySamples(targets: string[], prefix: string): Sample[] {
  return targets.flatMap((target, index) => {
    const specifier = `${prefix}${target}/contract.js`;
    return [
      { source: `import { value as value${index} } from '${specifier}';`, forbidden: true },
      { source: `import type { Shape as Shape${index} } from '${specifier}';`, forbidden: true },
      { source: `export type { Shape as Export${index} } from '${specifier}';`, forbidden: true },
      { source: `void import('${specifier}');`, forbidden: true },
    ];
  });
}

const layers = [
  { layer: 'core', targets: ['server', 'web', 'tests', 'scripts'] },
  { layer: 'server', targets: ['web', 'tests', 'scripts'] },
  { layer: 'web', targets: ['server', 'tests', 'scripts'] },
];

describe('architecture import boundaries (actual Biome configuration)', () => {
  test.each(layers)(
    '$layer rejects forbidden layers including type-only imports',
    ({ layer, targets }) => {
      const allowed: Sample[] = [
        { source: "import { local } from './local.js';", forbidden: false },
        { source: "import type { Local } from './local.js';", forbidden: false },
      ];
      if (layer !== 'core') {
        allowed.push(
          { source: "import { shared } from '../core/shared.js';", forbidden: false },
          { source: "import type { ChatFolder } from '../core/product.js';", forbidden: false },
          { source: "export type { StateModule } from '../core/state.js';", forbidden: false },
          { source: "import type { MemoryEntry } from '../core/memory.js';", forbidden: false }
        );
      }
      if (layer !== 'web') {
        allowed.push(
          { source: "import { createHash } from 'node:crypto';", forbidden: false },
          { source: "import { readFile } from 'fs/promises';", forbidden: false },
          { source: "import { request } from 'undici';", forbidden: false },
          { source: "import { GoogleAuth } from 'google-auth-library';", forbidden: false }
        );
      }
      checkImports(`${layer}/quality-architecture-fixture.ts`, [
        ...boundarySamples(targets, '../'),
        ...allowed,
      ]);
    }
  );

  test.each(layers)('$layer overrides also apply in nested folders', ({ layer, targets }) => {
    checkImports(`${layer}/nested/quality-architecture-fixture.ts`, [
      ...boundarySamples(targets, '../../'),
      { source: "import { local } from '../local.js';", forbidden: false },
    ]);
  });

  test('web rejects Node builtins (with or without node:) and server SDKs, including types', () => {
    const builtins = [...new Set([...builtinModules, 'node:fs', 'node:fs/promises', 'node:test'])];
    const samples: Sample[] = builtins.map((specifier, index) => ({
      source: `import * as builtin${index} from '${specifier}';`,
      forbidden: true,
    }));
    for (const [index, specifier] of [
      'undici',
      'undici/lib/core/util.js',
      'google-auth-library',
      'google-auth-library/build/src/index.js',
    ].entries()) {
      samples.push({ source: `import * as sdk${index} from '${specifier}';`, forbidden: true });
    }
    samples.push(
      { source: "import type { Stats } from 'node:fs';", forbidden: true },
      { source: "export type { Stats as BareStats } from 'fs';", forbidden: true },
      { source: "import { type Client } from 'undici';", forbidden: true },
      { source: "import type { GoogleAuth } from 'google-auth-library';", forbidden: true },
      { source: "void import('node:fs');", forbidden: true },
      { source: "void require('fs');", forbidden: true },
      { source: "export * from 'undici';", forbidden: true },
      { source: "import { type Shape, value } from '../server/mixed.js';", forbidden: true },
      { source: "import { useState } from 'react';", forbidden: false },
      { source: "import type { MemoryEntry } from '../core/memory.js';", forbidden: false },
      { source: "import { parse } from './server-client.js';", forbidden: false }
    );
    checkImports('web/quality-architecture-fixture.tsx', samples);
  });

  test.each(['tests', 'scripts'])('%s may import product code and Node helpers', (layer) => {
    checkImports(`${layer}/quality-architecture-fixture.ts`, [
      { source: "import { shared } from '../core/shared.js';", forbidden: false },
      { source: "import { Store } from '../server/store.js';", forbidden: false },
      { source: "import { view } from '../web/view.js';", forbidden: false },
      { source: "import type { ServerType } from '../server/contract.js';", forbidden: false },
      { source: "import { helper } from '../scripts/helper.mjs';", forbidden: false },
      { source: "import { fixture } from '../tests/fixture.js';", forbidden: false },
      { source: "import { readFile } from 'node:fs/promises';", forbidden: false },
      { source: "import { request } from 'undici';", forbidden: false },
    ]);
  });
});
