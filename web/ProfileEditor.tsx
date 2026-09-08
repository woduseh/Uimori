import { useEffect, useState } from 'react';
import type { ChatProfile, Library } from '../core/product.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { PackageAttachments } from './PackageAttachments.js';
import { LoreContextPolicyEditor } from './LoreContextPolicyEditor.js';
import './library.css';

export type ProfileSection = 'characters' | 'prompts' | 'models';
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
  onGlobalSettings,
  initialTab = 'characters',
  activeTab,
  hideNavigation = false,
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
  onGlobalSettings: (section: 'models' | 'prompts') => void;
  initialTab?: ProfileSection;
  activeTab?: ProfileSection;
  hideNavigation?: boolean;
  nextRequest?: string;
  loreContextReset?: boolean;
}) {
  const [value, setValue] = useState(profile);
  const [dirty, setDirty] = useState(false);
  const { workspace } = usePromptWorkspace();
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [lorePending, setLorePending] = useState(false),
    [loreResetVersion, setLoreResetVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [localTab, setTab] = useState<ProfileSection>(initialTab);
  const tab = activeTab ?? localTab;
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!dirty && !lorePending)
      setValue((current) =>
        profile.chatId !== current.chatId || profile.revision >= current.revision
          ? profile
          : current
      );
  }, [profile, dirty, lorePending]);
  useEffect(() => {
    onDirtyChange?.(dirty || lorePending || saving || attachmentPending);
  }, [dirty, lorePending, saving, attachmentPending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
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
      // The write is persisted. The refresh below must not keep the panel counted as unsaved,
      // or closing right after "저장했어요" asks to discard a draft that no longer exists.
      setSaving(false);
      // Refresh in the background: callers such as the prompt composer end their own
      // saving state when this resolves, and that must not wait for the reload.
      void onSaved().catch((caught) => onError((caught as Error).message));
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
    image: next.image,
    imageTranslation: next.imageTranslation !== false,
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
      {!hideNavigation && (
        <p className="muted profile-intro">이 채팅에서 사용할 인물과 창작 방식을 정해요.</p>
      )}
      <div
        hidden={hideNavigation}
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
        <div
          id={hideNavigation ? undefined : 'profile-fields'}
          role={hideNavigation ? undefined : 'tabpanel'}
          aria-labelledby={hideNavigation ? undefined : `profile-tab-${tab}`}
        >
          <fieldset className="profile-fields" disabled={saving}>
            <div hidden={tab !== 'characters'}>
              <PackageAttachments
                ownerBotId={ownerBotId}
                profile={value}
                library={library}
                onChange={change}
                onError={onError}
                onPendingChange={setAttachmentPending}
              />
            </div>
            <div hidden={tab !== 'characters'}>
              <label className="check">
                <input
                  aria-label="원문 이미지 자동 배치"
                  type="checkbox"
                  checked={value.image}
                  onChange={(event) => change({ ...value, image: event.target.checked })}
                />
                원문 이미지 자동 배치
              </label>
              <small>
                새 원문이 완성되면 등록된 이미지 중 어울리는 이미지를 골라 문단 사이에 배치해요.
              </small>
              <label className="check">
                <input
                  type="checkbox"
                  checked={value.imageTranslation !== false}
                  onChange={(event) => change({ ...value, imageTranslation: event.target.checked })}
                />
                번역 이미지 자동 배치
              </label>
              <small>
                새 번역이 완성되면 번역문에 맞춰 이미지를 별도로 배치해요. 꺼도 각 보기의 장면
                메뉴에서 직접 실행할 수 있어요.
              </small>
            </div>
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
              <p>모든 채팅의 이후 요청에 현재 전역 프롬프트와 옵션을 사용해요.</p>
              <p>
                작문: {workspace?.main.title ?? '불러오는 중…'} · 번역:{' '}
                {workspace?.translation.title ?? '불러오는 중…'}
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => onGlobalSettings('prompts')}
              >
                전역 프롬프트 설정
              </button>
            </div>
            <div hidden={tab !== 'models'}>
              <p>
                모든 채팅의 이후 요청에 현재 전역 모델을 사용해요. 진행 중이거나 과거의 작업은
                바뀌지 않아요.
              </p>
              {(['main', 'translation', 'status', 'image'] as const).map((role, index) => (
                <p key={role}>
                  {['본문 모델', '번역 모델', '표시 상태 모델', '이미지 배치 모델'][index]}:{' '}
                  {library.models.find((item) => item.id === workspace?.modelRoutes[role]?.id)
                    ?.title ?? '미지정 또는 확인 필요'}
                </p>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() => onGlobalSettings('models')}
              >
                전역 모델 설정
              </button>
            </div>
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
        <div
          className="profile-savebar form-actions"
          hidden={tab !== 'characters' && !dirty && !lorePending}
        >
          <button disabled={saving || !dirty || lorePending}>
            {saving ? '저장 중…' : '채팅 설정 저장'}
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
          {(dirty || lorePending) && <small>인물·자료의 변경 사항을 함께 저장해요.</small>}
        </div>
        {tab === 'prompts' && !dirty && !lorePending && status && <p role="status">{status}</p>}
      </form>
    </section>
  );
}
