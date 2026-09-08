import { useEffect, useState } from 'react';
import type { ChatProfile, Library, ModelRef, TaskRole } from '../core/product.js';
import { api } from './api.js';
import { PromptEditor } from './PromptEditor.js';
import { useModelSelection } from './model-selection.js';
import { PackageAttachments } from './PackageAttachments.js';
import { LoreContextPolicyEditor } from './LoreContextPolicyEditor.js';
import './library.css';

type ProfileSection = 'characters' | 'prompts' | 'models';
const sections: { id: ProfileSection; title: string }[] = [
  { id: 'characters', title: '봇·페르소나·모듈' },
  { id: 'prompts', title: '프롬프트·창작 프리셋' },
  { id: 'models', title: '모델' },
];

export function ProfileEditor({
  profile,
  library,
  onSaved,
  onError,
  onDirtyChange,
  onLibraryChanged,
  initialTab = 'characters',
  branchId,
  ownerBotId,
  nextRequest = '',
  loreContextReset = false,
}: {
  ownerBotId?: string;
  branchId?: string;
  profile: ChatProfile;
  library: Library;
  onSaved: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onLibraryChanged?: () => Promise<void>;
  initialTab?: ProfileSection;
  nextRequest?: string;
  loreContextReset?: boolean;
}) {
  const [value, setValue] = useState(profile);
  const [dirty, setDirty] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [lorePending, setLorePending] = useState(false),
    [loreResetVersion, setLoreResetVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<ProfileSection>(initialTab);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const { canSelect } = useModelSelection(library.models, library.connections);
  useEffect(() => {
    if (!dirty && !lorePending)
      setValue((current) =>
        profile.chatId !== current.chatId || profile.revision >= current.revision
          ? profile
          : current
      );
  }, [profile, dirty, lorePending]);
  useEffect(() => {
    onDirtyChange?.(dirty || promptDirty || lorePending);
  }, [dirty, promptDirty, lorePending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const models = library.models;
  const sameRef = (item: ModelRef, selected: ModelRef | null) => item.id === selected?.id;
  const retainedModelRefs = (role: TaskRole) => [
    ...new Map(
      [profile.routes[role], value.routes[role]]
        .filter((ref): ref is ModelRef => ref !== null)
        .map((ref) => [ref.id, ref])
    ).values(),
  ];
  const change = (next: ChatProfile) => {
    setValue(next);
    setDirty(true);
    setStatus('');
  };
  async function save(work: () => Promise<ChatProfile>, message = '채팅 설정을 저장했어요.') {
    if (lorePending) {
      setError('로어 문맥 정책의 숫자 초안을 먼저 확인해 주세요.');
      return false;
    }
    setSaving(true);
    onError('');
    setError('');
    setStatus('');
    try {
      const accepted = await work();
      setValue(accepted);
      setDirty(false);
      setStatus(message);
      await onSaved();
      return true;
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  const profileBody = (next: ChatProfile) => ({
    expectedRevision: next.revision,
    attachments: next.attachments,
    personaReference: next.personaReference,
    routes: next.routes,
    image: next.image,
    ...(next.prompts ? { prompts: next.prompts } : {}),
    ...(next.promptControls ? { promptControls: next.promptControls } : {}),
    ...(next.packageAttachments ? { packageAttachments: next.packageAttachments } : {}),
    ...(next.packageValues ? { packageValues: next.packageValues } : {}),
    ...(next.loreContext ? { loreContext: next.loreContext } : {}),
  });
  return (
    <section
      className="profile-editor"
      data-testid="profile-editor"
      aria-label="콘텐츠와 창작 제어"
    >
      <p className="muted profile-intro">이 채팅에서 사용할 인물과 창작 방식을 정해요.</p>
      <div
        className="profile-tabs"
        role="tablist"
        aria-label="채팅 설정 분류"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = sections.findIndex((item) => item.id === tab);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? sections.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) %
                  sections.length;
          setTab(sections[next].id);
          (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
        }}
      >
        {sections.map((item) => (
          <button
            type="button"
            role="tab"
            id={`profile-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="profile-fields"
            tabIndex={tab === item.id ? 0 : -1}
            key={item.id}
            className="secondary"
            onClick={() => setTab(item.id)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(() =>
            api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody(value), 'PUT')
          );
        }}
      >
        <div id="profile-fields" role="tabpanel" aria-labelledby={`profile-tab-${tab}`}>
          <fieldset className="profile-fields" disabled={saving}>
            {tab === 'characters' && (
              <PackageAttachments
                ownerBotId={ownerBotId}
                profile={value}
                library={library}
                onChange={change}
                onError={onError}
              />
            )}
            {tab === 'characters' && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={value.personaReference !== false}
                  onChange={(event) => change({ ...value, personaReference: event.target.checked })}
                />
                본문에서 페르소나 참조
              </label>
            )}
            <div hidden={tab !== 'characters'}>
              <LoreContextPolicyEditor
                key={`${profile.chatId}:${loreResetVersion}`}
                value={value.loreContext}
                onChange={(loreContext) => change({ ...value, loreContext })}
                onPendingChange={setLorePending}
                chatId={profile.chatId}
                branchId={branchId}
                profileRevision={value.revision}
                request={nextRequest}
                reset={loreContextReset}
              />
            </div>
            <div hidden={tab !== 'prompts'}>
              <PromptEditor
                chatId={profile.chatId}
                branchId={branchId}
                promptControls={value.promptControls}
                onSaveControls={async (reference, state) => {
                  const ok = await save(
                    () =>
                      api<ChatProfile>(
                        `/chats/${profile.chatId}/profile`,
                        profileBody({
                          ...value,
                          promptControls: {
                            ...value.promptControls,
                            [`${reference.id}@${reference.revision}`]: state,
                          },
                        }),
                        'PUT'
                      ),
                    '선택값과 조합을 이 채팅에 저장했어요.'
                  );
                  if (!ok) throw new Error('선택값 저장에 실패했어요.');
                }}
                library={library}
                reload={onLibraryChanged}
                onError={onError}
                selections={value.prompts}
                onDirtyChange={setPromptDirty}
                onApply={(role, reference) =>
                  save(
                    () =>
                      api<ChatProfile>(
                        `/chats/${profile.chatId}/profile`,
                        profileBody({ ...value, prompts: { ...value.prompts, [role]: reference } }),
                        'PUT'
                      ),
                    '프롬프트 선택을 이야기에 적용했어요.'
                  )
                }
              />
            </div>
            {tab === 'models' && (
              <fieldset className="control-grid">
                <legend>역할별 모델</legend>
                {(['main', 'translation', 'status', 'image'] as TaskRole[]).map((role, index) => (
                  <label key={role}>
                    {['본문 모델', '번역 모델', '표시 상태 모델', '이미지 선택 모델'][index]}
                    <select
                      aria-label={
                        ['원문 모델', '번역 모델', '표시 상태 모델', '이미지 선택 모델'][index]
                      }
                      value={value.routes[role] ? value.routes[role]!.id : ''}
                      onChange={(event) => {
                        const model =
                          models.find((item) => item.id === event.target.value) ??
                          retainedModelRefs(role).find((item) => item.id === event.target.value);
                        change({
                          ...value,
                          routes: { ...value.routes, [role]: model ? { id: model.id } : null },
                        });
                      }}
                    >
                      <option value="">모델 미지정</option>
                      {retainedModelRefs(role)
                        .filter((ref) => !models.some((item) => sameRef(item, ref)))
                        .map((ref) => (
                          <option
                            key={ref.id}
                            disabled={!sameRef(ref, profile.routes[role])}
                            value={ref.id}
                          >
                            선택한 모델 · 확인 필요
                          </option>
                        ))}
                      {models
                        .filter(
                          (item) =>
                            canSelect(item) ||
                            sameRef(item, profile.routes[role]) ||
                            sameRef(item, value.routes[role])
                        )
                        .map((item) => (
                          <option
                            disabled={!canSelect(item) && !sameRef(item, profile.routes[role])}
                            key={item.id}
                            value={item.id}
                          >
                            {item.title} · {!canSelect(item) ? '비활성 · ' : ''}
                            {item.modelId}
                          </option>
                        ))}
                    </select>
                    {value.routes[role] &&
                      !models.some(
                        (item) => sameRef(item, value.routes[role]) && canSelect(item)
                      ) && (
                        <small role="status">
                          모델 또는 연결이 비활성이거나 권한 확인이 필요해요. 저장된 선택은
                          유지되지만 새 실행은 차단돼요.
                        </small>
                      )}
                  </label>
                ))}
                <label className="check">
                  <input
                    aria-label="보조 이미지 표시"
                    type="checkbox"
                    checked={value.image}
                    onChange={(event) => change({ ...value, image: event.target.checked })}
                  />
                  보조 이미지 표시
                </label>
                <small>
                  이미지는 원고와 별도로 표시해요. 재사용할 연결과 모델 프리셋은 앱 설정에서
                  관리해요. 모델과 연결의 변경은 다음 신규 생성부터 적용돼요.
                </small>
              </fieldset>
            )}
          </fieldset>
        </div>
        {profile.revision > value.revision && dirty && (
          <p className="error" role="alert">
            다른 요청에서 채팅 설정이 바뀌었어요. 입력은 유지했어요. 최신 설정을 확인한 뒤 다시
            저장해 주세요.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error} 입력한 내용은 유지했어요.
          </p>
        )}
        <div className="profile-savebar form-actions">
          <button disabled={saving || !dirty || lorePending}>
            {saving ? '저장 중…' : '콘텐츠와 제어 저장'}
          </button>
          {(dirty || lorePending) && (
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => {
                setValue(profile);
                setDirty(false);
                setLorePending(false);
                setLoreResetVersion((version) => version + 1);
                setError('');
                setStatus('최신 설정을 불러왔어요.');
                onError('');
              }}
            >
              장착 설정 다시 불러오기
            </button>
          )}
          <span role="status">
            {status || (dirty || lorePending ? '저장하지 않은 변경이 있어요.' : '')}
          </span>
        </div>
      </form>
    </section>
  );
}
