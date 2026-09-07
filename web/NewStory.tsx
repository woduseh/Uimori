import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../core/types.js';
import type {
  Content,
  Library,
  ModelPreset,
  PromptPreset,
  SavedPromptCombination,
} from '../core/product.js';
import { api } from './api.js';
import { refValue } from './LibraryPanel.js';
import { modelLabel } from './storyLabels.js';
import {
  completePendingStoryProfile,
  savePendingStoryProfile,
  type NewStoryProfileIntent,
} from './pendingStory.js';
import { useModelSelection } from './model-selection.js';
import type { ChatFolder } from './BotNavigation.js';
import { PackageControlValues } from './PackageControlValues.js';
import { resolvePackageStart, type PackageStartSnapshot } from '../core/package-start.js';
import { resolvePromptValues, type PromptValue } from '../core/prompt-program.js';
import './package-authoring.css';

type StorySelection = {
  title: string;
  bot: Content | null;
  persona: Content | null;
  prompt: PromptPreset | null;
  combination: SavedPromptCombination | null;
  main: ModelPreset | null;
  translation: ModelPreset | null;
  profile: NewStoryProfileIntent | null;
};

const modelsKey = 'uimori:new-story-models';
function rememberedModels(library: Library): { main: string; translation: string } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(modelsKey) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved))
      return { main: '', translation: '' };
    const choices = saved as Record<string, unknown>;
    const available = library.models.filter((model) => model.enabled !== false);
    const restore = (role: string) =>
      available.some((item) => item.id === choices[role]) ? String(choices[role]) : '';
    return { main: restore('main'), translation: restore('translation') };
  } catch {
    return { main: '', translation: '' };
  }
}

export function NewStory({
  library,
  initialBot,
  initialFolder,
  onCreated,
}: {
  library: Library;
  initialBot?: Content;
  initialFolder?: ChatFolder;
  onCreated: (chat: Chat) => Promise<void>;
}) {
  const { choices } = useModelSelection(library.models, library.connections);
  const [bot, setBot] = useState(initialBot ? refValue(initialBot) : '');
  const [persona, setPersona] = useState(
    initialFolder?.defaultPersona ? refValue(initialFolder.defaultPersona) : ''
  );
  const [prompt, setPrompt] = useState('');
  const [combination, setCombination] = useState('');
  const [models, setModels] = useState(() => rememberedModels(library));
  const [title, setTitle] = useState('');
  const [search, setSearch] = useState('');
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
  const availableModelKeys = JSON.stringify(choices.map((item) => item.id));
  useEffect(() => {
    if (initialBot && !submitted.current) setBot(refValue(initialBot));
  }, [initialBot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection changes read the revision cache; writing loadedContents must not restart its own load.
  useEffect(() => {
    if (submitted.current) return;
    let current = true;
    const selected = [bot, persona].filter(Boolean);
    const items = selected
      .map((key) =>
        [initialBot, ...library.contents].find((item) => item && refValue(item) === key)
      )
      .filter((item): item is Content => !!item);
    setPackageLoading(true);
    void Promise.all(
      items.map(async (item) => {
        const key = refValue(item);
        if (loadedContents[key]) return loadedContents[key];
        if (
          item === initialBot ||
          (!library.contentBodiesOmitted && (!item.hasPackage || item.package))
        )
          return item;
        return api<Content>(`/revisions/content/${item.id}/${item.revision}`);
      })
    )
      .then((items) => {
        if (current)
          setLoadedContents((previous) => ({
            ...previous,
            ...Object.fromEntries(items.map((item) => [refValue(item), item])),
          }));
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
  }, [bot, persona, library, initialBot]);
  useEffect(() => {
    // A submitted profile intent keeps its model IDs while settings remain editable.
    if (submitted.current) return;
    setModels((previous) => {
      const available = new Set<string>(JSON.parse(availableModelKeys));
      const main = available.has(previous.main) ? previous.main : '',
        translation = available.has(previous.translation) ? previous.translation : '';
      return main === previous.main && translation === previous.translation
        ? previous
        : { main, translation };
    });
  }, [availableModelKeys]);
  function captureSelection(): StorySelection {
    if (packageLoading) throw new Error('선택한 자료를 불러온 뒤 시작해 주세요.');
    const selectedBot = bot
      ? (loadedContents[bot] ??
        [initialBot, ...library.contents].find((item) => item && refValue(item) === bot))
      : null;
    const selectedPersona = persona
      ? (loadedContents[persona] ??
        library.contents.find(
          (item) =>
            (item.kind === 'persona' || item.hasPackage || item.package) &&
            refValue(item) === persona
        ))
      : null;
    const available = choices;
    const main = models.main ? available.find((item) => item.id === models.main) : null;
    const translation = models.translation
      ? available.find((item) => item.id === models.translation)
      : null;
    if ((models.main && !main) || (models.translation && !translation))
      throw new Error(
        '선택한 모델을 사용할 수 없어요. 연결과 모델 목록을 확인한 뒤 다시 골라 주세요.'
      );
    if (!selectedBot || (persona && !selectedPersona))
      throw new Error('채팅의 소속 봇을 선택해 주세요. 목록이 바뀌었다면 자료를 다시 골라 주세요.');
    if ([selectedBot, selectedPersona].some((item) => item?.hasPackage && !item.package))
      throw new Error('선택한 패키지 본문을 불러오지 못했어요. 자료를 다시 골라 주세요.');
    const values = Object.fromEntries(
      (
        [
          ['bot', selectedBot],
          ['persona', selectedPersona],
        ] as const
      ).flatMap(([role, item]) =>
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
    const selectedPrompt = library.promptPresets?.find(
      (p) => refValue(p) === prompt && p.role === 'main'
    );
    const selectedCombination = library.promptCombinations?.find(
      (c) =>
        refValue(c) === combination &&
        selectedPrompt &&
        refValue(c.prompt) === refValue(selectedPrompt)
    );
    if ((prompt && !selectedPrompt) || (combination && !selectedCombination))
      throw new Error('프롬프트와 창작 프리셋의 조합을 다시 확인해 주세요.');
    const selectedContents = [selectedBot, selectedPersona].filter(
      (item): item is Content => !!item
    );
    return structuredClone({
      title:
        title.trim() || (selectedBot ? `${selectedBot.title}의 채팅`.slice(0, 100) : '새로운 채팅'),
      bot: selectedBot ?? null,
      persona: selectedPersona ?? null,
      prompt: selectedPrompt ?? null,
      combination: selectedCombination ?? null,
      main: main ?? null,
      translation: translation ?? null,
      profile:
        selectedBot || selectedPersona || selectedPrompt || main || translation
          ? {
              attachments: selectedContents
                .filter((item) => !item.package && !item.hasPackage)
                .map(({ id, revision }) => ({ id, revision })),
              packageAttachments: (
                [
                  ['bot', selectedBot],
                  ['persona', selectedPersona],
                ] as const
              ).flatMap(([role, item]) =>
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
              ...(selectedPrompt
                ? {
                    prompts: { main: { id: selectedPrompt.id, revision: selectedPrompt.revision } },
                  }
                : {}),
              ...(selectedPrompt && selectedCombination
                ? {
                    promptControls: {
                      [refValue(selectedPrompt)]: {
                        values: selectedCombination.values,
                        combinations: [],
                      },
                    },
                  }
                : {}),
              ...(main || translation
                ? {
                    models: {
                      main: main ? { id: main.id } : null,
                      translation: translation ? { id: translation.id } : null,
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
      localStorage.setItem(
        modelsKey,
        JSON.stringify({
          main: selection.main ? selection.main.id : '',
          translation: selection.translation ? selection.translation.id : '',
        })
      );
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
  const frozenContents = [frozen?.bot, frozen?.persona].filter((item): item is Content => !!item);
  const contents = library.contents.map(
    (item) => frozenContents.find((selected) => refValue(selected) === refValue(item)) ?? item
  );
  for (const item of frozenContents)
    if (!contents.some((current) => refValue(current) === refValue(item))) contents.push(item);
  const prompts = [...(library.promptPresets ?? [])];
  if (frozen?.prompt && !prompts.some((item) => refValue(item) === refValue(frozen.prompt!)))
    prompts.push(frozen.prompt);
  const combinations = [...(library.promptCombinations ?? [])];
  if (
    frozen?.combination &&
    !combinations.some((item) => refValue(item) === refValue(frozen.combination!))
  )
    combinations.push(frozen.combination);
  for (const selected of [frozen?.main, frozen?.translation])
    if (selected && !choices.some((item) => item.id === selected.id)) choices.push(selected);
  const bots = contents.filter(
    (item) =>
      (initialBot
        ? item.id === initialBot.id
        : item.kind === 'bot' || item.hasPackage || item.package) &&
      `${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase())
  );
  const activeBot =
    frozen?.bot ??
    loadedContents[bot] ??
    (initialBot && refValue(initialBot) === bot
      ? initialBot
      : contents.find((item) => refValue(item) === bot));
  const activePersona = frozen?.persona ?? loadedContents[persona];
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
  return (
    <form
      className="new-story"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <p className="muted">함께할 봇을 고르고, 첫 장면으로 시작해요.</p>
      <label>
        봇 찾기
        <input
          aria-label="시작할 봇 찾기"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={locked}
        />
      </label>
      <div className="bot-picker" role="group" aria-label="시작할 봇">
        {bots.map((item) => (
          <button
            type="button"
            key={refValue(item)}
            className={`bot-option ${bot === refValue(item) ? 'chosen' : ''}`}
            aria-pressed={bot === refValue(item)}
            onClick={() => {
              setBot(refValue(item));
              setStart('');
            }}
            disabled={locked || !!initialBot}
          >
            <strong>{item.title}</strong>
            <small>{item.description || '이 자료를 봇으로 사용해 채팅을 시작해요'}</small>
          </button>
        ))}
      </div>
      <label>
        페르소나
        <select
          aria-label="시작 페르소나"
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          disabled={locked}
        >
          <option value="">페르소나 없음</option>
          {contents
            .filter((item) => item.kind === 'persona' || item.hasPackage || item.package)
            .map((item) => (
              <option key={refValue(item)} value={refValue(item)}>
                {item.title}
              </option>
            ))}
        </select>
      </label>
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
      {(
        [
          ['bot', activeBot, '봇'],
          ['persona', activePersona, '페르소나'],
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
      )}
      <label>
        프롬프트
        <select
          aria-label="시작 프롬프트"
          value={prompt}
          disabled={locked}
          onChange={(e) => {
            setPrompt(e.target.value);
            setCombination('');
          }}
        >
          <option value="">기본 프롬프트</option>
          {prompts
            .filter((p) => p.role === 'main')
            .map((p) => (
              <option value={refValue(p)} key={refValue(p)}>
                {p.title}
              </option>
            ))}
        </select>
      </label>
      {prompt && (
        <label>
          창작 프리셋
          <select
            aria-label="시작 옵션 조합"
            value={combination}
            disabled={locked}
            onChange={(e) => setCombination(e.target.value)}
          >
            <option value="">프롬프트 기본값</option>
            {combinations
              .filter((c) => refValue(c.prompt) === prompt)
              .map((c) => (
                <option value={refValue(c)} key={refValue(c)}>
                  {c.title}
                </option>
              ))}
          </select>
        </label>
      )}
      <fieldset className="start-models">
        <legend>본문과 한국어 번역</legend>
        <label>
          본문 모델
          <select
            aria-label="시작 본문 모델"
            value={models.main}
            onChange={(event) => setModels((value) => ({ ...value, main: event.target.value }))}
            disabled={locked}
          >
            <option value="">검사용 모의 생성 · 실제 모델 없음</option>
            {models.main && !choices.some((item) => item.id === models.main) && (
              <option value={models.main} disabled>
                이전 선택 · 연결 확인 또는 재선택 필요
              </option>
            )}
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {modelLabel(item, library)}
              </option>
            ))}
          </select>
        </label>
        <label>
          한국어 번역 모델
          <select
            aria-label="시작 번역 모델"
            value={models.translation}
            onChange={(event) =>
              setModels((value) => ({ ...value, translation: event.target.value }))
            }
            disabled={locked}
          >
            <option value="">검사용 모의 번역 · 실제 모델 없음</option>
            {models.translation && !choices.some((item) => item.id === models.translation) && (
              <option value={models.translation} disabled>
                이전 선택 · 연결 확인 또는 재선택 필요
              </option>
            )}
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                {modelLabel(item, library)}
              </option>
            ))}
          </select>
        </label>
        <small>
          선택한 모델은 다음 채팅에도 제안해요. 채팅을 만든 뒤 장면을 보내면 본문을 생성해요. 번역은
          번역 보기를 눌렀을 때 시작해요.
        </small>
      </fieldset>
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
      {error && (
        <p className="error" role="alert">
          {error}
          {created.current && ' 채팅은 하나만 만들었어요. 설정 저장만 다시 시도해요.'}
        </p>
      )}
      <button disabled={busy || uncertain.current || !bot || packageLoading || !!openingError}>
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
