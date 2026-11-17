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
  const currentHash = translationJudgmentInputHash(sourceHash, response, judgment);
  const version =
    wire.judgment?.inputHash === currentHash
      ? 'translation-refusal-jev-v3'
      : 'translation-refusal-jev-v2';
  if (
    version === 'translation-refusal-jev-v2' &&
    wire.judgment?.inputHash !==
      translationJudgmentInputHash(sourceHash, response, judgment, version)
  )
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
  const request = translationJudgmentRequest(sourceHash, response, version);
  if (
    !matchesJudgmentWire(
      wire,
      request,
      'translation-refusal',
      translationJudgmentInputHash(sourceHash, response, judgment, version)
    )
  )
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
}
