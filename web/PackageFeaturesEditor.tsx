import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useRef, useState } from 'react';
import { validateRisuContent, type RisuContent } from '../core/risu-content.js';
import type { Content, Library } from '../core/product.js';
import type { PackageModuleRef } from '../core/package-features.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import { api, libraryChangedKey } from './api.js';
import { RefreshIcon } from './ui-icons.js';
import './package-authoring.css';

const referenceKey = (ref: PackageModuleRef | null | undefined) =>
  ref ? `${ref.id}@${ref.revision}` : '';
type ReferenceStatus = { content?: Content; error?: string };

export function PackageFeaturesEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  useI18n();
  const [library, setLibrary] = useState<Library | null>(null),
    [statuses, setStatuses] = useState<Record<string, ReferenceStatus>>({});
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [listError, setListError] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reload, setReload] = useState(0);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const actionVersion = useRef(0),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      actionVersion.current++;
    };
  }, []);
  const refsKey = JSON.stringify(value.modules ?? []);
  const scope = `${value.id}@${value.revision}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching packages invalidates actions and clears only the previous package's local drafts.
  useEffect(() => {
    actionVersion.current++;
    setBusy(false);
  }, [scope]);
  useEffect(() => {
    onDirtyChange?.(busy);
  }, [busy, onDirtyChange]);
  useEffect(() => {
    const refresh = () => setReload((current) => current + 1);
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('uimori-helper-updated', refresh);
    window.addEventListener('uimori-resource-saved', refresh);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('uimori-helper-updated', refresh);
      window.removeEventListener('uimori-resource-saved', refresh);
      window.removeEventListener('storage', storage);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit reload retries the available module lists for this package.
  useEffect(() => {
    let active = true;
    setLoading(true);
    api<Library>('/library?view=summary')
      .then((contents) => {
        if (!active) return;
        setLibrary(contents);
        setListError('');
      })
      .catch(() => {
        if (active) setListError(uiMessage('library.couldNotLoadResourcesTryRefreshing'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [value.id, reload]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Module selections, package switches and explicit reloads govern reads, not draft object identity.
  useEffect(() => {
    let active = true;
    const refs = value.modules ?? [];
    Promise.all(
      refs.map(async (ref) => {
        try {
          const content = await api<Content>(`/content/${encodeURIComponent(ref.id)}`);
          return [
            referenceKey(ref),
            content.package
              ? { content }
              : { error: uiMessage('library.theAttachedResourceIsNotACommon') },
          ] as const;
        } catch {
          return [
            referenceKey(ref),
            { error: uiMessage('library.couldNotFindOrReadTheAttached') },
          ] as const;
        }
      })
    ).then((items) => {
      if (active) setStatuses(Object.fromEntries(items));
    });
    return () => {
      active = false;
    };
  }, [value.id, refsKey, reload]);

  const currentAction = (request: number, scope: string) =>
    alive.current &&
    actionVersion.current === request &&
    `${latest.current.value.id}@${latest.current.value.revision}` === scope;
  async function act(work: (request: number, id: string) => Promise<void>) {
    if (busy) return;
    const request = ++actionVersion.current,
      id = scope;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(request, id);
    } catch (caught) {
      if (currentAction(request, id)) setError((caught as Error).message);
    } finally {
      if (currentAction(request, id)) setBusy(false);
    }
  }
  function update(part: Partial<RisuContent>): boolean {
    try {
      latest.current.onChange(validateRisuContent({ ...latest.current.value, ...part }));
      setError('');
      setNotice(uiMessage('library.appliedToTheResourceDraftSaveTo'));
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    }
  }
  async function addModule(reference: string) {
    const item = library?.contents.find((content) => referenceKey(content) === reference);
    if (!item) return;
    await act(async (request, id) => {
      const content = await api<Content>(`/content/${encodeURIComponent(item.id)}`);
      if (!currentAction(request, id)) return;
      if (!content.package)
        throw new Error(uiMessage('library.onlyResourcesWithACommonPackageCan'));
      const current = latest.current.value;
      if (content.id === current.id || current.modules?.some((ref) => ref.id === content.id))
        throw new Error(uiMessage('library.youCannotAddTheResourceItselfOr'));
      update({
        modules: [...(current.modules ?? []), { id: content.id, revision: content.revision }],
      });
    });
  }
  const retryRead = (
    <button
      type="button"
      className="secondary"
      disabled={busy || loading}
      onClick={() => setReload((current) => current + 1)}
    >
      <RefreshIcon size={16} aria-hidden="true" />
      {t('shared.reload')}
    </button>
  );
  return (
    <div
      className="package-stack package-authoring-editor"
      aria-label={t('library.editPackageModulesAndFeatures')}
    >
      <section className="package-stack package-module-section">
        <header className="package-module-heading">
          <h3>{t('library.sharedModules')}</h3>
          <p className="muted">{t('library.attachingThisResourceAlsoUsesTheModules')}</p>
        </header>
        {(value.modules ?? []).map((ref) => {
          const status = statuses[referenceKey(ref)];
          return (
            <fieldset className="package-entry" key={ref.id}>
              <legend>{status?.content?.title ?? ref.id}</legend>
              <ContentAvatar content={status?.content} title={status?.content?.title ?? ref.id} />
              {status?.error && (
                <NoticeBanner tone="error" actions={retryRead}>
                  {t('library.moduleError', { error: translateMessage(status.error) })}
                </NoticeBanner>
              )}
              <div className="package-role-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    update({ modules: value.modules?.filter((item) => item.id !== ref.id) });
                  }}
                >
                  {t('library.detachModule')}
                </button>
              </div>
            </fieldset>
          );
        })}
        <div className="package-module-connect">
          <ContentPicker
            library={library ?? { contents: [], connections: [], models: [], assets: [] }}
            value=""
            onChange={(reference) => void addModule(reference)}
            role="module"
            label={t('library.commonModuleToAttach')}
            disabled={busy || loading || !library}
            excludeIds={[value.id, ...(value.modules ?? []).map((ref) => ref.id)]}
          />
        </div>
        <footer className="package-module-footer">
          <small>{t('library.editsToModulesInTheLibraryApply')}</small>
        </footer>
      </section>
      <div className="package-module-status" aria-live="polite">
        {loading && (
          <LoadingState presentation="inline" label={t('library.loadingResourcesAndFeatures')} />
        )}
        {busy && (
          <LoadingState presentation="inline" label={t('library.loadingSelectedResource')} />
        )}
      </div>
      {listError && (
        <NoticeBanner tone="error" actions={retryRead}>
          {translateMessage(listError)}
        </NoticeBanner>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      {notice && <NoticeBanner>{translateMessage(notice)}</NoticeBanner>}
    </div>
  );
}
