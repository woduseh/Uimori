import { useEffect, useRef, useState } from 'react';
import type { StoryDetail } from '../core/story.js';
import {
  defaultStoryGuideConfig,
  STORY_GUIDE_LIMITS,
  type StoryGuideConfig,
  type StoryGuideDetail,
} from '../core/story-guide.js';
import { api, ApiError } from './api.js';
import { AuthorNotesEditor } from './AuthorNotesEditor.js';
import { SelectionCheckbox, Switch } from './BooleanControls.js';
import { LoadingState } from './LoadingState.js';
import { Prose } from './Prose.js';
import { SaveButton } from './SaveButton.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
import { TransientNotice } from './TransientNotice.js';
import {
  useSettingsSaveGroup,
  useSettingsSaveHandler,
  type SettingsSaveRegistration,
} from './useSettingsSaveHandler.js';
import './story-guide.css';

const saveSections = ['notes'] as const;
type Props = {
  chatId: string;
  headRevision: string | null;
  profileRevision?: number;
  refreshKey: number;
  active: boolean;
  onChanged: () => void;
  onOpenHelper?: () => void;
  onError: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
};

export function StoryGuidePanel(props: Props) {
  return <StoryGuideEditor key={props.chatId} {...props} />;
}

function StoryGuideEditor({
  chatId,
  headRevision,
  profileRevision,
  refreshKey,
  active,
  onChanged,
  onOpenHelper,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
}: Props) {
  const [loaded, setLoaded] = useState<StoryGuideDetail | null>(null);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [draft, setDraft] = useState(defaultStoryGuideConfig);
  const [draftRevision, setDraftRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const baseline = useRef(draft);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [notesDirty, setNotesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflictOpen, setConflictOpen] = useState(false);
  const reviewed = useRef<StoryGuideDetail | null>(null);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const saveGroup = useSettingsSaveGroup(saveSections);
  const base = `/chats/${encodeURIComponent(chatId)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readRequest.current?.abort();
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChange(dirty || notesDirty || saving);
  }, [dirty, notesDirty, saving, onDirtyChange]);

  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : '원작·인물 참고를 불러오지 못했어요.';
    setError(text);
    onError(text);
  }
  function acceptSaved(value: StoryGuideDetail) {
    baseline.current = value.config;
    dirtyRef.current = false;
    setDraft(value.config);
    setDraftRevision(value.revision);
    setDirty(false);
  }
  async function load() {
    const sequence = ++loadSequence.current;
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const [value, notes] = await Promise.all([
        api<StoryGuideDetail>(`${base}/story-guide`, undefined, 'GET', controller.signal),
        api<StoryDetail>(`${base}/story`, undefined, 'GET', controller.signal),
      ]);
      if (!alive.current || controller.signal.aborted || sequence !== loadSequence.current) return;
      setLoaded(value);
      setStory(notes);
      setSettingsOpen((open) => open ?? value.revision === 0);
      if (!dirtyRef.current && !savingRef.current) acceptSaved(value);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted && sequence === loadSequence.current)
        report(caught);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on server changes or re-entry without replacing an edited draft.
  useEffect(() => {
    if (active) void load();
  }, [active, headRevision, profileRevision, refreshKey]);
  function update<K extends keyof StoryGuideConfig>(key: K, value: StoryGuideConfig[K]) {
    const next = { ...draft, [key]: value };
    dirtyRef.current = JSON.stringify(next) !== JSON.stringify(baseline.current);
    setDraft(next);
    setDirty(dirtyRef.current);
    setMessage('');
  }
  async function save() {
    if (savingRef.current || !loaded) return false;
    if (!dirtyRef.current) return true;
    if (draftRevision !== loaded.revision) {
      setConflictOpen(true);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const value = await api<StoryGuideDetail>(
        `${base}/story-guide`,
        { expectedRevision: draftRevision, config: draft },
        'PUT'
      );
      if (!alive.current) return false;
      loadSequence.current++;
      setLoaded(value);
      acceptSaved(value);
      setMessage('원작·인물 참고를 저장했어요. 다음 집필부터 반영해요.');
      onError('');
      onChanged();
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      report(caught);
      if (caught instanceof ApiError && caught.status === 409) setConflictOpen(true);
      return false;
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (!(await save())) return false;
    return saveGroup.save({ notes: notesDirty });
  });

  if (!loaded)
    return (
      <LoadingState
        presentation="region"
        loading={!error}
        error={error}
        label="원작·인물 참고를 불러오는 중이에요…"
        errorLabel="원작·인물 참고를 불러오지 못했어요."
        onRetry={() => {
          setError('');
          void load();
        }}
      />
    );
  const busy = saving;
  return (
    <section className="story-guide" aria-label="원작·인물 참고 내용">
      <p className="muted">
        모델이 원작 설정과 인물 성격을 참고해 집필 참고문을 만들어요. 현재 이야기의 선택과 관계도
        함께 고려하도록 요청해요.
      </p>
      <form
        className="settings-group"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="story-guide-config">
          <label className="settings-row settings-row-toggle">
            <span className="settings-row-copy">
              <strong>집필 전에 원작·인물 참고</strong>
              <small>선택 사항이에요. 참고문 생성에 모델 호출과 비용이 추가될 수 있어요.</small>
            </span>
            <span className="settings-row-control">
              <Switch
                aria-label="집필 전에 원작·인물 참고"
                checked={draft.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
            </span>
          </label>
          <details
            className="story-guide-settings"
            open={settingsOpen ?? false}
            onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
          >
            <summary>
              참고 설정
              {!settingsOpen && <small>{draft.work || '작품·참고 범위'}</small>}
            </summary>
            <div className="story-guide-fields">
              <label>
                작품·판본·세계관
                <input
                  value={draft.work}
                  maxLength={STORY_GUIDE_LIMITS.work}
                  placeholder="작품 이름·판본, 또는 참고할 세계관"
                  onChange={(event) => update('work', event.target.value)}
                />
              </label>
              <label>
                기준 시점·스포일러 범위
                <textarea
                  value={draft.position}
                  maxLength={STORY_GUIDE_LIMITS.position}
                  rows={2}
                  placeholder="예: 2권 마지막까지. 이후 사건과 인물의 정체는 밝히지 않기"
                  onChange={(event) => update('position', event.target.value)}
                />
              </label>
              <label className="story-guide-check">
                <SelectionCheckbox
                  checked={draft.followCanon}
                  onChange={(event) => update('followCanon', event.target.checked)}
                />
                <span>원작의 사건 전개도 참고</span>
              </label>
              <details className="story-guide-reference">
                <summary>추가 참고 자료</summary>
                <p className="muted">
                  기존 카드와 로어도 함께 참고해요. 더 필요한 자료만 덧붙여요.
                </p>
                <label>
                  추가 참고 텍스트
                  <textarea
                    value={draft.reference}
                    maxLength={STORY_GUIDE_LIMITS.reference}
                    rows={6}
                    onChange={(event) => update('reference', event.target.value)}
                  />
                </label>
              </details>
            </div>
          </details>
        </fieldset>
        {dirty && (
          <div className="form-actions">
            <SaveButton label="원작·인물 참고 저장" aria-busy={saving} disabled={busy} />
            <small className="muted">저장하면 다음 요청부터 반영해요.</small>
          </div>
        )}
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <TransientNotice message={message} />
      <section className="story-guide-section" aria-label="마지막 집필 참고문">
        {loaded.brief ? (
          <details className="story-guide-last-brief">
            <summary>마지막 집필 참고문</summary>
            <p className="muted">
              {new Date(loaded.brief.createdAt).toLocaleString()} · {loaded.brief.modelTitle}
              {loaded.brief.configRevision !== loaded.revision && ' · 이전 설정으로 만든 참고문'}
            </p>
            <div className="story-guide-result" aria-label="마지막 집필 참고문 내용">
              <Prose text={loaded.brief.text} />
            </div>
          </details>
        ) : (
          <p className="muted">아직 집필에 사용한 참고문이 없어요.</p>
        )}
        {loaded.latestRun?.error && (
          <p className="muted">
            최근 집필은 참고문 없이 진행했어요. 모델 연결과 호출 한도를 확인해 주세요.
          </p>
        )}
      </section>
      <div className="form-actions">
        <p className="muted">원작이나 인물에 관한 질문은 이 채팅의 도우미에서 이어가요.</p>
        {onOpenHelper && (
          <button type="button" className="secondary" onClick={onOpenHelper}>
            도우미에게 질문
          </button>
        )}
      </div>
      {story && (
        <AuthorNotesEditor
          headRevision={headRevision}
          notes={story.notes}
          revision={story.notesRevision}
          disabled={busy}
          onSave={async (command) => {
            await api(`${base}/notes`, command);
          }}
          onRefresh={async () => {
            await load();
            if (!alive.current) return;
            onChanged();
          }}
          onError={onError}
          onDirtyChange={setNotesDirty}
          onSaveHandlerChange={saveGroup.registrations.notes}
        />
      )}
      <SaveConflictDialog
        open={conflictOpen}
        title="원작·인물 참고 저장 충돌"
        onClose={() => {
          setConflictOpen(false);
          reviewed.current = null;
        }}
        readSaved={async () => {
          const value = await api<StoryGuideDetail>(`${base}/story-guide`);
          reviewed.current = value;
          return [
            { label: '집필에 사용', value: value.config.enabled ? '켜짐' : '꺼짐' },
            { label: '작품·판본·세계관', value: value.config.work },
            { label: '기준 시점·스포일러 범위', value: value.config.position },
            { label: '원작의 사건 전개도 참고', value: value.config.followCanon ? '예' : '아니요' },
            { label: '추가 참고 자료', value: value.config.reference },
          ];
        }}
        onAcceptSaved={() => {
          if (!reviewed.current) return;
          setLoaded(reviewed.current);
          setDraftRevision(reviewed.current.revision);
          setError('');
        }}
      />
    </section>
  );
}
