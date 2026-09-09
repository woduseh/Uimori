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
import { PackageControlValues } from './PackageControlValues.js';
import { resolvePackageStart, type PackageStartSnapshot } from '../core/package-start.js';
import {
  reconcilePromptValues,
  resolvePromptValues,
  type PromptValue,
} from '../core/prompt-program.js';
import './package-authoring.css';
import { useTestMode } from './useTestMode.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import type { PackageRole } from '../core/content-package.js';
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
  const { workspace } = usePromptWorkspace();
  const mainModel = library.models.find((item) => item.id === workspace?.modelRoutes.main?.id);
  const mainAvailable =
    !!mainModel && isModelSelectable(mainModel, library.models, library.connections);
  const testMode = useTestMode();
  const [bot, setBot] = useState(initialBot ? refValue(initialBot) : '');
  const [persona, setPersona] = useState(
    initialPersona
      ? refValue(initialPersona)
      : initialFolder?.defaultPersona
        ? refValue(initialFolder.defaultPersona)
        : ''
  );
  const [modules, setModules] = useState(() => (initialModules ?? []).map(refValue));
  const [title, setTitle] = useState('');
  const [loadedContents, setLoadedContents] = useState<Record<string, Content>>({});
  const [packageLoading, setPackageLoading] = useState(false);
  const [start, setStart] = useState('');
  const [packageValues, setPackageValues] = useState<Record<string, Record<string, PromptValue>>>(
    {}
  );
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
          setPackageValues((previous) => {
            const next = { ...previous };
            for (const item of items) {
              if (!item.package) continue;
              for (const role of ['bot', 'persona', 'module']) {
                const key = `${refValue(item)}:${role}`;
                const prior =
                  previous[key] ??
                  Object.entries(previous)
                    .filter(([key]) => key.startsWith(`${item.id}@`) && key.endsWith(`:${role}`))
                    .sort(
                      ([a], [b]) =>
                        Number(b.split('@').at(-1)?.split(':')[0]) -
                        Number(a.split('@').at(-1)?.split(':')[0])
                    )[0]?.[1];
                if (prior)
                  next[key] = reconcilePromptValues(
                    { version: 1, controls: item.package.controls, blocks: [] },
                    prior
                  ).values;
              }
            }
            return next;
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
    const roleContents: [PackageRole, Content | null | undefined][] = [
      ['bot', selectedBot],
      ['persona', selectedPersona],
      ...selectedModules.map((item): [PackageRole, Content] => ['module', item]),
    ];
    const values = Object.fromEntries(
      roleContents.flatMap(([role, item]) =>
        item?.package
          ? [
              [
                `${refValue(item)}:${role}`,
                resolvePromptValues(
                  { version: 1, controls: item.package.controls, blocks: [] },
                  packageValues[`${refValue(item)}:${role}`]
                ),
              ],
            ]
          : []
      )
    );
    const opening =
      start && selectedBot.package
        ? resolvePackageStart(selectedBot.package, start, values[`${refValue(selectedBot)}:bot`])
        : null;
    if (start && !opening) throw new Error('선택한 시작을 다시 확인해 주세요.');
    if (opening?.mode === 'generate' && !mainAvailable && !testMode)
      throw new Error('첫 장면을 생성하려면 전역 모델 설정에서 본문 모델을 선택해 주세요.');
    const selectedContents = [selectedBot, selectedPersona, ...selectedModules].filter(
      (item): item is Content => !!item
    );
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
              attachments: selectedContents
                .filter((item) => !item.package && !item.hasPackage)
                .map(({ id, revision }) => ({ id, revision })),
              packageAttachments: roleContents.flatMap(([role, item]) =>
                item && (item.package || item.hasPackage)
                  ? [{ id: item.id, revision: item.revision, role }]
                  : []
              ),
              ...(Object.keys(values).length ? { packageValues: values } : {}),
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
      opening = resolvePackageStart(
        activeBot.package,
        start,
        packageValues[`${refValue(activeBot)}:bot`]
      );
    } catch (caught) {
      openingError = (caught as Error).message;
    }
  }
  const packageSettings = (
    [
      ['bot', activeBot, '봇'],
      ['persona', activePersona, '페르소나'],
      ...activeModules.map((item) => ['module', item, '모듈'] as const),
    ] as const
  ).map(([role, item, label]) =>
    item?.package?.controls.length ? (
      <fieldset key={`${refValue(item)}:${role}`}>
        <legend>이번 채팅의 {label} 설정</legend>
        <PackageControlValues
          controls={item.package.controls}
          values={packageValues[`${refValue(item)}:${role}`]}
          labelPrefix={`시작 ${label} 옵션`}
          disabled={locked || packageLoading}
          onChange={(values) =>
            setPackageValues((previous) => ({
              ...previous,
              [`${refValue(item)}:${role}`]: values,
            }))
          }
        />
      </fieldset>
    ) : null
  );
  const additionalSummary = [
    activePersona ? '페르소나 선택됨' : '',
    modules.length ? `모듈 ${modules.length}개` : '',
    title.trim() ? '이름 지정됨' : '',
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
      {initialBot ? (
        <div className="new-story-bot" aria-label="채팅의 봇">
          <ContentAvatar content={activeBot ?? initialBot} />
          <strong>{initialBot.title}</strong>
          <p className="muted">
            {initialFolder
              ? `${initialFolder.title} 폴더에서 새 채팅을 시작해요.`
              : '이 봇과 새 채팅을 시작해요.'}
          </p>
        </div>
      ) : (
        <>
          <p className="muted">함께할 봇을 고르면 현재 전역 모델과 프롬프트로 시작해요.</p>
          <ContentPicker
            library={{ ...library, contents }}
            role="bot"
            label="시작할 봇"
            value={bot}
            selectedContent={activeBot}
            onChange={(value) => {
              setBot(value);
              setStart('');
            }}
            disabled={locked}
          />
        </>
      )}
      <div className="new-story-main-model">
        <p>모든 채팅에 현재 전역 모델과 프롬프트를 사용해요.</p>
        <p>본문 모델: {mainModel?.title ?? '미지정'}</p>
        {!mainAvailable && (
          <p role="status">
            본문 생성 전에 사용 가능한 전역 본문 모델을 선택해 주세요. 채팅만 먼저 만들 수도 있어요.
          </p>
        )}
        <button type="button" className="secondary" disabled={locked} onClick={onModelSettings}>
          전역 모델 설정
        </button>
      </div>
      {packageLoading && <p role="status">시작 자료를 불러오는 중이에요…</p>}
      {!!activeBot?.package?.starts?.length && (
        <fieldset>
          <legend>첫 장면</legend>
          <label>
            사용할 시작
            <select
              aria-label="사용할 시작"
              value={start}
              disabled={locked || packageLoading}
              onChange={(event) => {
                const id = event.target.value;
                setStart(id);
                const pkg = activeBot.package!;
                const values = id
                  ? resolvePackageStart(pkg, id).values
                  : resolvePromptValues({ version: 1, controls: pkg.controls, blocks: [] });
                setPackageValues((previous) => ({
                  ...previous,
                  [`${refValue(activeBot)}:bot`]: values,
                }));
              }}
            >
              <option value="">직접 첫 장면 요청하기</option>
              {activeBot.package.starts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.mode === 'authored' ? '작성된 도입문' : '모델 생성'}
                </option>
              ))}
            </select>
          </label>
          {opening && (
            <>
              <p className="muted">
                {activeBot.package.starts.find((item) => item.id === start)?.description}
              </p>
              <div
                className="source-text"
                aria-label="시작 미리보기"
                style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}
              >
                {opening.text}
              </div>
              <p className="muted">
                {opening.mode === 'authored'
                  ? '확정하면 이 도입문을 원문 그대로 저장해요. 모델을 호출하지 않아요.'
                  : '확정하면 이 요청으로 선택한 본문 모델을 호출해요.'}
                {opening.initialAction && ' 초기 행동은 확정할 때 한 번 실행해요.'}
              </p>
            </>
          )}
          {openingError && (
            <p className="error" role="alert">
              {openingError}
            </p>
          )}
        </fieldset>
      )}
      {packageSettings[0]}
      <details className="new-story-options">
        <summary>
          <span>추가 설정</span>
          <small>{additionalSummary || '페르소나, 모듈, 채팅 이름'}</small>
        </summary>
        <div className="new-story-options-content">
          <ContentPicker
            library={{ ...library, contents }}
            role="persona"
            label="시작 페르소나"
            value={persona}
            selectedContent={activePersona}
            onChange={setPersona}
            allowNone
            noneLabel="페르소나 없음"
            disabled={locked}
          />
          <fieldset>
            <legend>함께 사용할 모듈</legend>
            {modules.map((key) => {
              const item = activeModules.find((item) => refValue(item) === key);
              return (
                <div className="new-story-module" key={key}>
                  <ContentAvatar content={item} title="모듈 확인 중" />
                  <span>{item?.title ?? '모듈 확인 중…'}</span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={locked}
                    aria-label={`${item?.title ?? '모듈'} 선택 해제`}
                    onClick={() => setModules((values) => values.filter((value) => value !== key))}
                  >
                    해제
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
              label="추가할 시작 모듈"
              value=""
              onChange={(value) =>
                setModules((values) => (values.includes(value) ? values : [...values, value]))
              }
              excludeIds={modules.map((key) => key.slice(0, key.lastIndexOf('@')))}
              disabled={locked}
            />
          </fieldset>
          {packageSettings.slice(1)}
          <label>
            채팅 이름 <small>비워 두면 자동으로 정해요</small>
            <input
              aria-label="새 채팅 이름"
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
          {error}
          {created.current && ' 채팅은 하나만 만들었어요. 설정 저장만 다시 시도해요.'}
        </p>
      )}
      <button
        disabled={
          busy ||
          uncertain.current ||
          !bot ||
          packageLoading ||
          !!openingError ||
          (opening?.mode === 'generate' && !mainAvailable && !testMode)
        }
      >
        {busy
          ? '채팅을 준비하는 중…'
          : created.current
            ? '설정 저장 다시 시도'
            : opening
              ? opening.mode === 'authored'
                ? '도입문 확정하고 채팅 만들기'
                : '첫 장면 생성하고 채팅 만들기'
              : '채팅 만들기'}
      </button>
    </form>
  );
}
