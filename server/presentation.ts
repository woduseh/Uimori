import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export type RegexRule = { pattern: string; flags: string; replacement: string };
export const PRESENTATION_LIMITS = Object.freeze({
  input: 65_536,
  output: 65_536,
  pattern: 512,
  replacement: 2_048,
  rules: 8,
  timeoutMs: 500,
  concurrent: 4,
});
export type PresentationResult =
  | { ok: true; text: string }
  | { ok: false; text: string; error: string };
let active = 0;

/** Plain text only. Replacement is literal (including $1); source storage is never accessed.
 * Worker isolation limits regex CPU stalls; it is not a security sandbox. */
export async function presentText(source: string, rules: unknown): Promise<PresentationResult> {
  const fail = (error: string): PresentationResult => ({
    ok: false,
    text: typeof source === 'string' ? source : '',
    error,
  });
  if (typeof source !== 'string' || source.length > PRESENTATION_LIMITS.input)
    return fail('INPUT_LIMIT');
  if (!Array.isArray(rules) || rules.length > PRESENTATION_LIMITS.rules) return fail('RULE_LIMIT');
  const safe: RegexRule[] = [];
  for (const rule of rules) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof rule.pattern !== 'string' ||
      typeof rule.flags !== 'string' ||
      typeof rule.replacement !== 'string'
    )
      return fail('INVALID_RULE');
    if (
      !rule.pattern.length ||
      rule.pattern.length > PRESENTATION_LIMITS.pattern ||
      rule.replacement.length > PRESENTATION_LIMITS.replacement
    )
      return fail('RULE_SIZE_LIMIT');
    if (!/^[gimsu]*$/.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length)
      return fail('INVALID_FLAGS');
    safe.push({ pattern: rule.pattern, flags: rule.flags, replacement: rule.replacement });
  }
  if (!safe.length) return { ok: true, text: source };
  if (active >= PRESENTATION_LIMITS.concurrent) return fail('PRESENTATION_BUSY');
  active++;
  try {
    const compiled = new URL('./regex-worker.js', import.meta.url);
    const worker = new Worker(
      existsSync(compiled) ? compiled : new URL('./regex-worker.ts', import.meta.url),
      {
        workerData: { source, rules: safe, maxOutput: PRESENTATION_LIMITS.output },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      }
    );
    return await new Promise<PresentationResult>((resolve) => {
      let settled = false;
      const finish = (result: PresentationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Keep listeners until termination completes so no late error is unhandled.
        void worker
          .terminate()
          .catch(() => undefined)
          .finally(() => {
            worker.removeAllListeners();
            resolve(result);
          });
      };
      const timer = setTimeout(() => finish(fail('REGEX_TIMEOUT')), PRESENTATION_LIMITS.timeoutMs);
      worker.once('message', (value: unknown) => {
        if (
          value &&
          typeof value === 'object' &&
          'text' in value &&
          typeof value.text === 'string' &&
          value.text.length <= PRESENTATION_LIMITS.output
        )
          finish({ ok: true, text: value.text });
        else
          finish(
            fail(
              value &&
                typeof value === 'object' &&
                'error' in value &&
                value.error === 'OUTPUT_LIMIT'
                ? 'OUTPUT_LIMIT'
                : 'INVALID_PATTERN'
            )
          );
      });
      worker.once('error', () => finish(fail('REGEX_WORKER_ERROR')));
      worker.once('exit', () => finish(fail('REGEX_WORKER_EXIT')));
    });
  } catch {
    return fail('REGEX_WORKER_ERROR');
  } finally {
    active--;
  }
}
