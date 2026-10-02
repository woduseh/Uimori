import { expect } from 'vitest';
import type { Run } from '../../core/types.js';

type RunState = Pick<Run, 'id' | 'status' | 'error'>;
type StateRow = {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  kind?: unknown;
  role?: unknown;
  generation?: unknown;
};

/** Only for synthetic fixtures. Never serialize a run, request, response or assertion diff. */
export async function waitForCompletedRun<T extends RunState>(
  read: () => T | Promise<T>,
  {
    timeoutMs = 10000,
    handlerErrors = [],
    secrets = [],
    related = () => ({ jobs: [], attempts: [] }),
  }: {
    timeoutMs?: number;
    handlerErrors?: readonly unknown[];
    secrets?: readonly string[];
    related?: () => { jobs: StateRow[]; attempts: StateRow[] };
  } = {}
): Promise<T> {
  let last: T | undefined;
  let readError: unknown;
  let timedOut = false;
  try {
    await expect
      .poll(
        async () => {
          try {
            last = await read();
            readError = undefined;
          } catch (error) {
            readError = error;
            return false;
          }
          return !['queued', 'running'].includes(last.status);
        },
        { timeout: timeoutMs }
      )
      .toBe(true);
  } catch {
    timedOut = true;
  }
  if (!timedOut && last?.status === 'completed' && handlerErrors.length === 0) return last;

  const text = (value: unknown) => {
    if (value === null || value === undefined) return null;
    let message = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    // Redact before truncating, so even a long fixture credential cannot leak a prefix.
    for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
    message = message.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]');
    // Assertion messages can embed a whole prompt on their first line; keep the explanation,
    // but suppress quoted values as well as actual/expected, stack and cause properties.
    if (value instanceof Error && value.name === 'AssertionError')
      message = message.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '[value omitted]');
    return message.split(/\r?\n/, 1)[0].slice(0, 500);
  };
  const rows = (values: StateRow[]) =>
    values.slice(0, 5).map((row) => ({
      id: text(row.id),
      status: text(row.status),
      error: text(row.error),
      ...(row.kind === undefined ? {} : { kind: text(row.kind) }),
      ...(row.role === undefined ? {} : { role: text(row.role) }),
      ...(row.generation === undefined ? {} : { generation: text(row.generation) }),
    }));
  let details: object;
  try {
    const { jobs, attempts } = related();
    details = { recentJobs: rows(jobs), recentAttempts: rows(attempts) };
  } catch (error) {
    details = { relatedStateError: text(error) };
  }
  throw new Error(
    `Run completion ${timedOut ? `timed out after ${timeoutMs}ms` : 'failed'}: ${JSON.stringify({
      lastRun: last
        ? { id: text(last.id), status: text(last.status), error: text(last.error) }
        : null,
      ...details,
      readError: text(readError),
      fixtureHandlerErrorCount: handlerErrors.length,
      fixtureHandlerErrors: handlerErrors.slice(-3).map(text),
    })}`
  );
}
