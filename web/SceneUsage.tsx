import type { SceneUsageReceipt } from '../core/scene-usage.js';
import './scene-usage.css';

const amount = (value: number | null) =>
  value === null ? '미확인' : value.toLocaleString('ko-KR');

export function SceneUsage({ usage }: { usage?: SceneUsageReceipt }) {
  const context = usage?.context;
  const actualInput = usage?.inputScope !== 'turn' ? (usage?.inputTokens ?? null) : null;
  const contextTokens = actualInput ?? context?.estimatedInputTokens ?? null;
  const percent =
    context && contextTokens !== null ? (contextTokens / context.inputTokenLimit) * 100 : null;
  return (
    <details className="scene-usage" data-testid="scene-usage">
      <summary>
        요청 {amount(usage?.inputTokens ?? null)} · 응답 {amount(usage?.outputTokens ?? null)} 토큰
        {percent !== null &&
          ` · 문맥 ${actualInput === null ? '약 ' : ''}${percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`}
      </summary>
      <p>
        {usage?.inputScope === 'turn'
          ? '마지막 본문 작업의 공급자 보고 누적 토큰이에요. 내부 여러 호출을 포함할 수 있어요.'
          : '마지막 본문 호출의 공급자 보고 토큰이에요. 여러 호출을 합친 사용량은 작업 상세에서 확인해요.'}
      </p>
      {context ? (
        <>
          <p>
            {actualInput === null ? '앱 전송 문맥 추정' : '공급자 보고 입력'}{' '}
            {amount(contextTokens)} / 입력 한도 {amount(context.inputTokenLimit)} 토큰
          </p>
          <meter
            aria-label={
              actualInput === null ? '입력 한도 대비 추정 문맥' : '입력 한도 대비 보고 문맥'
            }
            min={0}
            max={context.inputTokenLimit}
            value={Math.min(contextTokens!, context.inputTokenLimit)}
          />
          {actualInput !== null && (
            <p>전송 전 로컬 추정은 {amount(context.estimatedInputTokens)} 토큰이었어요.</p>
          )}
          {context.tokenizerFallback && (
            <p>선택한 토크나이저를 불러오지 못해 일반 로컬 추정치를 사용했어요.</p>
          )}
          <p>
            호출 당시 적용된 입력 한도 기준이며 모델의 전체 최대 컨텍스트와 다를 수 있어요. 로컬
            추정에는 10% 여유를 포함해요.
          </p>
          {usage?.inputScope === 'turn' && (
            <p>
              문맥 비율은 앱이 전송한 입력의 추정치이며 공급자 내부 후속 작업은 포함하지 않아요.
            </p>
          )}
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
