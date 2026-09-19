import type { WireRecord } from '../core/transport.js';
import { validateTranslationJudgmentPolicy } from '../core/translation-settings.js';
import { JEV_ENDPOINT, JEV_MODEL } from './jev-judgment.js';
import { translationJudgmentInputHash } from './translation-judgment.js';
import { HttpError, record } from './request-validation.js';

export function validateTranslationJudgmentWire(
  sourceHash: string,
  policy: unknown,
  wire: WireRecord
) {
  const judgment = validateTranslationJudgmentPolicy(policy);
  const prefix = record(record(wire.body).state).prefix;
  if (
    typeof prefix !== 'string' ||
    Array.from(prefix).length > 1000 ||
    wire.judgment?.kind !== 'translation-refusal' ||
    wire.role !== 'translation' ||
    wire.protocol !== 'typesafe-systemone-v1' ||
    wire.connectionId !== 'typesafe-judgment' ||
    wire.modelId !== JEV_MODEL ||
    wire.url !== JEV_ENDPOINT ||
    wire.method !== 'POST' ||
    wire.agentId ||
    wire.nativeScript ||
    wire.judgment.inputHash !== translationJudgmentInputHash(sourceHash, prefix, judgment)
  )
    throw new HttpError(400, 'TRANSLATION_JUDGMENT_ATTEMPT_MISMATCH');
}
