import { t, formatMessage, type UiLocale } from './i18n.js';
import type { Illustration } from '../core/illustration.js';

/** Error codes stay stable identifiers; remote provider messages are never shown verbatim. */
const messages: Record<string, string> = {
  ILLUSTRATION_GENERATOR_UNCONFIGURED: 'visuals.m176',
  ILLUSTRATION_CODEX_CONTENT_BLOCKED: 'visuals.m177',
  ILLUSTRATION_ACTIVE: 'visuals.m178',
  ILLUSTRATION_PLAN_ACTIVE: 'visuals.m179',
  ILLUSTRATION_STORYBOARD_INVALID: 'visuals.m180',
  ILLUSTRATION_PLACEMENT_INVALID: 'visuals.m181',
  ILLUSTRATION_TARGET_UNAVAILABLE: 'visuals.m182',
  ILLUSTRATION_TARGET_CONFLICT: 'visuals.m183',
  ILLUSTRATION_PRESENTATION_CHANGED: 'visuals.m184',
  ILLUSTRATION_LIMIT_REACHED: 'visuals.m185',
  ILLUSTRATION_MODEL_REQUIRED: 'visuals.m186',
  ILLUSTRATION_MODEL_UNAVAILABLE: 'visuals.m187',
  ILLUSTRATION_CODEX_CONNECTION_REQUIRED: 'visuals.m188',
  ILLUSTRATION_PROMPT_MODEL_REQUIRED: 'visuals.m189',
  ILLUSTRATION_SOURCE_CHANGED: 'visuals.m190',
  ILLUSTRATION_SOURCE_UNAVAILABLE: 'visuals.m191',
  ILLUSTRATION_SOURCE_EMPTY: 'visuals.m192',
  ILLUSTRATION_SOURCE_SEGMENTS_INVALID: 'visuals.m193',
  ILLUSTRATION_IMAGE_INVALID: 'visuals.m194',
  ILLUSTRATION_NOT_RETRYABLE: 'visuals.m195',
  ILLUSTRATION_CANCELLED: 'visuals.m196',
  ILLUSTRATION_INTERRUPTED: 'visuals.m197',
  ILLUSTRATION_SUPERSEDED: 'visuals.m198',
  ILLUSTRATION_FAILED: 'visuals.m199',
  ILLUSTRATION_RESERVATION_FAILED: 'visuals.m200',
  ILLUSTRATION_PROMPT_REFUSED: 'visuals.m201',
  ILLUSTRATION_PROMPT_INVALID: 'visuals.m202',
  INPUT_CONTEXT_LIMIT_EXCEEDED: 'visuals.m203',
  ILLUSTRATION_PROMPT_INPUT_CONTEXT_LIMIT_EXCEEDED: 'visuals.m204',
  CONNECTION_NOT_AUTHORIZED: 'visuals.m205',
  CODEX_IMAGE_NOT_GENERATED: 'visuals.m206',
  CODEX_IMAGE_UNAVAILABLE: 'visuals.m207',
  ILLUSTRATION_PROMPT_TIMEOUT: 'visuals.m208',
  CODEX_IMAGE_USAGE_LIMIT: 'visuals.m209',
  CODEX_IMAGE_INVALID_REFERENCE: 'visuals.m210',
  CODEX_IMAGE_TOO_MANY_REFERENCES: 'visuals.m211',
  CODEX_LOGIN_REQUIRED: 'visuals.m212',
  CODEX_DISABLED: 'visuals.m213',
  CODEX_NOT_INSTALLED: 'visuals.m214',
  CODEX_VERSION_UNSUPPORTED: 'visuals.m215',
  CODEX_TURN_FAILED: 'visuals.m216',
  CODEX_EXECUTION_INTERRUPTED: 'visuals.m217',
  CODEX_TOOL_NOT_ALLOWED: 'visuals.m218',
  CODEX_BUSY: 'visuals.m219',
  CODEX_UNAVAILABLE: 'visuals.m220',
  CODEX_INVALID_CONNECTION: 'visuals.m221',
  TIMEOUT: 'visuals.m222',
  COMFYUI_UNCONFIGURED: 'visuals.m223',
  COMFYUI_WORKFLOW_MISSING: 'visuals.m224',
  COMFYUI_WORKFLOW_INVALID: 'visuals.m225',
  COMFYUI_WORKFLOW_UI_FORMAT: 'visuals.m226',
  COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING: 'visuals.m227',
  COMFYUI_BASE_URL_INVALID: 'visuals.m228',
  COMFYUI_CREDENTIAL_UNAVAILABLE: 'visuals.m229',
  COMFYUI_REDIRECT_REFUSED: 'visuals.m230',
  COMFYUI_UNREACHABLE: 'visuals.m231',
  COMFYUI_PROMPT_REJECTED: 'visuals.m232',
  COMFYUI_EXECUTION_FAILED: 'visuals.m233',
  COMFYUI_TIMEOUT: 'visuals.m234',
  COMFYUI_RESULT_PENDING: 'visuals.m235',
  COMFYUI_RESULT_UNAVAILABLE: 'visuals.m236',
  COMFYUI_SUBMISSION_UNCERTAIN: 'visuals.m237',
  ILLUSTRATION_NOT_RECONCILABLE: 'visuals.m238',
  COMFYUI_NO_IMAGE: 'visuals.m239',
  COMFYUI_IMAGE_INVALID: 'visuals.m240',
  COMFYUI_RESPONSE_INVALID: 'visuals.m241',
  COMFYUI_HTTP_5XX: 'visuals.m242',
  COMFYUI_HTTP_ERROR: 'visuals.m243',
  FIXTURE_FAILURE: 'visuals.m244',
};
export function illustrationErrorMessage(
  code: string | null | undefined,
  locale?: UiLocale
): string {
  const key = !code
    ? 'visuals.m199'
    : (messages[code] ??
      (code.startsWith('ILLUSTRATION_PROMPT_')
        ? 'visuals.m245'
        : code.startsWith('MODEL_UNAVAILABLE:')
          ? 'visuals.m187'
          : 'visuals.m199'));
  const values = key === 'visuals.m227' ? { placeholder: '{{prompt}}' } : undefined;
  return locale ? formatMessage(key, locale, values) : t(key, values);
}
export const illustrationGeneratorLabels: Record<Illustration['generator'], string> = {
  codex: 'Codex',
  comfyui: 'ComfyUI',
  get fixture() {
    return t('visuals.m246');
  },
};
export const illustrationActive = (item: Pick<Illustration, 'status'>) =>
  item.status === 'queued' || item.status === 'running';
const terminalFailure = (item: Pick<Illustration, 'status'>) =>
  ['failed', 'cancelled', 'interrupted'].includes(item.status);
export const illustrationRetryable = (
  item: Pick<Illustration, 'status' | 'generator' | 'diagnostic'> & { error?: string | null }
) =>
  terminalFailure(item) &&
  item.error !== 'ILLUSTRATION_CODEX_CONTENT_BLOCKED' &&
  item.diagnostic?.code !== 'ILLUSTRATION_CODEX_CONTENT_BLOCKED' &&
  !(
    item.generator === 'comfyui' &&
    (item.diagnostic?.comfyui?.submission === 'uncertain' ||
      (!!item.diagnostic?.comfyui?.promptId && item.diagnostic.comfyui.submission !== 'finished'))
  );
/** An accepted remote prompt can be re-read without rendering again. */
export const illustrationReconcilable = (
  item: Pick<Illustration, 'status' | 'generator' | 'diagnostic'>
) => item.generator === 'comfyui' && !!item.diagnostic?.comfyui?.promptId && terminalFailure(item);
export const illustrationSkipped = (item: Pick<Illustration, 'status' | 'images' | 'diagnostic'>) =>
  item.status === 'completed' &&
  !item.images.length &&
  typeof item.diagnostic?.skipped === 'string';
