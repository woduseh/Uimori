import { ActionMenu } from './ActionMenu.js';
import { HistoryIcon, IssueIcon } from './ui-icons.js';
import './retry-failure.css';

export function RetryFailure({
  status,
  error,
  disabled,
  onRetry,
  onSettings,
  onDetails,
  onHistory,
}: {
  status: string;
  error?: string | null;
  disabled?: boolean;
  onRetry?: () => void;
  onSettings?: () => void;
  onDetails: () => void;
  onHistory: () => void;
}) {
  const settings = /PROMPT_|UNSUPPORTED_OPTIONS|HTTP_40[0134]/u.test(error ?? '');
  const message =
    status === 'cancelled'
      ? '응답 생성을 취소했어요.'
      : status === 'interrupted'
        ? '응답 생성이 중단됐어요.'
        : status === 'refused'
          ? '모델이 요청에 답하지 못했어요.'
          : status === 'partial'
            ? '응답이 일부만 생성됐어요.'
            : error?.includes('PROMPT_UNKNOWN_SLOT')
              ? '프롬프트에 사용할 수 없는 항목이 있어요.'
              : error?.includes('UNSUPPORTED_OPTIONS')
                ? '모델이 요청 옵션을 지원하지 않아요.'
                : error?.includes('429')
                  ? '요청이 많아 응답을 만들지 못했어요. 잠시 후 다시 시도해 주세요.'
                  : '응답을 만들지 못했어요.';
  return (
    <div className="turn-failure chat-retry-failure" role="group" aria-label="실패한 요청">
      <p>{message}</p>
      <div className="turn-failure-actions">
        {onRetry && (
          <button
            type="button"
            className="secondary"
            disabled={disabled}
            title="같은 요청을 현재 설정으로 다시 실행해요"
            onClick={onRetry}
          >
            다시 시도
          </button>
        )}
        {settings && onSettings && (
          <button type="button" className="secondary" onClick={onSettings}>
            설정 확인
          </button>
        )}
        <ActionMenu label="실패한 요청 더보기">
          <button type="button" onClick={onDetails}>
            <IssueIcon size={18} aria-hidden="true" />
            오류 상세
          </button>
          <button type="button" onClick={onHistory}>
            <HistoryIcon size={18} aria-hidden="true" />
            작업 기록
          </button>
        </ActionMenu>
      </div>
    </div>
  );
}
