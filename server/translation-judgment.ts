import { createHash } from 'node:crypto';
import { sourceHash } from '../core/source-history.js';
import type {
  TranslationJudgmentPolicy,
  TranslationRefusalVerdict,
} from '../core/translation-settings.js';
import { executeJudgment, type JudgmentHooks, type JudgmentRequest } from './judgment.js';

export function translationJudgmentInputHash(
  sourceHash: string,
  candidate: string,
  policy: TranslationJudgmentPolicy
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 'translation-refusal-jev-v3',
        sourceHash,
        response: candidate,
        policy,
      })
    )
    .digest('hex');
}
export function translationJudgmentRequest(
  originalHash: string,
  candidate: string
): JudgmentRequest {
  return {
    state: {
      response: candidate,
      ...(sourceHash(candidate) === originalHash ? { matchesSourceVerbatim: true } : {}),
    },
    questions: {
      explicitRefusal: {
        type: 'noul',
        instructions:
          'Is the assistant itself explicitly refusing to translate the passage? A refusal within the translated material belongs to its speaker. An apology or clarification alone does not count.',
      },
    },
  };
}

export async function judgeTranslationRefusal(
  candidate: string,
  sourceHash: string,
  policy: TranslationJudgmentPolicy,
  hooks: JudgmentHooks
) {
  const result = await executeJudgment(
    translationJudgmentRequest(sourceHash, candidate),
    translationJudgmentInputHash(sourceHash, candidate, policy),
    null,
    { ...hooks, kind: 'translation-refusal' }
  );
  const verdict: TranslationRefusalVerdict =
    result.scores.explicitRefusal! >= policy.threshold ? 'refused' : 'accepted';
  return { ...result, verdict };
}
