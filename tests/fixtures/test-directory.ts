import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/** Own only the temporary directory; each test still closes its Store or App first. */
export function createTestDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory,
    remove() {
      const target = resolve(directory);
      const within = relative(resolve(tmpdir()), target);
      if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith(prefix))
        throw new Error('Refusing cleanup outside owned test directory');
      rmSync(target, { recursive: true, force: true });
    },
  };
}
