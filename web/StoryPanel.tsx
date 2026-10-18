import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useEffect, useRef, useState } from 'react';
import { ContextPanel } from './ContextPanel.js';
import type { StoryDetail } from '../core/story.js';
import { api } from './api.js';
import './story.css';
type PanelProps = {
  chatId: string;
  headRevision: string | null;
  settingsRevision: number;
  profileRevision?: number;
  onChanged: () => void;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  active?: boolean;
  hideHeading?: boolean;
  refreshKey?: unknown;
};
const id = encodeURIComponent;
/** Ignore saved-note reads that return after navigation or unmount. */
function useScope(key: string) {
  const scope = useRef({ key, alive: true, generation: 0 });
  if (scope.current.key !== key) {
    scope.current.key = key;
    scope.current.generation++;
  }
  useEffect(() => {
    scope.current.alive = true;
    return () => {
      scope.current.alive = false;
    };
  }, []);
  return () => {
    const captured = scope.current.generation;
    return () => scope.current.alive && scope.current.generation === captured;
  };
}

export function StoryPanel(props: PanelProps) {
  return <StoryPanelEditor key={props.chatId} {...props} />;
}

function StoryPanelEditor({
  chatId,
  headRevision,
  settingsRevision,
  profileRevision,
  onChanged,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  active = true,
  hideHeading = false,
  refreshKey,
}: PanelProps) {
  const capture = useScope(
    JSON.stringify([chatId, headRevision, settingsRevision, profileRevision])
  );
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const request = useRef(0);
  const [error, setError] = useState('');
  const [contextDirty, setContextDirty] = useState(false);
  const contextSave = useRef<(() => Promise<boolean>) | null>(null);
  const registerContextSave = useRef((handler: (() => Promise<boolean>) | null) => {
    contextSave.current = handler;
  }).current;
  const base = `/chats/${id(chatId)}`;
  const hasUnsavedChanges = contextDirty;
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : '작업을 완료하지 못했어요.';
    setError(text);
    onError(text);
  }
  async function load() {
    const valid = capture(),
      sequence = ++request.current;
    try {
      const result = await api<StoryDetail>(`${base}/story`);
      if (!valid() || sequence !== request.current) return;
      setDetail(result);
    } catch (caught) {
      if (valid() && sequence === request.current) report(caught);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scope revisions reload notes; toggling visibility preserves drafts.
  useEffect(() => {
    setDetail(null);
  }, [chatId, headRevision, settingsRevision, profileRevision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on scope changes or reactivation; render-local load must not replace drafts on every render.
  useEffect(() => {
    if (active) void load();
  }, [active, chatId, headRevision, settingsRevision, profileRevision, refreshKey]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (contextDirty && !(await contextSave.current?.())) return false;
    return true;
  });
  return (
    <section className="story-panel" aria-label="이야기 기억과 컨텍스트">
      {!hideHeading && <h3>기억과 컨텍스트</h3>}
      <p className="muted">
        이야기에서 일어난 일은 요약으로, 이후 요청에서도 지킬 조건은 메모·정정으로 관리해요. 카드
        변수는 봇의 원본 스크립트가 관리해요.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ContextPanel
        chatId={chatId}
        headRevision={headRevision}
        notes={detail?.notes}
        notesRevision={detail?.notesRevision}
        active={active}
        refreshKey={refreshKey}
        onRefreshStory={load}
        onChanged={onChanged}
        onError={onError}
        onDirtyChange={setContextDirty}
        onSaveHandlerChange={registerContextSave}
      />
    </section>
  );
}
