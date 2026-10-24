import {
  t,
  useI18n,
  translateMessage,
  formatNumber,
  message as uiMessage,
  messageRef,
} from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useRef, useState } from 'react';
import type { ChatProfile, Content, Library } from '../core/product.js';
import type { RisuContent, ContentAttachment } from '../core/risu-content.js';
import { api } from './api.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import { CloseIcon, LoreIcon } from './ui-icons.js';
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
  useI18n();
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
          const message = uiMessage('library.couldNotVerifyRequiredModulesCheckFor', {
            v0: messageRef((caught as Error).message),
          });
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
        const message = t('library.couldNotUpdateAttachmentsCheckForMissing', {
          v0: messageRef((caught as Error).message),
        });
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
  function personaPicker(selectedContent?: Content) {
    return (
      <ContentPicker
        library={library}
        role="persona"
        label={t('library.persona')}
        value={selectedContent ? refValue(selectedContent) : persona ? refValue(persona) : ''}
        selectedContent={selectedContent}
        allowNone
        noneLabel={t('library.noSelection')}
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
    );
  }
  const entries = shown.map((ref, index) => ({ ref, pkg: current?.packages[index] }));
  function renderAttachment({ ref, pkg }: (typeof entries)[number]) {
    const scope = keyOf(ref),
      automatic = required.has(scope),
      title = pkg?.title ?? t('library.attachedPackage'),
      fixedBot = ref.role === 'bot',
      content: Content | undefined = pkg
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
        : undefined,
      loreCount = t('library.loreCount', { count: pkg ? formatNumber(pkg.lore.length) : '…' });
    return (
      <article
        className={`package-attachment chat-composition-row${fixedBot ? ' package-attachment-fixed-bot' : ''}${ref.role === 'persona' ? ' chat-composition-persona' : ''}`}
        key={scope}
      >
        <header>
          {ref.role === 'persona' ? (
            personaPicker(content)
          ) : (
            <div className="chat-composition-identity">
              <ContentAvatar content={content ?? null} title={title} />
              <div>
                <small>
                  {fixedBot
                    ? t('library.primaryBotFixed')
                    : automatic
                      ? t('library.requiredModuleAttachedAutomatically')
                      : t('library.additionalModule')}
                </small>
                <h3>{title}</h3>
              </div>
            </div>
          )}
          {!pkg?.lore.length && <small className="chat-composition-count">{loreCount}</small>}
          {!automatic && !fixedBot && (
            <button
              type="button"
              className="ghost icon-button"
              disabled={busy}
              aria-label={t('transfer.d030', { v0: title })}
              title={t('transfer.d030', { v0: title })}
              onClick={() =>
                void changeAttachments(
                  attachments.filter((item) => item.id !== ref.id || item.role !== ref.role)
                )
              }
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          )}
        </header>
        {automatic && <p className="muted">{t('library.thisModuleIsRequiredByAnAttached')}</p>}
        {!!pkg?.lore.length && (
          <details className="chat-composition-lore">
            <summary
              aria-label={`${title}: ${t('library.reviewLoreAndInstructions')}, ${loreCount}`}
            >
              <LoreIcon size={16} aria-hidden="true" />
              {loreCount}
            </summary>
            <div className="chat-composition-lore-list">
              {pkg.lore.map((lore) => (
                <p key={lore.id} className="ui-meta-row">
                  <strong>{lore.title}</strong>
                  <span>
                    {lore.loading === 'pinned'
                      ? t('library.alwaysInclude')
                      : t('library.readWhenNeeded')}
                  </span>
                </p>
              ))}
            </div>
          </details>
        )}
      </article>
    );
  }
  return (
    <section className="package-attachments" aria-label={t('library.attachedPackages')}>
      {!!profile.optionAdjustments?.length && (
        <p role="status">
          {t('library.previousSelectionsThatNoLongerMatchAvailable')}{' '}
          {profile.optionAdjustments.join(', ')}
        </p>
      )}
      {busy && !loadError && (
        <LoadingState
          presentation="inline"
          label={t('library.loadingPackagesAndRequiredModules')}
        />
      )}
      {loadError && (
        <div>
          <p className="error" role="alert">
            {translateMessage(loadError)}
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
            {t('library.checkPackageAttachmentsAgain')}
          </button>
        </div>
      )}
      {entries.filter(({ ref }) => ref.role === 'bot').map(renderAttachment)}
      {persona ? (
        entries.filter(({ ref }) => ref.role === 'persona').map(renderAttachment)
      ) : (
        <div className="chat-composition-row chat-composition-persona">{personaPicker()}</div>
      )}
      {entries.filter(({ ref }) => ref.role === 'module').map(renderAttachment)}
      <div className="chat-composition-add">
        <ContentPicker
          library={{
            ...library,
            contents: library.contents.filter((content) => content.package || content.hasPackage),
          }}
          role="module"
          label={t('library.addSharedModulesOrResources')}
          value=""
          onChange={add}
          disabled={busy}
          excludeIds={attachments.filter((ref) => ref.role === 'module').map((ref) => ref.id)}
        />
      </div>
    </section>
  );
}
