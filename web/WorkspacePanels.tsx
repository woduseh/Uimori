import type { ReactNode } from 'react';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { Switch } from './BooleanControls.js';
import { ModelWorkspaceEditor } from './ModelWorkspaceEditor.js';
import { PromptWorkspaceEditor } from './PromptWorkspaceEditor.js';
import { discardActiveEditor } from './editor-workspace-context.js';
import { DeleteButton } from './DeleteButton.js';
import { ActivityDetails } from './ActivityStatus.js';
import { CodexAgentSettings } from './CodexAgentSettings.js';
import { IllustrationSettingsEditor } from './IllustrationSettingsEditor.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { useCompactLayout } from './useCompactLayout.js';
import { useSettingsHistory } from './useSettingsHistory.js';
import {
  SettingsIcon,
  ConnectionIcon,
  ModelIcon,
  PromptIcon,
  AgentIcon,
  DataIcon,
  SecurityIcon,
  BackIcon,
  IllustrationIcon,
} from './ui-icons.js';
import type { BranchTreeNode, Job, ReaderRun } from '../core/types.js';
import type { Branch } from '../core/product.js';
import { branchLabel } from './storyLabels.js';
import type { StoryState } from './useStory.js';
import { api, labels } from './api.js';
import { ConnectionEditor } from './ProviderManagement.js';
import { ArchivePanel } from './ArchivePanel.js';
import { AttemptInspector } from './AttemptInspector.js';
import { RunTaskDetails } from './RunTaskDetails.js';

export function TasksPanel({
  state,
  inspectedRun,
  onInspect,
  onClose,
}: {
  state: StoryState;
  inspectedRun: string | null;
  onInspect: (runId: string) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<string[]>([]);
  const detail = state.detail;
  const [jobs, setJobs] = useState<
    Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>[] | null
  >(null);
  const [jobsError, setJobsError] = useState('');
  const [runList, setRunList] = useState<{
    chatId: string;
    runs: ReaderRun[] | null;
    loading: boolean;
    error: string;
  } | null>(null);
  const [runRetry, setRunRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Full summaries are fetched only while this panel is mounted, on chat/event changes or explicit retry.
  useEffect(() => {
    if (!detail) return;
    let alive = true;
    const chatId = detail.chat.id;
    setRunList((old) => ({
      chatId,
      runs: old?.chatId === chatId ? old.runs : null,
      loading: true,
      error: '',
    }));
    void api<ReaderRun[]>(`/chats/${chatId}/reader-runs`)
      .then((runs) => {
        if (alive) setRunList({ chatId, runs, loading: false, error: '' });
      })
      .catch((error) => {
        if (alive)
          setRunList((old) => ({
            chatId,
            runs: old?.chatId === chatId ? old.runs : null,
            loading: false,
            error: error.message,
          }));
      });
    return () => {
      alive = false;
    };
  }, [detail?.chat.id, detail?.reader.cursor, runRetry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Job reads follow the chat and event cursor, not unrelated reader snapshot changes.
  useEffect(() => {
    let alive = true;
    setJobs(null);
    setJobsError('');
    if (detail)
      void api<Pick<Job, 'id' | 'sourceRevision' | 'kind' | 'status' | 'error' | 'attempt'>[]>(
        `/chats/${detail.chat.id}/jobs`
      )
        .then((value) => {
          if (alive) setJobs(value);
        })
        .catch((error) => {
          if (alive) setJobsError(error.message);
        });
    return () => {
      alive = false;
    };
  }, [detail?.chat.id, detail?.reader.cursor]);
  if (!detail) return <p className="muted">이야기를 열면 실행한 작업을 확인할 수 있어요.</p>;
  const listed = runList?.chatId === detail.chat.id ? runList : null;
  const allRuns = listed?.runs ?? null;
  const runs = inspectedRun
    ? (allRuns?.filter((run) => run.id === inspectedRun) ?? [])
    : (allRuns ?? []);
  const refresh = () => state.refresh(detail.chat.id);
  async function perform(key: string, operation: () => Promise<unknown>) {
    if (pending.includes(key)) return;
    setPending((old) => [...old, key]);
    state.setError('');
    try {
      await operation();
    } catch (error) {
      state.setError((error as Error).message);
    } finally {
      setPending((old) => old.filter((item) => item !== key));
    }
  }
  return (
    <section className="tasks-panel" aria-label="실행 기록">
      <div className="panel-intro">
        <p className="muted">{detail.chat.title} · 이 화면을 닫아도 서버의 작업은 이어져요.</p>
        {inspectedRun && (
          <button type="button" className="secondary" onClick={() => onInspect('')}>
            전체 작업 보기
          </button>
        )}
      </div>
      {!state.connected && (
        <p className="connection-notice" role="status">
          연결을 다시 확인하는 중이에요. 원격 작업의 상태는 아직 확정할 수 없어요.
        </p>
      )}
      <ActivityDetails activities={detail.reader.activity ?? []} branchId={state.branch?.id} />
      {(!listed || listed.loading) && <p role="status">작업 목록을 불러오는 중이에요…</p>}
      {listed?.error && (
        <div role="alert">
          <p>작업 목록: {listed.error}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => setRunRetry((value) => value + 1)}
          >
            작업 목록 다시 불러오기
          </button>
        </div>
      )}
      {allRuns && !listed?.loading && !listed?.error && !runs.length && (
        <p className="muted">
          {inspectedRun ? '선택한 작업을 찾을 수 없어요.' : '아직 실행한 작업이 없어요.'}
        </p>
      )}
      <div className="runs">
        {runs.map((run) => (
          <article key={run.id} data-testid="run" data-run-id={run.id} className="run">
            <p className="task-request">{run.request}</p>
            <RunTaskDetails
              run={run}
              jobs={jobs ?? []}
              revision={detail.reader.cursor}
              refresh={refresh}
              onError={state.setError}
              initiallyInspect={!!inspectedRun}
            >
              <div className="form-actions">
                {run.sourceRevision && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      const branch =
                        detail.branches?.find((item) => item.id === run.snapshot.branchId) ??
                        detail.branches?.find((item) => item.default);
                      if (branch && branch.id !== state.branch?.id)
                        state.chooseBranch(branch.default ? '' : branch.id, run.sourceRevision!);
                      else state.chooseSource(run.sourceRevision!);
                      onClose();
                    }}
                  >
                    원고 읽기
                  </button>
                )}
                {run.sourceRevision && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending.includes(run.id)}
                    onClick={() => {
                      void perform(run.id, async () => {
                        await state.fork(run.sourceRevision!);
                      });
                    }}
                  >
                    새 채팅으로 복사
                  </button>
                )}
              </div>
              {run.sourceRevision && (
                <small>
                  여기까지 복사하고 새 이야기에서 이어 써요. 복사만으로 모델을 호출하지 않아요.
                </small>
              )}
            </RunTaskDetails>
          </article>
        ))}
      </div>
      {jobsError && <p role="alert">보조 작업 목록: {jobsError}</p>}
      {!jobs && !jobsError && <p role="status">보조 작업 목록을 불러오는 중이에요…</p>}
      {allRuns && (
        <AttemptInspector
          key={detail.chat.id}
          chatId={detail.chat.id}
          revision={detail.reader.cursor}
          runs={allRuns}
        />
      )}
    </section>
  );
}

export function BranchesPanel({ state, onClose }: { state: StoryState; onClose: () => void }) {
  const [changingDefault, setChangingDefault] = useState(false);
  const detail = state.detail;
  if (!detail) return <p className="muted">먼저 이야기를 열어 주세요.</p>;
  function preview(branchId: string, head: string | null) {
    const latestId = detail!.reader.latestBranchRuns?.[branchId];
    const latestRun = detail!.reader.latestBranchRuns
      ? detail!.runs.find((run) => run.id === latestId)
      : detail!.runs.findLast((run) => run.snapshot.branchId === branchId);
    if (latestRun && !latestRun.sourceRevision)
      return `새 응답 ${labels[latestRun.status]} · ${latestRun.request.slice(0, 90)}`;
    const source = detail!.sources.find((item) => item.id === head);
    if (!source) return head ? '보관된 장면 · 선택해서 읽기' : '아직 완성된 장면이 없어요.';
    const translation = detail!.jobs.findLast(
      (job) =>
        job.sourceRevision === source.id &&
        job.kind === 'translation' &&
        job.status === 'completed' &&
        job.result
    );
    const text =
      translation?.result?.segments?.map((segment) => segment.text).join(' ') ||
      translation?.result?.text ||
      source.text;
    return text
      .replace(/\[\[p_[^\]]+\]\]/g, '')
      .replace(/[#>*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }
  const order = detail.reader.branchTree ?? [];
  const placed = order
    .map((node) => ({ node, branch: detail.branches?.find((item) => item.id === node.id) }))
    .filter((row): row is { node: BranchTreeNode; branch: Branch } => !!row.branch);
  const listed = placed.length
    ? placed
    : (detail.branches ?? []).map((branch) => ({
        branch,
        node: {
          id: branch.id,
          depth: 0,
          forkSourceId: null,
          forkIndex: null,
          ownScenes: 0,
          totalScenes: 0,
        },
      }));
  const forked = listed.some(({ node }) => node.depth > 0);
  return (
    <section className="branches-panel" aria-label="보관된 분기 목록">
      <p className="muted">
        기본 분기는 채팅을 열 때 먼저 보여요. 다른 분기를 기본으로 지정해도 원문과 실행 기록은
        그대로 유지돼요.
        {forked && ' 들여쓴 분기는 바로 위 분기에서 갈라져 나온 이야기예요.'}
      </p>
      <div className="branch-list" data-forked={forked}>
        {listed.map(({ branch, node }) => (
          // Indentation only repeats what the fork sentence already says, so it carries no role.
          <div
            className="branch-entry"
            key={branch.id}
            data-depth={Math.min(node.depth, 4)}
            style={{ marginInlineStart: `${Math.min(node.depth, 4) * 18}px` }}
          >
            <button
              type="button"
              className={`secondary branch-choice ${state.branch?.id === branch.id ? 'selected' : ''}`}
              key={branch.id}
              onClick={() => {
                state.chooseBranch(branch.default ? '' : branch.id);
                onClose();
              }}
              aria-pressed={state.branch?.id === branch.id}
            >
              <strong>{branchLabel(branch, detail)}</strong>
              <small>
                {node.forkIndex
                  ? `장면 ${node.forkIndex}에서 갈라짐 · 이후 ${node.ownScenes}개`
                  : node.totalScenes
                    ? `장면 ${node.totalScenes}개`
                    : '아직 장면이 없어요'}
                {' · '}
                {state.branch?.id === branch.id ? '읽는 중' : '이 분기 읽기'}
              </small>
              <span className="branch-preview">{preview(branch.id, branch.headRevision)}</span>
            </button>
            {!branch.default && (
              <button
                type="button"
                className="secondary"
                disabled={changingDefault}
                aria-label={`${branchLabel(branch, detail)} 기본 분기로 지정`}
                onClick={async () => {
                  const current = detail.branches?.find((item) => item.default);
                  if (!current) return;
                  setChangingDefault(true);
                  try {
                    await api(
                      `/chats/${detail.chat.id}/branches/${branch.id}/default`,
                      {
                        expectedRevision: branch.revision,
                        expectedDefaultBranchId: current.id,
                        expectedDefaultBranchRevision: current.revision,
                      },
                      'PUT'
                    );
                    state.chooseBranch(branch.id);
                  } catch (error) {
                    state.setError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setChangingDefault(false);
                  }
                }}
              >
                기본으로 지정
              </button>
            )}
            {!branch.default && (
              <DeleteButton
                path={`/chats/${detail.chat.id}/branches/${branch.id}`}
                revision={branch.revision}
                title={branchLabel(branch, detail)}
                label="분기 삭제"
                description="이 분기에서 생성한 원문과 실행 기록을 영구 삭제해요. 다른 분기가 사용하는 기록은 삭제할 수 없어요."
                onError={state.setError}
                onDeleted={async () => {
                  if (state.branch?.id === branch.id) state.chooseBranch('');
                  else await state.refresh(detail.chat.id);
                }}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function AppSettingsPanel({
  initialTab = 'general',
  state,
  theme,
  setTheme,
  enterSend,
  setEnterSend,
  panelWidth,
  setPanelWidth,
  readingSettings,
  onClose,
  onEditPrompt,
}: {
  initialTab?: string;
  state: StoryState;
  theme: 'system' | 'dark' | 'light';
  setTheme: (theme: 'system' | 'dark' | 'light') => void;
  enterSend: boolean;
  setEnterSend: (value: boolean) => void;
  panelWidth: number;
  setPanelWidth: (value: number) => void;
  readingSettings: ReactNode;
  onClose: () => void;
  onEditPrompt?: (presetId?: string) => void;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [active, setActive] = useState(initialTab);
  const [visited, setVisited] = useState([initialTab]);
  const compact = useCompactLayout();
  const [detail, setDetail] = useState(initialTab !== 'general');
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [archiveDirty, setArchiveDirty] = useState(false);
  const [illustrationDirty, setIllustrationDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState('');
  const dirty = connectionDirty || archiveDirty || modelDirty || promptDirty || illustrationDirty;
  const root = useRef<HTMLElement>(null);
  const wasCompact = useRef(compact);
  const id = useId();
  const categories = [
    { key: 'general', label: '일반', icon: SettingsIcon },
    { key: 'models', label: '역할별 모델', icon: ModelIcon },
    { key: 'prompts', label: '현재 프롬프트', icon: PromptIcon },
    { key: 'connections', label: '프로바이더·모델', icon: ConnectionIcon },
    { key: 'agents', label: '에이전트', icon: AgentIcon },
    { key: 'illustrations', label: '삽화', icon: IllustrationIcon },
    { key: 'data', label: '데이터 관리', icon: DataIcon },
    { key: 'security', label: '접근 보안', icon: SecurityIcon },
  ];
  const title = categories.find((item) => item.key === active)?.label ?? '일반';
  const showingDetail = !compact || detail;
  function backToList() {
    setDetail(false);
    requestAnimationFrame(() => document.getElementById(`${id}-${active}-tab`)?.focus());
  }
  const closeHistory = useSettingsHistory(() => {
    const nested = root.current
      ?.closest('dialog')
      ?.querySelector<HTMLDialogElement>('dialog[open]');
    if (nested) {
      nested.dispatchEvent(new Event('cancel', { cancelable: true }));
      return true;
    }
    if (compact && detail) {
      backToList();
      return true;
    }
    if (dirty) {
      setDiscard(true);
      return true;
    }
    return false;
  }, onClose);
  function requestClose() {
    if (dirty) setDiscard(true);
    else closeHistory();
  }
  useEffect(() => {
    if (compact && !wasCompact.current) setDetail(true);
    wasCompact.current = compact;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        root.current?.contains(focused) &&
        !focused.checkVisibility()
      )
        document.getElementById(`${id}-${active}-panel`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [compact, active, id]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [dirty]);
  function select(key: string) {
    setActive(key);
    setDetail(true);
    setVisited((previous) => (previous.includes(key) ? previous : [...previous, key]));
    if (compact)
      requestAnimationFrame(() => document.getElementById(`${id}-${key}-panel`)?.focus());
  }
  return (
    <Dialog
      open
      title="설정"
      onClose={requestClose}
      wide
      className="settings-dialog"
      headerTitle={compact && detail ? title : undefined}
      headerLeading={
        compact && detail ? (
          <IconButton label="설정 목록으로" icon={BackIcon} onClick={backToList} />
        ) : undefined
      }
    >
      <section ref={root} className="app-settings-panel" aria-label="앱 설정">
        <div
          className="settings-navigation"
          hidden={compact && detail}
          role={compact ? 'navigation' : 'tablist'}
          aria-label="설정 항목"
          aria-orientation={compact ? undefined : 'vertical'}
          onKeyDown={(event) => {
            if (compact) return;
            const index = categories.findIndex((item) => item.key === active);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? categories.length - 1
                  : ['ArrowDown', 'ArrowRight'].includes(event.key)
                    ? (index + 1) % categories.length
                    : ['ArrowUp', 'ArrowLeft'].includes(event.key)
                      ? (index + categories.length - 1) % categories.length
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            select(categories[next].key);
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {categories.map(({ key, label, icon: Icon }) => (
            <button
              type="button"
              role={compact ? undefined : 'tab'}
              key={key}
              id={`${id}-${key}-tab`}
              aria-controls={`${id}-${key}-panel`}
              aria-selected={compact ? undefined : active === key}
              tabIndex={compact || active === key ? 0 : -1}
              onClick={() => select(key)}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="settings-pages" hidden={!showingDetail}>
          {categories.map(({ key, label }) => (
            <section
              className="settings-page"
              role="tabpanel"
              id={`${id}-${key}-panel`}
              aria-labelledby={`${id}-${key}-tab`}
              hidden={active !== key || !showingDetail}
              tabIndex={0}
              key={key}
            >
              {visited.includes(key) && (
                <>
                  {!compact && <h3 className="settings-page-title">{label}</h3>}
                  {key === 'general' && (
                    <section className="settings-section">
                      <h3>
                        화면과 입력
                        <span className="scope-badge">이 기기</span>
                      </h3>
                      <label>
                        화면 테마
                        <select
                          aria-label="앱 화면 테마"
                          value={theme}
                          onChange={(event) =>
                            setTheme(event.target.value as 'system' | 'dark' | 'light')
                          }
                        >
                          <option value="system">기기 설정 따르기</option>
                          <option value="dark">어둡게</option>
                          <option value="light">밝게</option>
                        </select>
                      </label>
                      <label className="check">
                        <Switch
                          checked={enterSend}
                          onChange={(event) => setEnterSend(event.target.checked)}
                        />
                        Enter로 보내기
                      </label>
                      <small>
                        {enterSend
                          ? 'Enter로 보내고 Shift+Enter로 줄을 바꿔요.'
                          : 'Enter는 줄바꿈, Ctrl/Cmd+Enter는 보내기예요.'}{' '}
                        한글 조합 중에는 보내지 않아요.
                      </small>
                      <label>
                        도우미·창작 옵션 패널 폭
                        <select
                          aria-label="도우미·창작 옵션 패널 폭"
                          value={panelWidth}
                          onChange={(event) => setPanelWidth(Number(event.target.value))}
                        >
                          <option value={360}>좁게</option>
                          <option value={384}>보통</option>
                          <option value={480}>넓게</option>
                        </select>
                      </label>
                      <small>
                        도우미와 창작 옵션이 같은 자리를 나눠 써서 폭도 함께 바뀌어요. 넓게 두면
                        좁은 화면에서 패널이 원고 위에 겹쳐 열려요.
                      </small>
                    </section>
                  )}
                  {key === 'general' && (
                    <section className="settings-section">
                      <h3>
                        원고 읽기
                        <span className="scope-badge">이 기기</span>
                      </h3>
                      {readingSettings}
                      <small>
                        채팅 메뉴의 읽기 설정과 같은 값이에요. 어느 쪽에서 바꿔도 함께 바뀌어요.
                      </small>
                    </section>
                  )}
                  {key === 'models' && state.library && (
                    <ModelWorkspaceEditor
                      library={state.library}
                      onDirtyChange={setModelDirty}
                      onManage={() => select('connections')}
                    />
                  )}
                  {key === 'prompts' && state.library && (
                    <PromptWorkspaceEditor
                      library={state.library}
                      reload={state.loadLibrary}
                      onDirtyChange={setPromptDirty}
                      onEditPrompt={onEditPrompt}
                      navigationDisabled={dirty}
                    />
                  )}
                  {key === 'connections' && (
                    <div data-testid="connection-settings">
                      {state.library ? (
                        <ConnectionEditor
                          library={state.library}
                          reload={state.loadLibrary}
                          onError={state.setError}
                          onDirtyChange={setConnectionDirty}
                        />
                      ) : (
                        <p role="status">프로바이더 목록을 불러오는 중이에요…</p>
                      )}
                    </div>
                  )}
                  {key === 'agents' && (
                    <CodexAgentSettings
                      active={active === 'agents' && showingDetail}
                      onOpenModels={() => select('connections')}
                    />
                  )}
                  {key === 'illustrations' && state.library && (
                    <IllustrationSettingsEditor
                      library={state.library}
                      onDirtyChange={setIllustrationDirty}
                    />
                  )}
                  {key === 'data' && (
                    <ArchivePanel
                      expanded
                      active={active === 'data' && showingDetail}
                      onImported={async () => {
                        await Promise.all([state.loadChats(), state.loadLibrary()]);
                        if (state.selected) await state.refresh(state.selected);
                      }}
                      onError={state.setError}
                      onDirtyChange={setArchiveDirty}
                    />
                  )}
                  {key === 'security' && (
                    <section className="settings-section">
                      <p className="muted">
                        현재 브라우저의 접속 세션을 해제해요. 서버에서 진행 중인 생성은 취소되지
                        않아요.
                      </p>
                      <button
                        type="button"
                        className="secondary"
                        disabled={signingOut}
                        onClick={() => {
                          setSigningOut(true);
                          void api('/session', {}, 'DELETE')
                            .then(() => location.reload())
                            .catch((error) => {
                              state.setError(error.message);
                              setSigningOut(false);
                            });
                        }}
                      >
                        접속 해제
                      </button>
                    </section>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
      </section>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <Dialog
        open={discard}
        title="미저장 설정 확인"
        role="alertdialog"
        onClose={() => {
          if (!discarding) setDiscard(false);
        }}
      >
        <p>저장하지 않은 편집 내용이나 선택한 파일이 있어요. 닫으면 이 초안이 사라져요.</p>
        {discardError && (
          <p role="alert" className="error">
            {discardError}
          </p>
        )}
        <DraftDiscardActions
          open={discard}
          disabled={discarding}
          onContinue={() => setDiscard(false)}
          onDiscard={async () => {
            setDiscarding(true);
            setDiscardError('');
            try {
              if (promptDirty) await discardActiveEditor('prompt-workspace:current');
              setDiscard(false);
              closeHistory();
            } catch (error) {
              setDiscardError((error as Error).message);
            } finally {
              setDiscarding(false);
            }
          }}
          discardLabel="초안 버리고 닫기"
        />
      </Dialog>
    </Dialog>
  );
}
