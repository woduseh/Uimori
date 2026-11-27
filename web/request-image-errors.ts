import { appErrorTakesParams, isAppErrorCode } from '#contracts';
import { t } from './i18n.js';

export const requestImageErrors: Record<string, string> = {
  IMAGE_INPUT_UNSUPPORTED_MODEL:
    '선택한 모델은 이미지 입력을 지원하지 않아요. 본문 모델을 바꿔 주세요.',
  IMAGE_INPUT_UNSUPPORTED_PROTOCOL:
    '선택한 프로바이더로는 이미지를 전달할 수 없어요. 본문 모델의 프로바이더를 바꿔 주세요.',
  IMAGE_INPUT_UNAVAILABLE:
    '참고 이미지를 불러오지 못했어요. 저장된 이미지와 연결 상태를 확인해 주세요.',
  IMAGE_INPUT_INVALID:
    '전송할 참고 이미지가 저장 기록과 일치하지 않아요. 이미지와 백업을 확인해 주세요.',
  IMAGE_REQUEST_TOO_LARGE:
    '이미지를 포함한 요청 용량이 너무 커요. 첨부 수나 이미지 크기를 줄여 주세요.',
  RISU_NATIVE_REQUEST_IMAGE_IDENTITY:
    'Risu 스크립트가 이미지와 원래 요청의 연결을 바꿨어요. 이미지가 있는 사용자 메시지의 id와 역할을 유지하도록 스크립트를 확인해 주세요.',
};

export function requestImageError(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  if (Object.hasOwn(requestImageErrors, error)) return t(`errors.${error}`);
  return error.startsWith('REQUEST_IMAGE_') && isAppErrorCode(error) && !appErrorTakesParams(error)
    ? t(`errors.${error}`)
    : undefined;
}
