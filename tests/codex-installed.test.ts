import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { CodexRuntime } from '../server/codex-runtime.js';

// Explicit, non-model preflight for the operator's installed official CLI.
test.skipIf(process.env.NR_CODEX_PREFLIGHT !== '1')(
  'installed Codex initializes with isolated empty authentication',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'uimori-codex-installed-'));
    const within = relative(resolve(tmpdir()), root);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-codex-installed-')
    )
      throw new Error('Unsafe cleanup');
    const runtime = new CodexRuntime(join(root, 'probe.sqlite'), {
      enabled: true,
      executable: process.env.NR_CODEX_EXECUTABLE,
    });
    try {
      const status = await runtime.status();
      const directory = resolve('output/codex-preflight');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'summary.json'),
        JSON.stringify(
          { at: new Date().toISOString(), modelCalls: 0, loginAttempted: false, status },
          null,
          2
        )
      );
      expect(status).toMatchObject({
        available: true,
        authenticated: false,
        authMode: null,
        error: null,
        login: null,
        limits: [],
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
