import { useSettingsSaveGroup } from './useSettingsSaveHandler.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { SectionNavigation } from './SectionNavigation.js';
import { ProfileEditor, type ProfileSection } from './ProfileEditor.js';
import { StoryPanel } from './StoryPanel.js';
import { AssetEditor } from './AssetEditor.js';
import { IllustrationReferencesEditor } from './IllustrationReferences.js';
import { SettingsEditor } from './RuntimeSettings.js';
import { ChatVariables } from './ChatVariables.js';
import { api } from './api.js';
import { useCompactLayout } from './useCompactLayout.js';
import { useSettingsHistory } from './useSettingsHistory.js';
import type { StoryState } from './useStory.js';
import { BackIcon, BotIcon, PromptIcon, LoreIcon, ImagesIcon, BehaviorIcon } from './ui-icons.js';
import './chat-settings.css';

const saveSections = ['story', 'profile', 'image', 'reference', 'runtime'] as const;

export type Section = ProfileSection | 'story' | 'images' | 'runtime' | 'packages';
// Two groups: the basics every chat needs, then the advanced automation sections.
// Reading settings live in their own dialog (chat ⋯ menu), not here.
const categories = [
  {
    id: 'characters',
    title: '대화 구성',
    icon: BotIcon,
    description: '인물과 함께 사용할 자료',
    group: '기본',
  },
  {
    id: 'prompts',
    title: '프롬프트·모델',
    icon: PromptIcon,
    description: '작문 지침과 창작 옵션',
    group: '기본',
  },
  {
    id: 'story',
    title: '기억·로어',
    icon: LoreIcon,
    description: '장면 기억과 메모 관리',
    group: '고급',
  },
  {
    id: 'images',
    title: '이미지',
    icon: ImagesIcon,
    description: '이 채팅에 등록한 이미지와 삽화 참조',
    group: '고급',
  },
  {
    id: 'runtime',
    title: '자동 작업',
    icon: BehaviorIcon,
    description: '장면 해설과 호출 한도',
    group: '고급',
  },
  {
    id: 'packages',
    title: '카드 변수',
    icon: BehaviorIcon,
    description: '이 채팅의 카드 변수',
    group: '고급',
  },
] as const;
const isProfile = (section: Section): section is ProfileSection =>
  ['characters', 'prompts', 'models', 'story', 'images'].includes(section);

export function ChatSettingsPanel({
  state,
  onClose,
  initialSection,
  onGlobalSettings,
}: {
  state: StoryState;
  onClose: () => void;
  /** Open directly on this section (compact widths open its detail); the list is the default. */
  initialSection?: Section;
  onGlobalSettings: (section: 'models' | 'prompts') => void;
}) {
  const startSection = initialSection === 'models' ? 'prompts' : (initialSection ?? 'characters');
  const [active, setActive] = useState<Section>(startSection);
  const [profileTab, setProfileTab] = useState<ProfileSection>(
    isProfile(startSection) ? startSection : 'characters'
  );
  const [visited, setVisited] = useState<Section[]>([startSection]);
  const [detailOpen, setDetailOpen] = useState(!!initialSection);
  const [profileDirty, setProfileDirty] = useState(false);
  const [storyDirty, setStoryDirty] = useState(false);
  const [imageDirty, setImageDirty] = useState(false);
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [packageFeatures, setPackageFeatures] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [savingClose, setSavingClose] = useState(false);
  const saveGroup = useSettingsSaveGroup(saveSections);
  const dirty = profileDirty || storyDirty || imageDirty || referenceDirty || runtimeDirty;
  const compact = useCompactLayout();
  const showingDetail = !compact || detailOpen;
  const root = useRef<HTMLElement>(null);
  const afterClose = useRef<(() => void) | null>(null);
  const wasCompact = useRef(compact);
  const scroll = useRef(new Map<Section, number>());
  const positions = useRef(
    new Map<Section, { element: HTMLElement; start: number | null; end: number | null }>()
  );
  const lastFocused = useRef<HTMLElement | null>(null);
  const lastRootFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const panelId = (section: Section) => `${id}-${isProfile(section) ? 'profile' : section}-panel`;
  const title = categories.find((item) => item.id === active)!.title;
  function backToList() {
    rememberPosition();
    setDetailOpen(false);
    requestAnimationFrame(() => document.getElementById(`${id}-${active}-tab`)?.focus());
  }
  const closeHistory = useSettingsHistory(
    () => {
      if (savingClose) return true;
      const nested = root.current
        ?.closest('dialog')
        ?.querySelector<HTMLDialogElement>('dialog[open]');
      if (nested) {
        nested.dispatchEvent(new Event('cancel', { cancelable: true }));
        return true;
      }
      if (compact && detailOpen) {
        backToList();
        return true;
      }
      if (dirty) {
        setDiscard(true);
        return true;
      }
      return false;
    },
    () => {
      onClose();
      afterClose.current?.();
    }
  );
  function requestClose(next?: () => void) {
    if (savingClose) return;
    afterClose.current = next ?? null;
    if (dirty) setDiscard(true);
    else closeHistory();
  }
  function select(section: Section) {
    rememberPosition();
    setActive(section);
    if (isProfile(section)) setProfileTab(section);
    setVisited((old) => (old.includes(section) ? old : [...old, section]));
    setDetailOpen(true);
    requestAnimationFrame(() => {
      const pane = document.getElementById(panelId(section));
      if (pane) {
        pane.scrollTop = scroll.current.get(section) ?? 0;
        if (compact) {
          const position = positions.current.get(section);
          if (position?.element.isConnected && position.element.checkVisibility()) {
            position.element.focus({ preventScroll: true });
            if (
              position.start !== null &&
              position.end !== null &&
              (position.element instanceof HTMLInputElement ||
                position.element instanceof HTMLTextAreaElement)
            )
              position.element.setSelectionRange(position.start, position.end);
          } else pane.focus({ preventScroll: true });
        }
      }
    });
  }
  function rememberPosition() {
    const current = document.getElementById(panelId(active));
    if (!current?.checkVisibility()) return;
    scroll.current.set(active, current.scrollTop);
    const element = lastFocused.current;
    if (element && current.contains(element)) {
      const input =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element
          : null;
      positions.current.set(active, {
        element,
        start: input?.selectionStart ?? null,
        end: input?.selectionEnd ?? null,
      });
    }
  }
  useEffect(() => {
    state.setProfileDirty(dirty);
    return () => state.setProfileDirty(false);
  }, [dirty, state.setProfileDirty]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [dirty]);
  useEffect(() => {
    if (compact && !wasCompact.current) setDetailOpen(true);
    wasCompact.current = compact;
    const frame = requestAnimationFrame(() => {
      const focused =
        document.activeElement === document.body ? lastRootFocus.current : document.activeElement;
      if (
        focused instanceof HTMLElement &&
        root.current?.contains(focused) &&
        !focused.checkVisibility()
      )
        root.current?.querySelector<HTMLElement>('.settings-page:not([hidden])')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [compact]);
  const detail = state.detail;
  const library = state.library;
  const branchId = state.branch?.id;
  const packageScope = `${state.selected}:${branchId ?? ''}`;
  const packageAvailabilityKey = `${detail?.profile?.revision ?? 0}:${detail?.reader.cursor ?? 0}`;
  const previousPackageScope = useRef(packageScope);
  useEffect(() => {
    let current = true;
    if (previousPackageScope.current !== packageScope) {
      previousPackageScope.current = packageScope;
      setPackageFeatures(false);
    }
    void packageAvailabilityKey;
    const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
    let hasDraft = false;
    try {
      hasDraft =
        sessionStorage.getItem(
          `uimori:chat-variable-draft:${state.selected}:${branchId ?? 'current'}`
        ) !== null;
    } catch {
      // The server-owned feature checks still work when browser draft storage is unavailable.
    }
    void Promise.allSettled([
      api<{
        values: Record<string, string>;
        defaults: Record<string, string>;
        variableDefaultsError?: string;
      }>(`/chats/${encodeURIComponent(state.selected)}/variables${query}`),
    ]).then(([variableResult]) => {
      if (!current) return;
      const variables = variableResult.status === 'fulfilled' ? variableResult.value : null;
      setPackageFeatures(
        hasDraft ||
          Boolean(
            variables &&
              (Object.keys(variables.values).length > 0 ||
                Object.keys(variables.defaults).length > 0 ||
                variables.variableDefaultsError)
          )
      );
    });
    return () => {
      current = false;
    };
  }, [branchId, packageAvailabilityKey, packageScope, state.selected]);
  const visibleCategories = categories.filter((item) => item.id !== 'packages' || packageFeatures);
  return (
    <Dialog
      open
      title="채팅 설정"
      onClose={() => requestClose()}
      wide
      className="settings-dialog chat-settings-dialog"
      headerTitle={compact && detailOpen ? title : undefined}
      headerLeading={
        compact && detailOpen ? (
          <IconButton label="채팅 설정 목록으로" icon={BackIcon} onClick={backToList} />
        ) : undefined
      }
    >
      <section
        className="chat-settings-panel"
        ref={root}
        aria-label="채팅 설정 내용"
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            lastRootFocus.current = event.target;
            if (event.target.closest('.settings-page')) lastFocused.current = event.target;
          }
        }}
      >
        <SectionNavigation
          label="채팅 설정 분류"
          items={visibleCategories.map((item) => ({ ...item, panelId: panelId(item.id) }))}
          value={active}
          onSelect={select}
          compact={compact}
          idPrefix={id}
          hidden={compact && detailOpen}
        />
        <div className="settings-pages" hidden={!showingDetail}>
          <section
            className="settings-page"
            role="tabpanel"
            id={panelId('characters')}
            aria-labelledby={`${id}-${profileTab}-tab`}
            hidden={!isProfile(active) || !showingDetail}
            tabIndex={0}
          >
            {!compact && (
              <h3 className="settings-page-title">
                {categories.find((item) => item.id === profileTab)!.title}
              </h3>
            )}
            {detail?.profile && library && (
              <ProfileEditor
                ownerBotId={detail.chat.botId}
                branchId={state.branch?.id}
                profile={detail.profile}
                library={library}
                activeTab={profileTab}
                hideNavigation
                onSaved={() => state.refresh(state.selected)}
                onError={state.setError}
                onDirtyChange={setProfileDirty}
                onSaveHandlerChange={saveGroup.registrations.profile}
                onGlobalSettings={(section) => requestClose(() => onGlobalSettings(section))}
                nextRequest={state.pendingRequest ?? state.draft}
                loreContextReset={state.loreContextReset}
              />
            )}
            {visited.includes('story') && detail && (
              <div hidden={profileTab !== 'story'} className="chat-settings-memory">
                <h3>기억과 요약</h3>
                <StoryPanel
                  chatId={state.selected}
                  refreshKey={state.detail?.reader.cursor ?? 0}
                  branchId={state.branch?.id ?? `main:${state.selected}`}
                  headRevision={state.branch?.headRevision ?? detail.chat.headRevision}
                  settingsRevision={detail.chat.settingsRevision}
                  profileRevision={detail.profile?.revision}
                  active={active === 'story' && showingDetail}
                  hideHeading
                  onDirtyChange={setStoryDirty}
                  onSaveHandlerChange={saveGroup.registrations.story}
                  onChanged={() => {
                    void state.refresh(state.selected);
                  }}
                  onError={state.setError}
                />
              </div>
            )}
            {visited.includes('images') && detail && (
              <div hidden={profileTab !== 'images'} className="chat-settings-images">
                <details className="chat-settings-image-management">
                  <summary>
                    이미지 관리 <small>등록된 이미지 {(detail.assets ?? []).length}개</small>
                  </summary>
                  <AssetEditor
                    chatId={state.selected}
                    assets={detail.assets ?? []}
                    expanded
                    refresh={() => state.refresh(state.selected)}
                    onError={state.setError}
                    onDirtyChange={setImageDirty}
                    onSaveHandlerChange={saveGroup.registrations.image}
                  />
                </details>
                <IllustrationReferencesEditor
                  chatId={state.selected}
                  refreshKey={`${detail.profile?.revision ?? 0}:${(detail.assets ?? []).length}`}
                  onDirtyChange={setReferenceDirty}
                  onSaveHandlerChange={saveGroup.registrations.reference}
                  onError={state.setError}
                />
              </div>
            )}
          </section>
          {categories
            .filter((item) => !isProfile(item.id))
            .map(({ id: section, title: label }) => (
              <section
                key={section}
                className="settings-page"
                role="tabpanel"
                id={panelId(section)}
                aria-labelledby={`${id}-${section}-tab`}
                hidden={active !== section || !showingDetail}
                tabIndex={0}
              >
                {visited.includes(section) && detail && library && (
                  <>
                    {!compact && <h3 className="settings-page-title">{label}</h3>}
                    {section === 'runtime' && (
                      <SettingsEditor
                        chat={detail.chat}
                        onSaved={() => state.refresh(state.selected)}
                        onError={state.setError}
                        hideHeading
                        onDirtyChange={setRuntimeDirty}
                        onSaveHandlerChange={saveGroup.registrations.runtime}
                      />
                    )}
                    {section === 'packages' && packageFeatures && (
                      <ChatVariables
                        key={packageScope}
                        chatId={state.selected}
                        branchId={branchId}
                        refreshKey={state.detail?.reader.cursor ?? 0}
                        onChange={() => {
                          void state.refresh(state.selected);
                        }}
                      />
                    )}
                  </>
                )}
              </section>
            ))}
        </div>
      </section>
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      <Dialog
        open={discard}
        title="미저장 채팅 설정 확인"
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (savingClose) return;
          setDiscard(false);
          afterClose.current = null;
        }}
      >
        <p>저장하지 않은 편집 내용이나 선택한 파일이 있어요. 닫으면 이 초안이 사라져요.</p>
        <DraftDiscardActions
          open={discard}
          onSavingChange={setSavingClose}
          saveLabel="저장하고 닫기"
          onSave={async () => {
            if (
              !(await saveGroup.save({
                profile: profileDirty,
                story: storyDirty,
                image: imageDirty,
                reference: referenceDirty,
                runtime: runtimeDirty,
              }))
            )
              return false;
            setDiscard(false);
            closeHistory();
            return true;
          }}
          onContinue={() => {
            setDiscard(false);
            afterClose.current = null;
          }}
          onDiscard={() => {
            setDiscard(false);
            closeHistory();
          }}
          discardLabel="초안 버리고 닫기"
        />
      </Dialog>
    </Dialog>
  );
}
