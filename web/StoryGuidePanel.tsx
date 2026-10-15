import { useEffect, useRef, useState } from 'react';
import type { StoryDetail } from '../core/story.js';
import {
  defaultStoryGuideConfig,
  STORY_GUIDE_LIMITS,
  type StoryGuideConfig,
  type StoryGuideDetail,
} from '../core/story-guide.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
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
  nextRequest: string;
  onChanged: () => void;
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
  nextRequest,
  onChanged,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
}: Props) {
  const [loaded, setLoaded] = useState<StoryGuideDetail | null>(null);
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [draft, setDraft] = useState(defaultStoryGuideConfig);
  const [draftRevision, setDraftRevision] = useState(0);
  const baseline = useRef(draft);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [notesDirty, setNotesDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [question, setQuestion] = useState('');
  const [working, setWorking] = useState<'ask' | 'refresh' | null>(null);
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const reviewed = useRef<StoryGuideDetail | null>(null);
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const modelRequest = useRef<AbortController | null>(null);
  const saveGroup = useSettingsSaveGroup(saveSections);
  const base = `/chats/${encodeURIComponent(chatId)}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readRequest.current?.abort();
      modelRequest.current?.abort();
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChange(dirty || notesDirty || saving);
  }, [dirty, notesDirty, saving, onDirtyChange]);

  function report(caught: unknown) {
    const text = caught instanceof Error ? caught.message : '이야기 가이드를 불러오지 못했어요.';
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different story or model invalidates an in-flight manual analysis.
  useEffect(() => {
    modelRequest.current?.abort();
    modelRequest.current = null;
    setWorking(null);
    setPreview(null);
    setAnswer(null);
  }, [headRevision, profileRevision]);

  function update<K extends keyof StoryGuideConfig>(key: K, value: StoryGuideConfig[K]) {
    const next = { ...draft, [key]: value };
    dirtyRef.current = JSON.stringify(next) !== JSON.stringify(baseline.current);
    setDraft(next);
    setDirty(dirtyRef.current);
    setMessage('');
  }
  async function save() {
    if (savingRef.current || modelRequest.current || !loaded) return false;
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
      setPreview(null);
      setAnswer(null);
      setMessage('이야기 가이드를 저장했어요. 다음 집필부터 반영해요.');
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

  function cancel() {
    modelRequest.current?.abort();
    modelRequest.current = null;
    setWorking(null);
  }
  async function generate(kind: 'ask' | 'refresh') {
    if (modelRequest.current || savingRef.current || dirtyRef.current || notesDirty) return;
    const asked = question.trim();
    if (kind === 'ask' && !asked) return;
    const controller = new AbortController();
    modelRequest.current = controller;
    setWorking(kind);
    setError('');
    setMessage('');
    try {
      const result = await api<{ text: string }>(
        `${base}/story-guide/${kind}`,
        { ...(kind === 'ask' ? { question: asked } : {}), request: nextRequest },
        'POST',
        controller.signal
      );
      if (!alive.current || controller.signal.aborted || modelRequest.current !== controller)
        return;
      if (kind === 'ask') setAnswer({ question: asked, text: result.text });
      else setPreview(result.text);
    } catch (caught) {
      if (alive.current && !controller.signal.aborted && modelRequest.current === controller)
        report(caught);
    } finally {
      if (alive.current && modelRequest.current === controller) {
        modelRequest.current = null;
        setWorking(null);
      }
    }
  }

  if (!loaded)
    return (
      <LoadingState
        compact
        loading={!error}
        error={error}
        label="이야기 가이드를 불러오는 중이에요…"
        errorLabel="이야기 가이드를 불러오지 못했어요."
        onRetry={() => {
          setError('');
          void load();
        }}
      />
    );
  const busy = saving || working !== null;
  const hasDraft = dirty || notesDirty;
  return (
    <section className="story-guide" aria-label="이야기 가이드 내용">
      <p className="muted">
        원작의 설정과 인물 성격을 참고하면서, 이 이야기에서 달라진 선택과 관계를 존중해요.
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
              <strong>집필에 이야기 가이드 사용</strong>
              <small>본문 모델이 집필 전에 참고문을 만들어요.</small>
            </span>
            <Switch
              aria-label="집필에 이야기 가이드 사용"
              checked={draft.enabled}
              onChange={(event) => update('enabled', event.target.checked)}
            />
          </label>
          <label>
            작품·세계관
            <input
              value={draft.work}
              maxLength={STORY_GUIDE_LIMITS.work}
              placeholder="작품 이름이나 참고할 세계관"
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
            <p className="muted">기존 카드와 로어도 함께 참고해요. 더 필요한 자료만 덧붙여요.</p>
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
        </fieldset>
        <div className="form-actions">
          <SaveButton label="이야기 가이드 저장" text="저장" disabled={busy || !dirty} />
          {dirty && <small className="muted">저장하면 다음 요청부터 반영해요.</small>}
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <TransientNotice message={message} />
      <section className="story-guide-section" aria-label="현재 이야기 분석">
        <div className="story-guide-heading">
          <h4>현재 이야기 분석</h4>
          <button
            type="button"
            className="secondary"
            disabled={saving || hasDraft || working === 'ask'}
            onClick={() => {
              if (working === 'refresh') cancel();
              else void generate('refresh');
            }}
          >
            {working === 'refresh' ? '미리보기 중지' : '미리보기 만들기'}
          </button>
        </div>
        <p className="muted">저장한 설정과 현재 작성 중인 요청을 바탕으로 살펴봐요.</p>
        {hasDraft && <p className="muted">수정한 설정과 메모를 저장한 뒤 사용할 수 있어요.</p>}
        {working === 'refresh' && <p role="status">이야기를 살펴보고 있어요…</p>}
        {preview && (
          <div className="story-guide-result" aria-label="가이드 미리보기">
            <Prose text={preview} />
          </div>
        )}
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
            최근 집필은 이야기 가이드를 사용하지 못했어요. 미리보기를 만들어 설정을 확인할 수
            있어요.
          </p>
        )}
      </section>
      <section className="story-guide-section" aria-label="원작 질문">
        <h4>원작에 물어보기</h4>
        <p className="muted">원작이나 인물에 관해 질문해요. 답변은 이야기를 변경하지 않아요.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void generate('ask');
          }}
        >
          <label>
            원작·인물 질문
            <textarea
              value={question}
              maxLength={REQUEST_TEXT_MAX_CHARS}
              rows={3}
              disabled={busy}
              placeholder="예: 이 인물은 원작에서 어떤 이유로 동료를 불신하나요?"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <div className="form-actions">
            {working === 'ask' ? (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={(event) => {
                    event.preventDefault();
                    cancel();
                  }}
                >
                  질문 중지
                </button>
                <span role="status">답변을 만들고 있어요…</span>
              </>
            ) : (
              <button className="secondary" disabled={busy || hasDraft || !question.trim()}>
                질문하기
              </button>
            )}
          </div>
        </form>
        {answer && (
          <div className="story-guide-result" aria-label="원작 질문 답변">
            <p className="story-guide-question">{answer.question}</p>
            <Prose text={answer.text} />
          </div>
        )}
      </section>
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
            setPreview(null);
            setAnswer(null);
            onChanged();
          }}
          onError={onError}
          onDirtyChange={setNotesDirty}
          onSaveHandlerChange={saveGroup.registrations.notes}
        />
      )}
      <SaveConflictDialog
        open={conflictOpen}
        title="이야기 가이드 저장 충돌"
        onClose={() => {
          setConflictOpen(false);
          reviewed.current = null;
        }}
        readSaved={async () => {
          const value = await api<StoryGuideDetail>(`${base}/story-guide`);
          reviewed.current = value;
          return [
            { label: '집필에 사용', value: value.config.enabled ? '켜짐' : '꺼짐' },
            { label: '작품·세계관', value: value.config.work },
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
