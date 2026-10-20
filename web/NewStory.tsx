import { t, useI18n, translateMessage, message as retainedMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { RisuStartPreview } from './RisuStartPreview.js';
import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../core/types.js';
import type { Content, Library } from '../core/product.js';
import { api } from './api.js';
import { refValue } from './content-ref.js';
import {
  completePendingStoryProfile,
  savePendingStoryProfile,
  type NewStoryProfileIntent,
} from './pendingStory.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { isModelSelectable } from './model-selection.js';
import type { ChatFolder } from './BotNavigation.js';
import { resolvePackageStart, type PackageStartSnapshot } from '../core/package-start.js';
import './package-authoring.css';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import type { ContentRole } from '../core/risu-content.js';
import { newChatPersona, type BotDefaults } from '../core/bot-defaults.js';
import './new-story.css';

type StorySelection = {
  title: string;
  autoTitle: boolean;
  bot: Content | null;
  persona: Content | null;
  modules: Content[];
  profile: NewStoryProfileIntent | null;
};

const selectedId = (key: string) => key.slice(0, key.lastIndexOf('@'));

function OpeningPreview({
  content,
  opening,
  userName,
}: {
  content: Content;
  opening: PackageStartSnapshot;
  userName?: string;
}) {
  useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="new-story-opening-preview">
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{t('transfer.m310')}</summary>
        {expanded && (
          <div className="new-story-opening-full" aria-label={t('transfer.m311')}>
            <RisuStartPreview content={content} startId={opening.startId} userName={userName} />
          </div>
        )}
      </details>
    </div>
  );
}

export function NewStory({
  library,
  initialBot,
  initialFolder,
  initialPersona,
  initialModules,
  onModelSettings,
  onCreated,
}: {
  library: Library;
  initialBot?: Content;
  initialFolder?: ChatFolder;
  initialPersona?: Content;
  initialModules?: Content[];
  onModelSettings: () => void;
  onCreated: (chat: Chat) => Promise<void>;
}) {
  useI18n();
  const { workspace, error: workspaceError, refresh: refreshWorkspace } = usePromptWorkspace();
  const [refreshingWorkspace, setRefreshingWorkspace] = useState(false);
  async function reloadWorkspace() {
    if (refreshingWorkspace) return;
    setRefreshingWorkspace(true);
    try {
      await refreshWorkspace();
    } finally {
      setRefreshingWorkspace(false);
    }
  }
  const mainModel = library.models.find((item) => item.id === workspace?.modelRoutes.main?.id);
  const mainAvailable =
    !!mainModel && isModelSelectable(mainModel, library.models, library.connections);
  const [bot, setBot] = useState(initialBot ? refValue(initialBot) : '');
  const [persona, setPersona] = useState(initialPersona ? refValue(initialPersona) : '');
  const [modules, setModules] = useState(() => (initialModules ?? []).map(refValue));
  const [personaChosen, setPersonaChosen] = useState(initialPersona !== undefined);
  const [defaultsBotId, setDefaultsBotId] = useState('');
  const [defaultsError, setDefaultsError] = useState('');
  const [title, setTitle] = useState('');
  const [loadedContents, setLoadedContents] = useState<Record<string, Content>>({});
  const [packageLoading, setPackageLoading] = useState(false);
  const [start, setStart] = useState(
    initialBot?.package?.nativeRisu &&
      initialBot.package.starts?.some((item) => item.id === 'start-0')
      ? 'start-0'
      : ''
  );
  const initializedStart = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const created = useRef<Chat | null>(null);
  const uncertain = useRef(false);
  const submitted = useRef<StorySelection | null>(null);
  const creating = useRef(false);
  const profileRecorded = useRef(false);
  useEffect(() => {
    if (initialBot && !submitted.current) setBot(refValue(initialBot));
  }, [initialBot]);
  const botId = bot ? selectedId(bot) : '';
  useEffect(() => {
    if (!botId || personaChosen || submitted.current) return;
    let alive = true;
    setDefaultsBotId('');
    setDefaultsError('');
    void api<BotDefaults>(`/bots/${encodeURIComponent(botId)}/defaults`)
      .then((defaults) => {
        if (!alive || submitted.current) return;
        const selected = newChatPersona(defaults.persona, initialFolder?.defaultPersona);
        const current = selected && library.contents.find((item) => item.id === selected.id);
        if (selected && !current) {
          setDefaultsError(retainedMessage('transfer.m312'));
          setPersona('');
        } else {
          setPersona(current ? refValue(current) : '');
          setDefaultsBotId(botId);
        }
      })
      .catch((cause) => {
        if (alive) setDefaultsError((cause as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [botId, personaChosen, initialFolder?.defaultPersona, library.contents]);
  const defaultsReady = personaChosen || defaultsBotId === botId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selections and library updates refresh current content; writing the cache must not restart its own load.
  useEffect(() => {
    if (submitted.current) return;
    let current = true;
    const selected = [...new Set([bot, persona, ...modules].filter(Boolean))];
    setPackageLoading(true);
    void Promise.all(
      selected.map(async (key) => {
        const item = [initialBot, initialPersona, ...(initialModules ?? []), ...library.contents]
          .filter((item): item is Content => !!item && item.id === selectedId(key))
          .sort((a, b) => b.revision - a.revision)[0];
        if (loadedContents[key] && (!item || loadedContents[key].revision >= item.revision))
          return loadedContents[key];
        if (
          item &&
          (!item.hasPackage || item.package) &&
          (item === initialBot ||
            item === initialPersona ||
            initialModules?.includes(item) ||
            !library.contentBodiesOmitted)
        )
          return item;
        return api<Content>(`/content/${encodeURIComponent(selectedId(key))}`);
      })
    )
      .then((items) => {
        if (current && !submitted.current) {
          setLoadedContents((previous) => ({
            ...previous,
            ...Object.fromEntries(items.map((item, index) => [selected[index], item])),
            ...Object.fromEntries(items.map((item) => [refValue(item), item])),
          }));
          const currentKey = (key: string) => {
            const item = items.find((item) => item.id === selectedId(key));
            return item ? refValue(item) : key;
          };
          setBot(currentKey);
          setPersona(currentKey);
          setModules((previous) => {
            const next = previous.map(currentKey);
            return next.some((key, index) => key !== previous[index]) ? next : previous;
          });
        }
      })
      .catch((caught) => {
        if (current) setError((caught as Error).message);
      })
      .finally(() => {
        if (current) setPackageLoading(false);
      });
    return () => {
      current = false;
    };
  }, [bot, persona, modules, library, initialBot, initialPersona, initialModules]);
  function captureSelection(): StorySelection {
    if (!defaultsReady) throw new Error('기본 페르소나를 확인한 뒤 시작해 주세요.');
    if (packageLoading) throw new Error('선택한 자료를 불러온 뒤 시작해 주세요.');
    const selectedBot = bot
      ? (loadedContents[bot] ??
        [initialBot, ...library.contents].find((item) => item && refValue(item) === bot))
      : null;
    const selectedPersona = persona
      ? (loadedContents[persona] ??
        [initialPersona, ...library.contents].find(
          (item) =>
            item &&
            (item.kind === 'persona' || item.hasPackage || item.package) &&
            refValue(item) === persona
        ))
      : null;
    const selectedModules = modules.map((key) => loadedContents[key]);
    if (selectedModules.some((item) => !item))
      throw new Error('선택한 모듈을 불러온 뒤 시작해 주세요.');
    if (!selectedBot || (persona && !selectedPersona))
      throw new Error('채팅의 소속 봇을 선택해 주세요. 목록이 바뀌었다면 자료를 다시 골라 주세요.');
    if (
      [selectedBot, selectedPersona, ...selectedModules].some(
        (item) => item?.hasPackage && !item.package
      )
    )
      throw new Error('선택한 패키지 본문을 불러오지 못했어요. 자료를 다시 골라 주세요.');
    const roleContents: [ContentRole, Content | null | undefined][] = [
      ['bot', selectedBot],
      ['persona', selectedPersona],
      ...selectedModules.map((item): [ContentRole, Content] => ['module', item]),
    ];
    const opening =
      start && selectedBot.package ? resolvePackageStart(selectedBot.package, start) : null;
    if (start && !opening) throw new Error('선택한 시작을 다시 확인해 주세요.');
    return structuredClone({
      title:
        title.trim() || (selectedBot ? `${selectedBot.title}의 채팅`.slice(0, 100) : '새로운 채팅'),
      autoTitle: !title.trim(),
      bot: selectedBot ?? null,
      persona: selectedPersona ?? null,
      modules: selectedModules,
      profile:
        selectedBot || selectedPersona
          ? {
              packageAttachments: roleContents.flatMap(([role, item]) =>
                item && (item.package || item.hasPackage)
                  ? [{ id: item.id, revision: item.revision, role }]
                  : []
              ),
              ...(opening
                ? {
                    packageStart: {
                      packageId: opening.packageId,
                      packageRevision: opening.packageRevision,
                      startId: opening.startId,
                      idempotencyKey: crypto.randomUUID(),
                    },
                  }
                : {}),
            }
          : null,
    });
  }
  async function create() {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError('');
    try {
      const selection = (submitted.current ??= captureSelection());
      if (!created.current) {
        if (uncertain.current)
          throw new Error(
            '채팅 생성 응답을 확인하지 못했어요. 목록을 새로 확인한 뒤 이어서 설정해 주세요. 중복 생성을 막기 위해 자동 재전송하지 않아요.'
          );
        uncertain.current = true;
        created.current = await api<Chat>('/chats', {
          title: selection.title,
          autoTitle: selection.autoTitle,
          botId: selection.bot!.id,
          folderId: initialFolder?.id ?? null,
          persona: selection.persona
            ? { id: selection.persona.id, revision: selection.persona.revision }
            : null,
        });
        uncertain.current = false;
      }
      const chat = created.current;
      if (selection.profile) {
        if (!profileRecorded.current) {
          // Persist the intent before the next request so even a failed profile GET
          // leaves the new chat blocked until its original choices are saved.
          savePendingStoryProfile(chat.id, {
            ...selection.profile,
            ...(selection.profile.packageStart
              ? {
                  packageStart: {
                    ...selection.profile.packageStart,
                    expectedSettingsRevision: chat.settingsRevision,
                  },
                }
              : {}),
          });
          profileRecorded.current = true;
        }
        await completePendingStoryProfile(chat.id);
      }
      await onCreated(chat);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }
  const frozen = submitted.current;
  const locked = busy || !!frozen;
  const frozenContents = [frozen?.bot, frozen?.persona, ...(frozen?.modules ?? [])].filter(
    (item): item is Content => !!item
  );
  const contents = library.contents.map(
    (item) => frozenContents.find((selected) => refValue(selected) === refValue(item)) ?? item
  );
  for (const item of frozenContents)
    if (!contents.some((current) => refValue(current) === refValue(item))) contents.push(item);
  const activeBot =
    frozen?.bot ??
    loadedContents[bot] ??
    (initialBot && refValue(initialBot) === bot
      ? initialBot
      : contents.find((item) => refValue(item) === bot));
  const activeStartKey = activeBot ? refValue(activeBot) : '';
  useEffect(() => {
    if (!activeBot?.package || initializedStart.current === activeStartKey) return;
    initializedStart.current = activeStartKey;
    setStart(
      activeBot.package.nativeRisu &&
        activeBot.package.starts?.some((item) => item.id === 'start-0')
        ? 'start-0'
        : ''
    );
  }, [activeStartKey, activeBot]);
  const activePersona = frozen
    ? frozen.persona
    : persona
      ? (loadedContents[persona] ??
        (initialPersona && refValue(initialPersona) === persona
          ? initialPersona
          : contents.find((item) => refValue(item) === persona)))
      : null;
  const activeModules =
    frozen?.modules ?? modules.map((key) => loadedContents[key]).filter(Boolean);
  let opening: PackageStartSnapshot | null = null,
    openingError = '';
  if (start && activeBot?.package) {
    try {
      opening = resolvePackageStart(activeBot.package, start);
    } catch (caught) {
      openingError = (caught as Error).message;
    }
  }
  const additionalSummary = [
    modules.length ? t('transfer.d028', { v0: modules.length }) : '',
    title.trim() ? t('transfer.m321') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <form
      className="new-story"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="new-story-fields">
        {initialBot ? (
          <div className="new-story-bot" aria-label={t('transfer.m322')}>
            <ContentAvatar content={activeBot ?? initialBot} />
            <strong>{initialBot.title}</strong>
            <p className="muted">
              {initialFolder ? t('transfer.d029', { v0: initialFolder.title }) : t('transfer.m323')}
            </p>
          </div>
        ) : (
          <>
            <p className="muted">{t('transfer.m324')}</p>
            <ContentPicker
              library={{ ...library, contents }}
              role="bot"
              label={t('transfer.m325')}
              value={bot}
              selectedContent={activeBot}
              onChange={(value) => {
                setBot(value);
                initializedStart.current = null;
                setStart('');
              }}
              disabled={locked}
            />
          </>
        )}
        <ContentPicker
          library={{ ...library, contents }}
          role="persona"
          label={t('transfer.m326')}
          value={persona}
          selectedContent={activePersona}
          onChange={(value) => {
            setPersonaChosen(true);
            setDefaultsError('');
            setPersona(value);
          }}
          allowNone
          noneLabel={t('transfer.m327')}
          disabled={locked}
        />
        {!defaultsReady && !defaultsError && (
          <LoadingState presentation="inline" label={t('transfer.m328')} />
        )}
        {defaultsError && (
          <p className="error" role="alert">
            {translateMessage(defaultsError)}
          </p>
        )}
        <div className="new-story-main-model" aria-label={t('transfer.m329')}>
          {!workspace ? (
            <LoadingState
              presentation="inline"
              loading={refreshingWorkspace || !workspaceError}
              error={refreshingWorkspace ? '' : translateMessage(workspaceError)}
              errorLabel={t('transfer.m330')}
              label={t('transfer.m331')}
              onRetry={() => void reloadWorkspace()}
            />
          ) : (
            <>
              <dl className="new-story-settings-summary">
                <div>
                  <dt>{t('transfer.m332')}</dt>
                  <dd>
                    {mainModel?.title ?? t('transfer.m333')} <span>{t('transfer.m334')}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('transfer.m074')}</dt>
                  <dd>
                    {workspace.main.title} <span>{t('transfer.m334')}</span>
                  </dd>
                </div>
              </dl>
              {!mainAvailable && (
                <NoticeBanner
                  actions={
                    <button
                      type="button"
                      className="ghost"
                      disabled={locked}
                      onClick={onModelSettings}
                    >
                      {t('transfer.m335')}
                    </button>
                  }
                >
                  {t('transfer.m336')}
                </NoticeBanner>
              )}
              {mainAvailable && (
                <button type="button" className="ghost" disabled={locked} onClick={onModelSettings}>
                  {t('transfer.m335')}
                </button>
              )}
              {refreshingWorkspace && (
                <LoadingState presentation="inline" label={t('transfer.m337')} />
              )}
              {workspaceError && !refreshingWorkspace && (
                <NoticeBanner
                  tone="error"
                  actions={
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void reloadWorkspace()}
                    >
                      {t('transfer.m338')}
                    </button>
                  }
                >
                  {t('transfer.m339')} {translateMessage(workspaceError)}
                </NoticeBanner>
              )}
            </>
          )}
        </div>
        {packageLoading && <LoadingState presentation="inline" label={t('transfer.m340')} />}
        {!!activeBot?.package?.starts?.length && (
          <section className="new-story-opening" aria-label={t('transfer.m029')}>
            <label>
              {t('transfer.m029')}
              <select
                aria-label={t('transfer.m341')}
                value={start}
                disabled={locked || packageLoading}
                onChange={(event) => {
                  const id = event.target.value;
                  if (id === start) return;
                  setStart(id);
                }}
              >
                <option value="">{t('transfer.m342')}</option>
                {activeBot.package.starts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            {opening && (
              <OpeningPreview
                key={`${activeStartKey}:${start}`}
                content={activeBot}
                opening={opening}
                userName={activePersona?.package?.identity?.name ?? activePersona?.title}
              />
            )}
            {openingError && (
              <p className="error" role="alert">
                {translateMessage(openingError)}
              </p>
            )}
          </section>
        )}
        <details className="new-story-options">
          <summary>
            <span>{t('transfer.m343')}</span>
            <small>{additionalSummary || t('transfer.m344')}</small>
          </summary>
          <div className="new-story-options-content">
            <fieldset>
              <legend>{t('transfer.m345')}</legend>
              {modules.map((key) => {
                const item = activeModules.find((item) => refValue(item) === key);
                return (
                  <div className="new-story-module" key={key}>
                    <ContentAvatar content={item} title={t('transfer.m346')} />
                    <span>{item?.title ?? t('transfer.m347')}</span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={locked}
                      aria-label={t('transfer.d030', { v0: item?.title ?? t('transfer.m003') })}
                      onClick={() =>
                        setModules((values) => values.filter((value) => value !== key))
                      }
                    >
                      {t('transfer.m348')}
                    </button>
                  </div>
                );
              })}
              <ContentPicker
                library={{
                  ...library,
                  contents: contents.filter((item) => item.hasPackage || item.package),
                }}
                role="module"
                label={t('transfer.m349')}
                value=""
                onChange={(value) =>
                  setModules((values) => (values.includes(value) ? values : [...values, value]))
                }
                excludeIds={modules.map((key) => key.slice(0, key.lastIndexOf('@')))}
                disabled={locked}
              />
            </fieldset>
            <label>
              {t('transfer.m221')}
              <small>{t('transfer.m350')}</small>
              <input
                aria-label={t('transfer.m351')}
                value={title}
                maxLength={100}
                onChange={(e) => setTitle(e.target.value)}
                disabled={locked}
              />
            </label>
          </div>
        </details>
        {error && (
          <p className="error" role="alert">
            {translateMessage(error)}
            {created.current && t('transfer.m352')}
          </p>
        )}
      </div>
      <div className="new-story-submit">
        <button
          className="primary"
          disabled={
            busy || uncertain.current || !bot || !defaultsReady || packageLoading || !!openingError
          }
        >
          {busy ? t('transfer.m353') : created.current ? t('transfer.m354') : t('transfer.m355')}
        </button>
      </div>
    </form>
  );
}
