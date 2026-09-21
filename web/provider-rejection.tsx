import type { ProviderRejection, RejectedOption } from '../core/provider-rejection.js';

/** User-facing names for the option groups a provider can reject. */
const rejectedOptionLabels: Record<RejectedOption, string> = {
  thinking: '사고 강도',
  temperature: 'Temperature',
  topP: 'Top-p',
  maxOutputTokens: '최대 출력 토큰',
  stopSequences: '생성 중단 문자열',
  serviceTier: '서비스 등급',
  cache: '프롬프트 캐시',
  structuredOutput: '구조화 출력',
  verbosity: 'Verbosity',
  reasoningMode: 'Reasoning Mode',
  reasoningContext: 'Reasoning Context',
  model: '모델 ID',
  tools: '도구 정의',
  input: '요청 본문',
};
export function rejectionMessage(rejection: ProviderRejection): string {
  const names = [
    ...rejection.options.map((option) => rejectedOptionLabels[option]),
    ...(rejection.unmappedFields ?? []),
  ];
  return names.length
    ? `공급자가 ${names.join(', ')} 설정을 받아들이지 않았어요.`
    : rejection.message
      ? '공급자가 요청 설정을 받아들이지 않았어요. 자세한 이유는 오류 상세를 확인해 주세요.'
      : '공급자가 요청 설정을 받아들이지 않았어요. 어떤 설정인지는 알려주지 않았어요.';
}
/** The provider's verdict on saved options; the app never rewrites the option on its own. */
export function ProviderRejectionNotice({ rejection }: { rejection: ProviderRejection }) {
  const optionNamed = rejection.options.some((option) => option !== 'input');
  return (
    <div className="provider-rejection" role="status">
      <p>
        {rejectionMessage(rejection)}{' '}
        {optionNamed
          ? '모델 프리셋에서 해당 설정을 다른 값이나 모델 기본값으로 바꾼 뒤 다시 시도해 주세요.'
          : '모델 ID와 프로바이더 주소, 생성 설정을 확인해 주세요.'}
        {rejection.providerCode && <small> 공급자 코드 {rejection.providerCode}</small>}
      </p>
      {rejection.message && (
        <details>
          <summary>공급자 오류 상세</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {rejection.message}
          </pre>
          <small>입력한 내용이 포함될 수 있으니 공유하기 전에 확인해 주세요.</small>
        </details>
      )}
    </div>
  );
}
