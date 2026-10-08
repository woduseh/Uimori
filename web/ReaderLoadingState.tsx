import { LoadingState } from './LoadingState.js';
import './reader-loading.css';

export function ReaderLoadingState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  return (
    <LoadingState
      loading={loading}
      error={error}
      label="본문을 불러오는 중이에요…"
      errorLabel="본문을 불러오지 못했어요."
      onRetry={onRetry}
      retryLabel="본문 다시 불러오기"
      compact
    />
  );
}
