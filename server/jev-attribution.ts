import type { WireRecord } from '../core/transport.js';
import { validateTranslationJudgmentPolicy } from '../core/translation-settings.js';
import { readJudgmentRequest } from './judgment.js';
import { matchesJudgmentWire } from './judgment-wire.js';
import {
  translationJudgmentInputHash,
  translationJudgmentRequest,
} from './translation-judgment.js';
import { HttpError, record } from './request-validation.js';

export function validateTranslationJudgmentWire(
  sourceHash: string,
  policy: unknown,
  wire: WireRecord,
  expectedResponse?: string
) {
  const judgment = validateTranslationJudgmentPolicy(policy);
  const response = record(readJudgmentRequest(wire)?.state).response;
  if (
    typeof response !== 'string' ||
    (expectedResponse !== undefined && response !== expectedResponse)
  )
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
  if (
    !matchesJudgmentWire(
      wire,
      translationJudgmentRequest(sourceHash, response),
      'translation-refusal',
      translationJudgmentInputHash(sourceHash, response, judgment)
    )
  )
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
}
