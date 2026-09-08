import { useEffect, useRef, useState } from 'react';
import type { ChatProfile, Library } from '../core/product.js';
import type { ContentPackage, PackageAttachment, PackageRole } from '../core/content-package.js';
import { api } from './api.js';
import { PackageControlValues } from './PackageControlValues.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import './package-authoring.css';
const keyOf = (ref: PackageAttachment) => `${ref.id}@${ref.revision}:${ref.role}`;
const refValue = (ref: { id: string; revision: number }) => `${ref.id}@${ref.revision}`;
type ResolvedPackages = {
  attachments: PackageAttachment[];
  packages: ContentPackage[];
  required: PackageAttachment[];
};
const requestKey = (chatId: string, attachments: PackageAttachment[]) =>
  `${chatId}/${JSON.stringify(attachments)}`;

export function retainResolvedPackageValues(
  values: ChatProfile['packageValues'],
  resolved: ResolvedPackages
): NonNullable<ChatProfile['packageValues']> {
  return Object.fromEntries(
    resolved.attachments.flatMap((ref, index) => {
      const scope = keyOf(ref);
      if (!values || !Object.hasOwn(values, scope)) return [];
      const allowed = new Set(resolved.packages[index].controls.map((control) => control.id));
      return [
        [
          scope,
          Object.fromEntries(Object.entries(values[scope]).filter(([key]) => allowed.has(key))),
        ],
      ];
    })
  );
}

export function PackageAttachments({
  profile,
  library,
  onChange,
  onError,
  ownerBotId,
}: {
  profile: ChatProfile;
  library: Library;
  onChange: (profile: ChatProfile) => void;
  onError: (message: string) => void;
  ownerBotId?: string;
}) {
  const attachments = profile.packageAttachments ?? [],
    viewKey = requestKey(profile.chatId, attachments);
  const [resolved, setResolved] = useState<{ key: string; value: ResolvedPackages } | null>(null),
    [selected, setSelected] = useState(''),
    [role, setRole] = useState<PackageRole>('module'),
    [busy, setBusy] = useState(false),
    [loadError, setLoadError] = useState(''),
    [reload, setReload] = useState(0);
  const latest = useRef({ profile, onChange, onError, viewKey, library });
  latest.current = { profile, onChange, onError, viewKey, library };
  const version = useRef(0),
    cache = useRef<typeof resolved>(null);
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
          const message = `필수 모듈과 고정 버전을 확인할 수 없어요. 자료가 누락되었거나 의존 관계가 충돌하는지 확인해 주세요. (${(caught as Error).message})`;
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

  async function changeAttachments(next: PackageAttachment[], personaChanged = false) {
    const initialKey = latest.current.viewKey,
      request = ++version.current;
    setBusy(true);
    setLoadError('');
    try {
      const value = await api<ResolvedPackages>('/packages/resolve', { attachments: next });
      if (version.current !== request || latest.current.viewKey !== initialKey) return;
      const current = latest.current.profile;
      const legacy = personaChanged
        ? current.attachments.filter(
            (ref) =>
              !latest.current.library.contents.some(
                (content) => content.id === ref.id && content.kind === 'persona'
              )
          )
        : current.attachments;
      const key = requestKey(current.chatId, next);
      cache.current = { key, value };
      setResolved(cache.current);
      latest.current.onChange({
        ...current,
        attachments: legacy,
        packageAttachments: next,
        packageValues: retainResolvedPackageValues(current.packageValues, value),
      });
      setSelected('');
    } catch (caught) {
      if (version.current === request && latest.current.viewKey === initialKey) {
        const message = `패키지 연결을 변경하지 않았어요. 필수 모듈의 누락·버전 충돌·순환 연결을 확인해 주세요. (${(caught as Error).message})`;
        setLoadError(message);
        latest.current.onError(message);
      }
    } finally {
      if (version.current === request) setBusy(false);
    }
  }
  function add() {
    const item = library.contents.find((content) => refValue(content) === selected);
    if (!item) return;
    if (role === 'bot' && ownerBotId !== item.id) {
      onError('채팅의 소속 봇은 바꿀 수 없어요.');
      return;
    }
    const ref = { id: item.id, revision: item.revision, role },
      next = attachments.filter(
        (current) =>
          !(current.id === ref.id && current.role === ref.role) &&
          (role === 'module' || current.role !== role)
      );
    void changeAttachments([...next, ref], role === 'persona');
  }
  const current = resolved?.key === viewKey ? resolved.value : null;
  const shown = current?.attachments ?? attachments,
    required = new Set(current?.required.map(keyOf) ?? []);
  return (
    <section className="package-attachments" aria-label="장착 패키지">
      {busy && <p role="status">패키지와 필수 모듈의 고정 버전을 확인하는 중이에요…</p>}
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
      {shown.map((ref, index) => {
        const pkg = current?.packages[index],
          scope = keyOf(ref),
          automatic = required.has(scope),
          title = pkg?.title ?? '보관된 패키지';
        return (
          <article className="package-attachment" key={scope}>
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
                <small>
                  {automatic
                    ? '필수 모듈 · 자동 연결'
                    : ref.role === 'bot'
                      ? '소속 봇 · 고정'
                      : ref.role === 'persona'
                        ? '내 페르소나'
                        : '추가 모듈'}
                </small>
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
            <small>
              v{ref.revision} · 로어 {pkg?.lore.length ?? '…'}개
              {pkg?.instructions.length ? ` · 지침 ${pkg.instructions.length}개` : ''}
            </small>
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
                {pkg.roleBindings?.[ref.role] && <p>{pkg.roleBindings[ref.role]}</p>}
                {pkg.instructions.map((instruction) => (
                  <p key={instruction.id}>
                    {instruction.target} · {instruction.text.slice(0, 160)}
                  </p>
                ))}
              </details>
            )}
            {!!pkg?.controls.length && (
              <PackageControlValues
                controls={pkg.controls}
                values={profile.packageValues?.[scope]}
                labelPrefix={title}
                disabled={busy}
                onChange={(values) => {
                  const current = latest.current;
                  if (current.viewKey !== viewKey) return;
                  current.onChange({
                    ...current.profile,
                    packageValues: { ...current.profile.packageValues, [scope]: values },
                  });
                }}
              />
            )}
          </article>
        );
      })}
      <fieldset className="package-entry" disabled={busy}>
        <legend>패키지 추가</legend>
        <label>
          이 채팅에서의 역할
          <select
            aria-label="패키지 장착 역할"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as PackageRole);
              setSelected('');
            }}
          >
            <option value="module">모듈 · 추가 지침과 설정</option>
            <option value="persona">페르소나 · 내가 맡는 인물</option>
          </select>
        </label>
        <ContentPicker
          library={{
            ...library,
            contents: library.contents.filter((content) => content.package || content.hasPackage),
          }}
          role={role}
          label="추가할 패키지"
          value={selected}
          onChange={setSelected}
          disabled={busy}
          excludeIds={attachments.filter((ref) => ref.role === role).map((ref) => ref.id)}
        />
        <button type="button" className="secondary" disabled={!selected || busy} onClick={add}>
          패키지 장착
        </button>
        <small>
          같은 자료를 다른 역할로 사용할 수 있어요. 요구하는 모듈도 고정 버전으로 함께 연결하며 공유
          모듈은 한 번만 포함해요.
        </small>
      </fieldset>
    </section>
  );
}
