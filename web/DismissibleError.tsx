import { CloseIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { NoticeBanner } from './NoticeBanner.js';
import './dismissible-error.css';

export function DismissibleError({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  if (!message) return null;
  const historyOmitted = message === 'PROMPT_HISTORY_OMITTED';
  return (
    <NoticeBanner
      tone="error"
      className="dismissible-error"
      actions={<IconButton label="오류 메시지 닫기" icon={CloseIcon} onClick={onDismiss} />}
    >
      {historyOmitted ? (
        <>
          <p>
            대화 이력 일부가 프롬프트에 포함되지 않았어요. 대화 범위 블록과 현재 입력 블록의 포함
            조건을 확인해 주세요.
          </p>
          <small>오류 코드: {message}</small>
        </>
      ) : (
        <p>{message}</p>
      )}
    </NoticeBanner>
  );
}
