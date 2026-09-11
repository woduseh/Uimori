import { expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createApp } from '../server/app.js';
import { BehaviorError } from '../core/package-behavior.js';

test('behavior HTTP errors retain fixed recovery codes and hide arbitrary error details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uimori-behavior-errors-'));
  const inside = relative(tmpdir(), dir);
  if (
    isAbsolute(inside) ||
    inside.startsWith('..') ||
    !inside.startsWith('uimori-behavior-errors-')
  )
    throw new Error('Unsafe test cleanup');
  const app = await createApp({ dbPath: join(dir, 'test.sqlite'), buildId: 'synthetic-errors' });
  try {
    const errors = [
      new BehaviorError(409, 'BEHAVIOR_STATE_STALE'),
      new BehaviorError(400, 'BEHAVIOR_INVALID_SCHEMA'),
      new BehaviorError(409, 'BEHAVIOR_STATE_STALE: private-data'),
      Object.assign(new Error('BEHAVIOR_STATE_STALE'), { statusCode: 409 }),
    ];
    for (const [index, error] of errors.entries())
      app.get(`/synthetic-error-${index}`, () => {
        throw error;
      });
    for (const [index, error] of errors.entries()) {
      const response = await app.inject(`/synthetic-error-${index}`);
      expect(response.statusCode).toBe(error.statusCode);
      expect(response.json()).toEqual({
        error: index < 2 ? error.message : 'Request failed',
      });
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
