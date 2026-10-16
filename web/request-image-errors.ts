/** Exact local codes only; untrusted provider error text is never rendered as instructions. */
export const requestImageErrors: Record<string, string> = {
  REQUEST_IMAGE_COUNT_INVALID: '참고 이미지는 최대 8장까지 첨부할 수 있어요.',
  REQUEST_IMAGE_UPLOAD_INVALID: '첨부 이미지 업로드를 확인해 주세요. 파일을 다시 첨부할 수 있어요.',
  REQUEST_IMAGE_CHANGED: '첨부 이미지가 변경됐어요. 파일을 다시 첨부해 주세요.',
  REQUEST_IMAGE_ANIMATED: '움직이는 이미지는 사용할 수 없어요. 정지 이미지를 첨부해 주세요.',
  REQUEST_IMAGE_FORMAT_INVALID: 'PNG, JPEG 또는 정지 WebP 이미지를 첨부해 주세요.',
  REQUEST_IMAGE_DIMENSIONS_INVALID:
    '이미지 해상도가 처리 범위를 넘어요. 크기를 줄여 첨부해 주세요.',
  REQUEST_IMAGE_TOO_LARGE: '보존할 이미지가 64MiB를 넘어요. 이미지 크기를 줄여 첨부해 주세요.',
  REQUEST_IMAGE_INVALID: '첨부 이미지를 읽거나 변환하지 못했어요. 파일을 확인해 주세요.',
  REQUEST_IMAGE_MISSING:
    '저장된 첨부 이미지를 찾을 수 없어요. 채팅 백업과 이미지 파일을 확인해 주세요.',
  IMAGE_INPUT_UNSUPPORTED_MODEL:
    '선택한 모델은 이미지 입력을 지원하지 않아요. 본문 모델을 바꿔 주세요.',
  IMAGE_INPUT_UNSUPPORTED_PROTOCOL:
    '선택한 연결로는 이미지를 전달할 수 없어요. 본문 모델의 연결을 바꿔 주세요.',
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
  return error && Object.hasOwn(requestImageErrors, error) ? requestImageErrors[error] : undefined;
}
