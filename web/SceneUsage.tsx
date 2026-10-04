import type { SceneUsageReceipt } from '../core/scene-usage.js';
import './scene-usage.css';

const amount = (value: number | null) =>
  value === null ? '미확인' : value.toLocaleString('ko-KR');

export function SceneUsage({ usage }: { usage?: SceneUsageReceipt }) {
  const context = usage?.context;
  const percent = context ? (context.estimatedInputTokens / context.inputTokenLimit) * 100 : null;
  return (
    <details className="scene-usage" data-testid="scene-usage">
      <summary>
        요청 {amount(usage?.inputTokens ?? null)} · 응답 {amount(usage?.outputTokens ?? null)} 토큰
        {percent !== null &&
          ` · 문맥 약 ${percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`}
      </summary>
      <p>
        마지막 본문 호출의 공급자 보고 토큰이에요. 여러 호출을 합친 사용량은 작업 상세에서 확인해요.
      </p>
      {context ? (
        <>
          <p>
            앱 전송 문맥 추정 {amount(context.estimatedInputTokens)} / 입력 한도{' '}
            {amount(context.inputTokenLimit)} 토큰
          </p>
          <meter
            aria-label="입력 한도 대비 추정 문맥"
            min={0}
            max={context.inputTokenLimit}
            value={Math.min(context.estimatedInputTokens, context.inputTokenLimit)}
          />
          <p>
            호출 당시 적용된 입력 한도 기준이며 모델의 전체 최대 컨텍스트와 다를 수 있어요. 공급자
            내부 후속 작업은 이 추정치에 포함하지 않아요.
          </p>
        </>
      ) : (
        <p>이 호출의 문맥 기록이 없어 사용 비율을 확인할 수 없어요.</p>
      )}
      {!usage && (
        <p>호출 기록이 없어요. 가져온 원고나 기록 보존 이전 장면은 사용량을 추정하지 않아요.</p>
      )}
    </details>
  );
}
