import { useEffect, useState } from 'react';
import type { SceneUsageDetail, SceneUsageReceipt } from '../core/scene-usage.js';
import { api } from './api.js';
import './scene-usage.css';

const amount = (value: number | null) =>
  value === null ? '미확인' : value.toLocaleString('ko-KR');

export function SceneUsage({ usage }: { usage?: SceneUsageReceipt }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ id: string; value: SceneUsageDetail } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const attemptId = usage?.attemptId;
  useEffect(() => {
    if (!open || !attemptId || detail?.id === attemptId) return;
    const controller = new AbortController();
    setFailedId(null);
    void api<SceneUsageDetail>(
      `/attempts/${encodeURIComponent(attemptId)}/scene-detail`,
      undefined,
      'GET',
      controller.signal
    ).then(
      (value) => {
        if (!controller.signal.aborted) setDetail({ id: attemptId, value });
      },
      () => {
        if (!controller.signal.aborted) setFailedId(attemptId);
      }
    );
    return () => controller.abort();
  }, [open, attemptId, detail?.id]);
  const recordedDetail = detail && detail.id === attemptId ? detail.value : null;
  const receipt = usage?.receipt;
  const context = usage?.context;
  const actualInput = usage?.inputScope !== 'turn' ? (usage?.inputTokens ?? null) : null;
  const contextTokens = actualInput ?? context?.estimatedInputTokens ?? null;
  const percent =
    context && contextTokens !== null ? (contextTokens / context.inputTokenLimit) * 100 : null;
  return (
    <details
      className="scene-usage"
      data-testid="scene-usage"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        이번 생성 · 요청 {amount(usage?.inputTokens ?? null)} · 응답{' '}
        {amount(usage?.outputTokens ?? null)} 토큰
        {percent !== null &&
          ` · 컨텍스트 사용량 ${actualInput === null ? '약 ' : ''}${percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`}
      </summary>
      <div className="scene-usage-body">
        {receipt ? (
          <dl className="scene-receipt">
            <dt>모델</dt>
            <dd>
              {receipt.model.title} · {receipt.model.modelId}
            </dd>
            <dt>프롬프트 선택</dt>
            <dd>{receipt.prompt?.title ?? '선택 기록 없음'}</dd>
            <dt>페르소나 선택</dt>
            <dd>
              {receipt.persona
                ? (receipt.persona.name ?? receipt.persona.title ?? receipt.persona.id)
                : '선택 없음'}
            </dd>
            <dt>대화 요약</dt>
            <dd>
              {receipt.summary
                ? receipt.summary.status === 'included'
                  ? `${receipt.summary.coveredSources.toLocaleString('ko-KR')}개 장면 요약 포함 확인`
                  : receipt.summary.status === 'absent'
                    ? '사용 없음'
                    : '전송 포함 여부 미확인'
                : '기록 없음'}
            </dd>
          </dl>
        ) : usage ? (
          <p>이 호출의 모델·프롬프트·페르소나·요약 기록이 없어요.</p>
        ) : null}
        {context ? (
          <>
            <p>
              입력 {actualInput === null ? '약 ' : ''}
              {amount(contextTokens)} / 컨텍스트 한도 {amount(context.inputTokenLimit)}
            </p>
            <meter
              aria-label={
                actualInput === null ? '컨텍스트 한도 대비 추정 입력' : '컨텍스트 한도 대비 입력'
              }
              min={0}
              max={context.inputTokenLimit}
              value={Math.min(contextTokens!, context.inputTokenLimit)}
            />
          </>
        ) : (
          <p>이 호출의 문맥 기록이 없어 사용 비율을 확인할 수 없어요.</p>
        )}
        {attemptId &&
          (recordedDetail ? (
            <>
              <p>
                {recordedDetail.cache
                  ? `캐시 읽기 ${amount(recordedDetail.cache.readTokens)} / 쓰기 ${amount(recordedDetail.cache.writeTokens)} 토큰`
                  : '캐시 사용량 기록이 없어요.'}
              </p>
              <p>
                전송 로어 ·{' '}
                {recordedDetail.lore
                  ? recordedDetail.lore.entries.length
                    ? `${recordedDetail.lore.entries.length.toLocaleString('ko-KR')}개 기록`
                    : '본문 포함 기록 없음'
                  : '기록 없음'}
              </p>
              {!!recordedDetail.lore?.entries.length && (
                <ul className="scene-receipt-lore">
                  {recordedDetail.lore.entries.map((entry, index) => (
                    <li key={`${entry.id}:${entry.via}:${index}`}>
                      {entry.title} ·{' '}
                      {
                        {
                          pinned: '고정 자료',
                          selected: '자동 선택',
                          retained: '이전 요청 포함',
                          'tool-result': '도구 조회',
                        }[entry.via]
                      }
                      {entry.delivery !== 'full' && (
                        <>
                          {' '}
                          ·{' '}
                          {
                            {
                              excerpt: '읽은 구간',
                              summary: '요약만',
                              unverified: '포함 여부 미확인',
                            }[entry.delivery]
                          }
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : open ? (
            <p role="status">
              {failedId === attemptId
                ? '캐시·로어 기록을 불러오지 못했어요. 다시 펼치면 재시도해요.'
                : '캐시·로어 기록을 불러오는 중이에요.'}
            </p>
          ) : null)}
        {usage && (
          <details className="scene-usage-help">
            <summary>사용량 안내</summary>
            <p>여러 호출을 합친 전체 사용량은 작업 상세에서 확인해요.</p>
            {context && (
              <p>
                컨텍스트 사용량은 호출 당시 입력 한도 기준이며 모델의 전체 컨텍스트와 다를 수
                있어요. 로컬 추정에는 10% 여유를 포함해요.
              </p>
            )}
            {usage.inputScope === 'turn' && (
              <p>
                Codex 사용량은 내부 여러 호출의 누적 사용량이에요. 컨텍스트 사용량에는 앱이 전송한
                입력 추정치를 사용하며 내부 후속 작업은 포함하지 않아요.
              </p>
            )}
            {context?.tokenizerFallback && (
              <p>선택한 토크나이저를 불러오지 못해 일반 로컬 추정치를 사용했어요.</p>
            )}
            {recordedDetail?.cache && (
              <p>캐시 토큰은 입력에 포함된 값이며 입력량에 다시 더하지 않아요.</p>
            )}
          </details>
        )}
        {!usage && (
          <p>호출 기록이 없어요. 가져온 원고나 기록 보존 이전 장면은 사용량을 추정하지 않아요.</p>
        )}
      </div>
    </details>
  );
}
