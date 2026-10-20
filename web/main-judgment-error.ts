import { t } from './i18n.js';
import { auxiliaryErrorDiagnostic, auxiliaryErrorMessage } from './auxiliary-error.js';
import { requestImageError } from './request-image-errors.js';

export function mainJudgmentError(error: string | null | undefined): string | undefined {
  const image = requestImageError(error);
  if (image) return image;
  if (error === 'EVALUATION_SUBMISSION_REQUIRED') return auxiliaryErrorMessage(error);
  if (error?.startsWith('JEV_')) {
    const diagnostic = auxiliaryErrorDiagnostic(error);
    return diagnostic.code ? auxiliaryErrorMessage(error) : t('errors.judgmentJev');
  }
  if (error === 'MAIN_RESPONSE_REFUSED') return t('errors.judgmentRefused');
  if (error === 'MAIN_JUDGMENT_CALL_BUDGET') return t('errors.judgmentBudget');
  return undefined;
}
