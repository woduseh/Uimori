import { createHash } from 'node:crypto';
import {
  CODEX_CONTENT_WARNING_THRESHOLD,
  CODEX_SEXUAL_CONTENT_BOUNDARY,
} from '../core/codex-content-warning.js';
import type { IllustrationContentCheck } from '../core/illustration.js';
import type { Json } from '../core/transport.js';
import { executeJevJudgment, JevError, type JevHooks, type JevRequest } from './jev-judgment.js';

/** Check the exact text sent for this image, not the entire story. Image bytes are not inspected. */
export async function checkCodexIllustrationContent(
  input: string,
  hooks: JevHooks,
  previous?: IllustrationContentCheck
): Promise<IllustrationContentCheck> {
  hooks.signal.throwIfAborted();
  const request: JevRequest = {
    state: { illustration: JSON.parse(input) as Json },
    questions: {
      explicitSexualContent: {
        type: 'noul',
        instructions: `Would generating the requested illustration require depicting graphic sexual activity, genital-focused sexual contact, penetration, masturbation, oral sex or comparably pornographic imagery? Evaluate the specified moment and art direction, not unrelated background events. ${CODEX_SEXUAL_CONTENT_BOUNDARY}`,
      },
    },
  };
  const inputHash = createHash('sha256')
    .update(JSON.stringify({ request, threshold: CODEX_CONTENT_WARNING_THRESHOLD }))
    .digest('hex');
  if (previous?.inputHash === inputHash && previous.status === 'allowed') return previous;
  if (!hooks.credential)
    return { status: 'unavailable', inputHash, code: 'JEV_CREDENTIAL_REQUIRED' };
  try {
    const result = await executeJevJudgment(request, inputHash, null, {
      ...hooks,
      kind: 'illustration-content',
      timeoutMs: 8_000,
    });
    hooks.signal.throwIfAborted();
    const score = result.scores.explicitSexualContent!;
    return {
      inputHash,
      score,
      status: score >= CODEX_CONTENT_WARNING_THRESHOLD ? 'blocked' : 'allowed',
    };
  } catch (error) {
    hooks.signal.throwIfAborted();
    // An unavailable guard is visible, not an "allowed" decision. Never hide storage failures.
    if (!(error instanceof JevError) || error.code === 'JEV_ATTEMPT_FINISH_FAILED') throw error;
    return { status: 'unavailable', inputHash, code: error.code };
  }
}
