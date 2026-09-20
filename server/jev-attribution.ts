import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WireRecord } from '../core/transport.js';
import { validateTranslationJudgmentPolicy } from '../core/translation-settings.js';
import { JEV_ENDPOINT, JEV_MODEL } from './jev-judgment.js';
import {
  translationJudgmentInputHash,
  translationJudgmentRequest,
} from './translation-judgment.js';
import { HttpError, record } from './request-validation.js';

export function validateTranslationJudgmentWire(
  sourceHash: string,
  policy: unknown,
  wire: WireRecord
) {
  const judgment = validateTranslationJudgmentPolicy(policy);
  const response = record(record(wire.body).state).response;
  if (typeof response !== 'string')
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
  const request = translationJudgmentRequest(response);
  const body = { model: JEV_MODEL, ...request };
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (
    wire.judgment?.kind !== 'translation-refusal' ||
    wire.role !== 'translation' ||
    wire.protocol !== 'typesafe-systemone-v1' ||
    wire.connectionId !== 'typesafe-judgment' ||
    wire.modelId !== JEV_MODEL ||
    wire.url !== JEV_ENDPOINT ||
    wire.method !== 'POST' ||
    wire.agentId ||
    wire.nativeScript ||
    wire.judgment.inputHash !== translationJudgmentInputHash(sourceHash, response, judgment) ||
    !isDeepStrictEqual(wire.body, body) ||
    wire.bodySha256 !== digest(body) ||
    wire.stablePrefixSha256 !== digest(request.questions)
  )
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
}
