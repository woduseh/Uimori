import { LoadingState } from './LoadingState.js';
import { useEffect, useRef, useState } from 'react';
import type { ChatProfile, Library } from '../core/product.js';
import type { RisuContent, ContentAttachment } from '../core/risu-content.js';
import { api } from './api.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import './package-authoring.css';
const keyOf = (ref: ContentAttachment) => `${ref.id}@${ref.revision}:${ref.role}`;
const refValue = (ref: { id: string; revision: number }) => `${ref.id}@${ref.revision}`;
type ResolvedPackages = {
  attachments: ContentAttachment[];
  packages: RisuContent[];
  required: ContentAttachment[];
};
const requestKey = (chatId: string, attachments: ContentAttachment[]) =>
  `${chatId}/${JSON.stringify(attachments)}`;

export function ContentAttachments({
  profile,
  library,
  onChange,
  onError,
  onPendingChange,
}: {
  profile: ChatProfile;
  library: Library;
  onChange: (profile: ChatProfile) => void;
  onError: (message: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const attachments = profile.packageAttachments ?? [],
    viewKey = requestKey(profile.chatId, attachments);
  const [resolved, setResolved] = useState<{ key: string; value: ResolvedPackages } | null>(null),
    [busy, setBusy] = useState(false),
    [loadError, setLoadError] = useState(''),
    [reload, setReload] = useState(0);
  const latest = useRef({ profile, onChange, onError, viewKey, library });
  latest.current = { profile, onChange, onError, viewKey, library };
  const version = useRef(0),
    cache = useRef<typeof resolved>(null);
  const [changing, setChanging] = useState(false);
  const changeVersion = useRef(0);
  useEffect(() => {
    onPendingChange?.(changing);
  }, [changing, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey includes all attachments and the chat; reload retries without reacting to array identity.
  useEffect(() => {
    const request = ++version.current;
    setLoadError('');
    if (cache.current?.key === viewKey) {
      setResolved(cache.current);
      setBusy(false);
      return;
    }
    setBusy(true);
    api<ResolvedPackages>('/packages/resolve', { attachments })
      .then((value) => {
        if (version.current !== request || latest.current.viewKey !== viewKey) return;
        cache.current = { key: viewKey, value };
        setResolved(cache.current);
      })
      .catch((caught) => {
        if (version.current === request && latest.current.viewKey === viewKey) {
          const message = `필수 모듈을 확인할 수 없어요. 자료가 누락되었거나 의존 관계가 충돌하는지 확인해 주세요. (${(caught as Error).message})`;
          setLoadError(message);
          latest.current.onError(message);
        }
      })
      .finally(() => {
        if (version.current === request && latest.current.viewKey === viewKey) setBusy(false);
      });
    return () => {
      if (version.current === request) version.current++;
    };
  }, [viewKey, reload]);
  useEffect(
    () => () => {
      version.current++;
    },
    []
  );

  async function changeAttachments(next: ContentAttachment[]) {
    const initialKey = latest.current.viewKey,
      request = ++version.current;
    changeVersion.current = request;
    setChanging(true);
    setBusy(true);
    setLoadError('');
    try {
      const value = await api<ResolvedPackages>('/packages/resolve', { attachments: next });
      if (version.current !== request || latest.current.viewKey !== initialKey) return;
      const current = latest.current.profile;
      const key = requestKey(current.chatId, next);
      cache.current = { key, value };
      setResolved(cache.current);
      latest.current.onChange({
        ...current,
        packageAttachments: next,
      });
    } catch (caught) {
      if (version.current === request && latest.current.viewKey === initialKey) {
        const message = `자료 연결을 바꾸지 못했어요. (${(caught as Error).message}) 모듈 연결 문제라면 필요한 모듈이 빠졌거나 모듈끼리 서로를 다시 연결하는지 확인해 주세요.`;
        setLoadError(message);
        latest.current.onError(message);
      }
    } finally {
      if (changeVersion.current === request) setChanging(false);
      if (version.current === request) setBusy(false);
    }
  }
  function add(reference: string) {
    const item = library.contents.find((content) => refValue(content) === reference);
    if (!item || attachments.some((ref) => ref.id === item.id && ref.role === 'module')) return;
    void changeAttachments([
      ...attachments,
      { id: item.id, revision: item.revision, role: 'module' },
    ]);
  }
  const persona = attachments.find((item) => item.role === 'persona');
  const current = resolved?.key === viewKey ? resolved.value : null;
  const shown = current?.attachments ?? attachments,
    required = new Set(current?.required.map(keyOf) ?? []);
  return (
    <section className="package-attachments" aria-label="장착 패키지">
      {!!profile.optionAdjustments?.length && (
        <p role="status">
          현재 옵션과 맞지 않는 이전 선택값은 기본값으로 조정했어요.{' '}
          {profile.optionAdjustments.join(' · ')}
        </p>
      )}
      {busy && !loadError && (
        <LoadingState presentation="inline" label="패키지와 필수 모듈을 불러오는 중이에요…" />
      )}
      {loadError && (
        <div>
          <p className="error" role="alert">
            {loadError}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              cache.current = null;
              setReload((value) => value + 1);
            }}
          >
            패키지 연결 다시 확인
          </button>
        </div>
      )}
      <div className="chat-composition-persona">
        <ContentPicker
          library={library}
          role="persona"
          label="페르소나"
          value={persona ? refValue(persona) : ''}
          allowNone
          noneLabel="선택 안 함"
          disabled={busy}
          onChange={(reference) => {
            const selectedPersona = library.contents.find((item) => refValue(item) === reference);
            if (reference && !selectedPersona) return;
            void changeAttachments([
              ...attachments.filter((item) => item.role !== 'persona'),
              ...(selectedPersona
                ? [
                    {
                      id: selectedPersona.id,
                      revision: selectedPersona.revision,
                      role: 'persona' as const,
                    },
                  ]
                : []),
            ]);
          }}
        />
      </div>
      {shown.map((ref, index) => {
        const pkg = current?.packages[index],
          scope = keyOf(ref),
          automatic = required.has(scope),
          title = pkg?.title ?? '연결한 패키지',
          fixedBot = ref.role === 'bot',
          Attachment = 'article';
        return (
          <Attachment
            className={`package-attachment chat-composition-row${fixedBot ? ' package-attachment-fixed-bot' : ''}`}
            key={scope}
          >
            {fixedBot && <small className="chat-composition-role">소속 봇 · 고정</small>}
            <header>
              <ContentAvatar
                content={
                  pkg
                    ? {
                        id: pkg.id,
                        revision: pkg.revision,
                        kind: ref.role,
                        title: pkg.title,
                        description: pkg.description,
                        text: '',
                        loading: 'pinned',
                        relatedIds: [],
                        package: pkg,
                      }
                    : null
                }
                title={title}
              />
              <div>
                {!fixedBot && (
                  <small>
                    {automatic
                      ? '필수 모듈 · 자동 연결'
                      : ref.role === 'persona'
                        ? '내 페르소나'
                        : '추가 모듈'}
                  </small>
                )}
                <h3>{title}</h3>
              </div>
              {!automatic && ref.role !== 'bot' && (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void changeAttachments(attachments.filter((item) => keyOf(item) !== scope))
                  }
                >
                  해제
                </button>
              )}
            </header>
            <small>로어 {pkg?.lore.length ?? '…'}개</small>
            {automatic && (
              <p className="muted">
                장착한 자료가 요구하는 모듈이에요. 연결한 자료를 해제하거나 해당 자료의 모듈 참조를
                수정하면 제외할 수 있어요.
              </p>
            )}
            {pkg && (
              <details>
                <summary>사용할 로어와 지침 확인</summary>
                {pkg.lore.map((lore) => (
                  <p key={lore.id}>
                    <strong>{lore.title}</strong> ·{' '}
                    {lore.loading === 'pinned' ? '항상 포함' : '필요할 때 읽기'}
                  </p>
                ))}
              </details>
            )}
          </Attachment>
        );
      })}
      <details className="chat-composition-add">
        <summary>함께 사용하는 모듈 · 자료 추가</summary>
        <fieldset className="package-entry" disabled={busy}>
          <legend>자료 추가</legend>
          <ContentPicker
            library={{
              ...library,
              contents: library.contents.filter((content) => content.package || content.hasPackage),
            }}
            role="module"
            label="추가할 패키지"
            value=""
            onChange={add}
            disabled={busy}
            excludeIds={attachments.filter((ref) => ref.role === 'module').map((ref) => ref.id)}
          />

          <small>
            같은 자료를 다른 역할로 사용할 수 있어요. 요구하는 모듈도 함께 연결하며 공유 모듈은 한
            번만 포함해요.
          </small>
        </fieldset>
      </details>
    </section>
  );
}
