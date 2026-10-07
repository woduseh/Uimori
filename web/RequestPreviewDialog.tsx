import { useEffect, useRef, useState } from 'react';
import type { RequestPreview } from '../core/request-preview.js';
import { TOKENIZER_PROFILES } from '../core/tokenizer-profiles.js';
import { api, libraryChangedKey } from './api.js';
import { Dialog } from './Dialog.js';
import './request-preview.css';

const amount = (value: number | null) =>
  value === null ? '미확인' : value.toLocaleString('ko-KR');
const entries = (value: number | null) => (value === null ? '미확인' : `${amount(value)}개`);

export function RequestPreviewDialog({
  open,
  chatId,
  request,
  loreContextReset,
  refreshKey,
  unavailable,
  onClose,
}: {
  open: boolean;
  chatId: string;
  request: string;
  loreContextReset: boolean;
  refreshKey: string;
  unavailable: boolean;
  onClose: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: RequestPreview } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const sequence = useRef(0);
  const key = JSON.stringify([
    chatId,
    request,
    loreContextReset,
    refreshKey,
    refresh,
    open,
    unavailable,
  ]);
  const preview = result?.key === key ? result.value : null;
  const error = failure?.key === key ? failure.message : '';
  const ready = open && !!request.trim() && !unavailable;

  useEffect(() => {
    if (!open) return;
    const changed = () => setRefresh((value) => value + 1);
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) changed();
    };
    addEventListener('prompt-workspace-changed', changed);
    addEventListener('uimori-helper-updated', changed);
    addEventListener('uimori-resource-saved', changed);
    addEventListener('focus', changed);
    addEventListener('storage', storage);
    return () => {
      removeEventListener('prompt-workspace-changed', changed);
      removeEventListener('uimori-helper-updated', changed);
      removeEventListener('uimori-resource-saved', changed);
      removeEventListener('focus', changed);
      removeEventListener('storage', storage);
    };
  }, [open]);

  useEffect(() => {
    const version = ++sequence.current;
    if (!ready) {
      setResult(null);
      setFailure(null);
      return;
    }
    const controller = new AbortController();
    void api<RequestPreview>(
      `/chats/${encodeURIComponent(chatId)}/request-preview`,
      { request, ...(loreContextReset ? { loreContextReset: true } : {}) },
      'POST',
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted && sequence.current === version) setResult({ key, value });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && sequence.current === version)
          setFailure({
            key,
            message: cause instanceof Error ? cause.message : '미리보기를 불러오지 못했어요.',
          });
      });
    return () => {
      controller.abort();
      sequence.current++;
    };
  }, [ready, key, chatId, request, loreContextReset]);

  const tokens = preview?.tokens;
  const percent =
    tokens?.estimatedInputTokens !== null &&
    tokens?.estimatedInputTokens !== undefined &&
    tokens.inputTokenLimit
      ? (tokens.estimatedInputTokens / tokens.inputTokenLimit) * 100
      : null;
  const tokenizer = TOKENIZER_PROFILES.find(
    (profile) => profile.id === (tokens?.tokenizerInfo?.effective ?? tokens?.tokenizer)
  );

  return (
    <Dialog
      open={open}
      title="다음 요청 미리보기"
      headerTitle="다음 요청 미리보기"
      className="request-preview-dialog"
      scopeKey={chatId}
      onClose={onClose}
    >
      {!request.trim() ? (
        <p>장면 요청을 입력하면 다음 생성의 설정과 컨텍스트를 확인할 수 있어요.</p>
      ) : unavailable ? (
        <p role="status">현재 작업을 마치고 미리보기를 다시 확인해 주세요.</p>
      ) : (
        <>
          <div className="request-preview-heading">
            <p className="muted">작성 중인 요청 기준 · 추가 모델 호출 없음</p>
            <button
              type="button"
              className="secondary"
              disabled={!preview && !error}
              onClick={() => setRefresh((value) => value + 1)}
            >
              다시 확인
            </button>
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : !preview ? (
            <p role="status">다음 요청을 확인하고 있어요.</p>
          ) : preview.snapshot.stale ? (
            <p role="status">확인 중에 컨텍스트나 설정이 바뀌었어요. 다시 확인해 주세요.</p>
          ) : (
            <div data-testid="request-preview">
              {preview.error && (
                <p role="status">
                  {preview.error === 'MAIN_MODEL_REQUIRED'
                    ? '본문 모델을 선택하면 입력량을 계산할 수 있어요.'
                    : '현재 조건의 입력량을 계산하지 못했어요. 자료와 프롬프트 설정을 확인해 주세요.'}
                </p>
              )}
              <dl className="request-preview-facts">
                <div>
                  <dt>본문 모델</dt>
                  <dd>{preview.selected.model?.title ?? '선택하지 않음'}</dd>
                </div>
                <div>
                  <dt>프롬프트</dt>
                  <dd>{preview.selected.prompt?.title ?? '기본 프롬프트'}</dd>
                </div>
                <div>
                  <dt>페르소나</dt>
                  <dd>{preview.selected.persona?.title ?? '없음'}</dd>
                </div>
                <div>
                  <dt>로어 준비</dt>
                  <dd>
                    고정 {entries(preview.lore.pinnedEntries)} · 유지{' '}
                    {entries(preview.lore.retainedEntries)}
                    {preview.lore.selectionPending && <small>추가 로어 선별 예정</small>}
                    {preview.lore.resetRequested && <small>이번 요청에서 조회 로어 제외</small>}
                  </dd>
                </div>
                <div>
                  <dt>컨텍스트 요약</dt>
                  <dd>
                    {preview.summary.inUse
                      ? `${entries(preview.summary.compactedSources)} 장면 요약 사용`
                      : preview.summary.inUse === null
                        ? '포함 여부 미확인'
                        : '요약 사용 안 함'}
                    {preview.caveats.includes('SUMMARY_NOT_REUSABLE') && (
                      <small>이전 요약은 현재 요청에 사용할 수 없어요.</small>
                    )}
                    {preview.caveats.includes('SUMMARY_INCLUSION_UNVERIFIED') && (
                      <small>요약은 있지만 현재 프롬프트에 포함됐는지 확인하지 못했어요.</small>
                    )}
                  </dd>
                </div>
              </dl>
              <div className="request-preview-budget">
                <p>
                  {tokens?.estimatedInputTokens == null
                    ? '입력량 미확인'
                    : `입력 약 ${amount(tokens.estimatedInputTokens)} / ${amount(tokens.inputTokenLimit)} 토큰`}
                  {percent !== null &&
                    ` · ${percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`}
                </p>
                {percent !== null && tokens?.inputTokenLimit && (
                  <meter
                    aria-label="다음 요청의 입력 한도 대비 추정 컨텍스트"
                    min={0}
                    max={tokens.inputTokenLimit}
                    value={Math.min(tokens.estimatedInputTokens!, tokens.inputTokenLimit)}
                  />
                )}
                {tokenizer && <small className="muted">{tokenizer.label} · 로컬 추정</small>}
                {preview.summary.compactionPending && (
                  <p role="status">컨텍스트 정리가 필요해 실제 전송량은 달라질 수 있어요.</p>
                )}
                {tokens?.tokenizerInfo?.fallback && (
                  <p role="status">선택한 토크나이저를 불러오지 못해 일반 추정치를 사용했어요.</p>
                )}
                {preview.caveats.includes('NATIVE_CALLBACKS_DEFERRED') && (
                  <small className="muted">Risu 스크립트의 요청 변경 전 추정이에요.</small>
                )}
              </div>
              <details className="request-preview-help">
                <summary>추정 기준</summary>
                <p>
                  현재 저장된 설정과 작성 중인 요청으로 첫 입력을 계산해요. 입력 한도와 비교하며
                  로컬 추정에는 10% 여유분을 포함해요.
                </p>
                <p>
                  생성 중 로어 선별·압축·도구 사용에 따라 입력이 달라질 수 있어요. 캐시 적중과 응답
                  길이는 미리 알 수 없어요.
                </p>
                <p>로어 수는 현재 준비된 자료 기준이에요. 실제 포함 기록은 생성 후 확인해요.</p>
                {preview.caveats.includes('NATIVE_CALLBACKS_DEFERRED') && (
                  <p>Risu의 입력·시작·요청 수정 스크립트는 생성할 때 실행해요.</p>
                )}
                <p>이후 설정이나 원고를 바꾸면 다시 확인해 주세요.</p>
              </details>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
