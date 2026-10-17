import { useEffect, useState } from 'react';
import type { AutoTranslationDefaults as Defaults } from '../core/chat-settings.js';
import { api } from './api.js';
import { Switch } from './BooleanControls.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';

/** Unlike device-only reading preferences, translation jobs use the saved server choice. */
export function AutoTranslationDefaults() {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry explicitly re-issues a read.
  useEffect(() => {
    let alive = true;
    void api<Defaults>('/auto-translation-defaults')
      .then((value) => {
        if (alive) {
          setDefaults(value);
          setError('');
        }
      })
      .catch((cause) => {
        if (alive) setError((cause as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  async function change(autoTranslate: boolean) {
    if (!defaults || saving) return;
    setSaving(true);
    setError('');
    // Show the chosen state immediately; a rejected write restores the saved choice.
    setDefaults({ ...defaults, autoTranslate });
    try {
      setDefaults(
        await api<Defaults>(
          '/auto-translation-defaults',
          { expectedRevision: defaults.revision, autoTranslate },
          'PUT'
        )
      );
    } catch (cause) {
      setDefaults(defaults);
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-group-body">
      <LoadingState
        presentation="placeholder"
        loading={loading}
        error={!defaults ? error : ''}
        label="자동 번역 기본값을 불러오는 중이에요…"
        errorLabel="자동 번역 기본값을 불러오지 못했어요."
        onRetry={() => {
          setLoading(true);
          setReload((value) => value + 1);
        }}
      />
      {defaults && (
        <label className="settings-row settings-row-toggle">
          <span className="settings-row-copy">
            <strong>본문 생성 후 자동 번역</strong>
            <small>
              채팅별 선택이 없는 경우 새로 생성한 본문을 자동 번역해요. 기존 작업에는 소급 적용하지
              않으며, 현재 번역 모델을 사용해요.
            </small>
          </span>
          <span className="settings-row-control">
            <Switch
              aria-label="전체 자동 번역 기본값"
              checked={defaults.autoTranslate}
              disabled={saving || loading || !!error}
              onChange={(event) => void change(event.target.checked)}
            />
          </span>
        </label>
      )}
      {defaults && error && (
        <NoticeBanner tone="error">
          {error}{' '}
          <button
            type="button"
            className="link-button"
            disabled={saving}
            onClick={() => {
              setLoading(true);
              setReload((value) => value + 1);
            }}
          >
            다시 불러오기
          </button>
        </NoticeBanner>
      )}
    </div>
  );
}
