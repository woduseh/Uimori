import { appErrorTakesParams, isAppErrorCode } from '#contracts';
import { appErrorMessages } from './api-errors.js';
import { t } from './i18n.js';
import { uiMessage, type MessageKey, type UiMessage } from './ui-message.js';
import type { Illustration } from '../core/illustration.js';

const messages: Record<string, MessageKey> = {
  ILLUSTRATION_STORYBOARD_INVALID: 'visuals.m180',
  ILLUSTRATION_PLACEMENT_INVALID: 'visuals.m181',
  ILLUSTRATION_SOURCE_UNAVAILABLE: 'visuals.m191',
  ILLUSTRATION_SOURCE_EMPTY: 'visuals.m192',
  ILLUSTRATION_SOURCE_SEGMENTS_INVALID: 'visuals.m193',
  ILLUSTRATION_IMAGE_INVALID: 'visuals.m194',
  ILLUSTRATION_CANCELLED: 'visuals.m196',
  ILLUSTRATION_INTERRUPTED: 'visuals.m197',
  ILLUSTRATION_SUPERSEDED: 'visuals.m198',
  ILLUSTRATION_FAILED: 'visuals.m199',
  ILLUSTRATION_PROMPT_REFUSED: 'visuals.m201',
  ILLUSTRATION_PROMPT_INVALID: 'visuals.m202',
  INPUT_CONTEXT_LIMIT_EXCEEDED: 'visuals.m203',
  ILLUSTRATION_PROMPT_INPUT_CONTEXT_LIMIT_EXCEEDED: 'visuals.m204',
  CONNECTION_NOT_AUTHORIZED: 'visuals.m205',
  CODEX_IMAGE_NOT_GENERATED: 'visuals.m206',
  CODEX_IMAGE_UNAVAILABLE: 'visuals.m207',
  ILLUSTRATION_PROMPT_TIMEOUT: 'visuals.m208',
  ILLUSTRATION_PROMPT_CALL_BUDGET_EXHAUSTED: 'visuals.promptCallBudgetExhausted',
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
  COMFYUI_WORKFLOW_UI_FORMAT: 'visuals.m226',
  COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING: 'visuals.m227',
  COMFYUI_CREDENTIAL_UNAVAILABLE: 'visuals.m229',
  COMFYUI_REDIRECT_REFUSED: 'visuals.m230',
  COMFYUI_UNREACHABLE: 'visuals.m231',
  COMFYUI_PROMPT_REJECTED: 'visuals.m232',
  COMFYUI_EXECUTION_FAILED: 'visuals.m233',
  COMFYUI_TIMEOUT: 'visuals.m234',
  COMFYUI_RESULT_PENDING: 'visuals.m235',
  COMFYUI_SUBMISSION_UNCERTAIN: 'visuals.m237',
  COMFYUI_NO_IMAGE: 'visuals.m239',
  COMFYUI_IMAGE_INVALID: 'visuals.m240',
  COMFYUI_RESPONSE_INVALID: 'visuals.m241',
  COMFYUI_HTTP_5XX: 'visuals.m242',
  COMFYUI_HTTP_ERROR: 'visuals.m243',
  FIXTURE_FAILURE: 'visuals.m244',
  NOVELAI_UNAUTHORIZED: 'visuals.novelaiUnauthorized',
  NOVELAI_ANLAS_INSUFFICIENT: 'visuals.novelaiAnlasInsufficient',
  NOVELAI_BUSY: 'visuals.novelaiBusy',
  NOVELAI_REQUEST_REJECTED: 'visuals.novelaiRequestRejected',
  NOVELAI_RESULT_UNCERTAIN: 'visuals.novelaiResultUncertain',
  NOVELAI_UNREACHABLE: 'visuals.novelaiUnreachable',
  NOVELAI_RESPONSE_INVALID: 'visuals.novelaiResponseInvalid',
  NOVELAI_IMAGE_INVALID: 'visuals.novelaiImageInvalid',
};
function illustrationError(code: string | null | undefined) {
  const key = !code
    ? 'visuals.m199'
    : isAppErrorCode(code) && !appErrorTakesParams(code)
      ? appErrorMessages[code]
      : (messages[code] ??
        (code.startsWith('ILLUSTRATION_PROMPT_')
          ? 'visuals.m245'
          : code.startsWith('MODEL_UNAVAILABLE:')
            ? 'visuals.m187'
            : 'visuals.m199'));
  return { key, values: key === 'visuals.m227' ? { placeholder: '{{prompt}}' } : undefined };
}
export function illustrationErrorMessage(code: string | null | undefined): string {
  const { key, values } = illustrationError(code);
  return t(key, values);
}
export function illustrationErrorUiMessage(code: string): UiMessage {
  const { key, values } = illustrationError(code);
  return uiMessage(key, values);
}
export const illustrationGeneratorLabels: Record<Illustration['generator'], string> = {
  codex: 'Codex',
  comfyui: 'ComfyUI',
  novelai: 'NovelAI',
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
export const illustrationReconcilable = (
  item: Pick<Illustration, 'status' | 'generator' | 'diagnostic'>
) => item.generator === 'comfyui' && !!item.diagnostic?.comfyui?.promptId && terminalFailure(item);
export const illustrationSkipped = (item: Pick<Illustration, 'status' | 'images' | 'diagnostic'>) =>
  item.status === 'completed' &&
  !item.images.length &&
  typeof item.diagnostic?.skipped === 'string';
