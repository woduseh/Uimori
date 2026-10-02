import { expect, test, vi } from 'vitest';
import type { Run } from '../core/types.js';
import { waitForCompletedRun } from './fixtures/run-completion.js';

const state = (status: Run['status'], error: string | null = null) => ({
  id: 'synthetic-run',
  status,
  error,
});
const message = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('Expected a diagnostic failure');
    },
    (error: Error) => error.message
  );

test('successful run is returned without reading diagnostic data', async () => {
  const run = state('completed');
  const related = vi.fn();
  expect(await waitForCompletedRun(() => run, { related })).toBe(run);
  expect(related).not.toHaveBeenCalled();
});

test.each(['failed', 'cancelled', 'interrupted', 'refused', 'partial'] as const)(
  'terminal %s exits immediately with the actual run error',
  async (status) => {
    const read = vi.fn(() => state(status, 'Synthetic provider stream ended early'));
    const result = await message(waitForCompletedRun(read));
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toContain('Run completion failed:');
    expect(result).toContain(`"status":"${status}"`);
    expect(result).toContain('Synthetic provider stream ended early');
  }
);

test('timeout preserves the last observed running state', async () => {
  const result = await message(waitForCompletedRun(() => state('running'), { timeoutMs: 1 }));
  expect(result).toContain('timed out after 1ms');
  expect(result).toContain('"status":"running"');
});

test('an unavailable first observation reports unknown state rather than successful completion', async () => {
  const result = await message(
    waitForCompletedRun(
      () => {
        throw new Error('Synthetic missing run');
      },
      { timeoutMs: 1 }
    )
  );
  expect(result).toContain('"lastRun":null');
  expect(result).toContain('Synthetic missing run');
});

test('completed run still surfaces fixture handler failures without dumping assertion values', async () => {
  const assertion = new Error("expected 'PRIVATE PROMPT TEXT' to equal 'OTHER PRIVATE TEXT'\nDiff");
  assertion.name = 'AssertionError';
  const result = await message(
    waitForCompletedRun(() => state('completed'), { handlerErrors: [assertion] })
  );
  expect(result).toContain('AssertionError: expected [value omitted] to equal [value omitted]');
  expect(result).toContain('"fixtureHandlerErrorCount":1');
  expect(result).not.toContain('PRIVATE');
  expect(result).not.toContain('Diff');
});

test('diagnostics select bounded state fields and redact before truncating', async () => {
  const secret = 'fixture-secret-'.repeat(100);
  const result = await message(
    waitForCompletedRun(
      () => ({ ...state('failed', `Bearer ${secret}`), request: 'PRIVATE REQUEST' }),
      {
        secrets: [secret],
        handlerErrors: Array.from({ length: 6 }, (_, index) => new Error(`handler-${index}`)),
        related: () => ({
          jobs: Array.from({ length: 10 }, (_, index) => ({
            id: `job-${index}`,
            status: 'failed',
            error: `${secret} ${'x'.repeat(2000)}`,
            kind: 'translation',
            generation: 2,
            request: 'PRIVATE JOB REQUEST',
          })),
          attempts: [
            {
              id: 'attempt-1',
              status: 'failed',
              role: 'main',
              error: 'stream ended',
              response: 'PRIVATE RESPONSE',
            },
          ],
        }),
      }
    )
  );
  expect(result).toContain('[redacted]');
  expect(result).toContain('"generation":"2"');
  expect(result).toContain('attempt-1');
  expect(result).toContain('stream ended');
  expect(result).toContain('"fixtureHandlerErrorCount":6');
  expect(result).toContain('handler-5');
  expect(result).not.toContain('handler-2');
  expect(result).not.toContain('job-5');
  expect(result).not.toContain('fixture-secret');
  expect(result).not.toContain('PRIVATE');
  expect(result).not.toContain('x'.repeat(501));
  expect(result.length).toBeLessThan(5000);
});

test('related diagnostic lookup failure cannot hide the run failure', async () => {
  const result = await message(
    waitForCompletedRun(() => state('failed', 'Original failure'), {
      related: () => {
        throw new Error('Synthetic database unavailable');
      },
    })
  );
  expect(result).toContain('Original failure');
  expect(result).toContain('Synthetic database unavailable');
});
