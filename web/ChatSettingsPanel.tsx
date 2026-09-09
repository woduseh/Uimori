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
import { useCompactLayout } from './useCompactLayout.js';
import { useSettingsHistory } from './useSettingsHistory.js';
import type { StoryState } from './useStory.js';
import {
  BackIcon,
  BotIcon,
  PromptIcon,
  ModelIcon,
  LoreIcon,
  ImagesIcon,
  BehaviorIcon,
} from './ui-icons.js';
import './chat-settings.css';

export type Section = ProfileSection | 'story' | 'images' | 'runtime';
// Two groups: the basics every chat needs, then the advanced automation sections.
// Reading settings live in their own dialog (chat ⋯ menu), not here.
const categories = [
  {
    id: 'characters',
    title: '봇·페르소나·모듈',
    icon: BotIcon,
    description: '인물과 함께 사용할 자료',
    group: '기본',
  },
  {
    id: 'prompts',
    title: '프롬프트·창작 프리셋',
    icon: PromptIcon,
    description: '작문 지침과 창작 옵션',
    group: '기본',
  },
  {
    id: 'models',
    title: '모델',
    icon: ModelIcon,
    description: '본문과 보조 작업의 모델',
    group: '기본',
  },
  {
    id: 'story',
    title: '상태와 문맥',
    icon: LoreIcon,
    description: '장면 상태와 문맥 관리',
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
    title: '자동 후속 작업',
    icon: BehaviorIcon,
    description: '장면 상태 자동 실행',
    group: '고급',
  },
] as const;
const isProfile = (section: Section): section is ProfileSection =>
  ['characters', 'prompts', 'models'].includes(section);

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
  const [active, setActive] = useState<Section>(initialSection ?? 'characters');
  const [profileTab, setProfileTab] = useState<ProfileSection>(
    initialSection && isProfile(initialSection) ? initialSection : 'characters'
  );
  const [visited, setVisited] = useState<Section[]>([initialSection ?? 'characters']);
  const [detailOpen, setDetailOpen] = useState(!!initialSection);
  const [profileDirty, setProfileDirty] = useState(false);
  const [storyDirty, setStoryDirty] = useState(false);
  const [imageDirty, setImageDirty] = useState(false);
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [runtimeDirty, setRuntimeDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
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
          items={categories.map((item) => ({ ...item, panelId: panelId(item.id) }))}
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
                onGlobalSettings={(section) => requestClose(() => onGlobalSettings(section))}
                nextRequest={state.pendingRequest ?? state.draft}
                loreContextReset={state.loreContextReset}
              />
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
                    {section === 'story' && (
                      <StoryPanel
                        chatId={state.selected}
                        refreshKey={state.detail?.reader.cursor ?? 0}
                        branchId={state.branch?.id ?? `main:${state.selected}`}
                        headRevision={state.branch?.headRevision ?? detail.chat.headRevision}
                        settingsRevision={detail.chat.settingsRevision}
                        profileRevision={detail.profile?.revision}
                        models={library.models}
                        connections={library.connections}
                        active={active === section && showingDetail}
                        hideHeading
                        onDirtyChange={setStoryDirty}
                        onChanged={() => {
                          void state.refresh(state.selected);
                        }}
                        onError={state.setError}
                      />
                    )}
                    {section === 'images' && (
                      <>
                        <AssetEditor
                          chatId={state.selected}
                          assets={detail.assets ?? []}
                          expanded
                          refresh={() => state.refresh(state.selected)}
                          onError={state.setError}
                          onDirtyChange={setImageDirty}
                        />
                        <IllustrationReferencesEditor
                          chatId={state.selected}
                          refreshKey={`${detail.profile?.revision ?? 0}:${(detail.assets ?? []).length}`}
                          onDirtyChange={setReferenceDirty}
                          onError={state.setError}
                        />
                      </>
                    )}
                    {section === 'runtime' && (
                      <SettingsEditor
                        chat={detail.chat}
                        onSaved={() => state.refresh(state.selected)}
                        onError={state.setError}
                        hideHeading
                        onDirtyChange={setRuntimeDirty}
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
        role="alertdialog"
        onClose={() => {
          setDiscard(false);
          afterClose.current = null;
        }}
      >
        <p>저장하지 않은 편집 내용이나 선택한 파일이 있어요. 닫으면 이 초안이 사라져요.</p>
        <DraftDiscardActions
          open={discard}
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
