import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { Switch } from './BooleanControls.js';
import { SettingsIcon } from './ui-icons.js';
import { SaveButton } from './SaveButton.js';
import { useEffect, useState } from 'react';
import type { ChatProfile, Library } from '../core/product.js';
import { api } from './api.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { isModelSelectable } from './model-selection.js';
import { modelLabel } from './storyLabels.js';
import { ContentAttachments } from './ContentAttachments.js';
import { LoreContextPolicyEditor } from './LoreContextPolicyEditor.js';
import type { LoreContextDefaults, LoreContextPolicy } from '../core/lore-context.js';
import './library.css';
import './settings-actions.css';

export type ProfileSection = 'characters' | 'prompts' | 'models' | 'story' | 'images';
const sections: { id: ProfileSection; title: string }[] = [
  { id: 'characters', title: '대화 구성' },
  { id: 'prompts', title: '프롬프트·모델' },
  { id: 'story', title: '기억·로어' },
  { id: 'images', title: '이미지' },
];

export function ProfileEditor({
  profile,
  library,
  onSaved,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
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
  onSaveHandlerChange?: SettingsSaveRegistration;
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
  const [loreDefaults, setLoreDefaults] = useState<LoreContextPolicy | null>(null);
  const [loreDefaultsError, setLoreDefaultsError] = useState(false);
  const [loreDefaultsRequest, setLoreDefaultsRequest] = useState(0);
  const [saving, setSaving] = useState(false);
  const [localTab, setTab] = useState<ProfileSection>(initialTab);
  const selectedTab = activeTab ?? localTab;
  const tab = selectedTab === 'models' ? 'prompts' : selectedTab;
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry starts a new read and invalidates the previous effect's response.
  useEffect(() => {
    let active = true;
    setLoreDefaultsError(false);
    void api<LoreContextDefaults>('/lore-context-defaults')
      .then(({ revision: _revision, ...policy }) => {
        if (active) setLoreDefaults(policy);
      })
      .catch(() => {
        if (active) setLoreDefaultsError(true);
      });
    return () => {
      active = false;
    };
  }, [loreDefaultsRequest]);
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
  useSettingsSaveHandler(onSaveHandlerChange, async () => {
    if (saving || attachmentPending || lorePending) return false;
    if (!dirty) return true;
    return save(() =>
      api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody(value), 'PUT')
    );
  });
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
    pinned: next.pinned ?? {},
    image: next.image,
    imageTranslation: next.imageTranslation !== false,
    ...(next.packageAttachments ? { packageAttachments: next.packageAttachments } : {}),
    ...(next.loreContext ? { loreContext: next.loreContext } : {}),
  });
  const promptId = value.pinned?.mainPromptPresetId;
  const promptChoices = library.promptPresets?.filter((item) => item.role === 'main') ?? [];
  const pinnedPrompt = promptChoices.find((item) => item.id === promptId);
  const modelId = value.pinned?.mainModel?.id;
  const selectedModelId = modelId ?? workspace?.modelRoutes.main?.id;
  const selectedModel = library.models.find((item) => item.id === selectedModelId);
  const modelAvailable =
    !!selectedModel && isModelSelectable(selectedModel, library.models, library.connections);
  const modelChoices = library.models.filter((item) =>
    isModelSelectable(item, library.models, library.connections)
  );
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
      <p className="muted">이 채팅에만 적용돼요.</p>
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
              <ContentAttachments
                ownerBotId={ownerBotId}
                profile={value}
                library={library}
                onChange={change}
                onError={onError}
                onPendingChange={setAttachmentPending}
              />
            </div>
            <div hidden={tab !== 'images'} className="chat-profile-image-options">
              <h3>등록된 이미지 자동 배치</h3>
              <label className="check">
                <Switch
                  aria-label="원문 이미지 자동 배치"
                  checked={value.image}
                  onChange={(event) => change({ ...value, image: event.target.checked })}
                />
                원문 이미지 자동 배치
              </label>
              <small>
                새 원문이 완성되면 등록된 이미지 중 어울리는 이미지를 골라 문단 사이에 배치해요.
              </small>
              <label className="check">
                <Switch
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
            <div hidden={tab !== 'story'}>
              {!loreDefaults &&
                (loreDefaultsError ? (
                  <div>
                    <p className="error" role="alert">
                      전역 로어 기본값을 불러오지 못했어요. 현재 채팅 설정은 계속 편집할 수 있어요.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setLoreDefaultsRequest((current) => current + 1)}
                    >
                      전역 기본값 다시 불러오기
                    </button>
                  </div>
                ) : (
                  <p className="muted" role="status">
                    전역 로어 기본값을 불러오는 중이에요.
                  </p>
                ))}
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
                defaults={loreDefaults}
              />
            </div>
            <div hidden={tab !== 'prompts'} className="chat-profile-model-options">
              <label>
                이 채팅의 본문 모델
                <select
                  value={modelId ?? ''}
                  onChange={(event) =>
                    change({
                      ...value,
                      pinned: {
                        ...value.pinned,
                        mainModel: event.target.value ? { id: event.target.value } : undefined,
                      },
                    })
                  }
                >
                  <option value="">
                    전역 따르기 ·{' '}
                    {library.models.find((item) => item.id === workspace?.modelRoutes.main?.id)
                      ?.title ?? '미지정 또는 확인 필요'}
                  </option>
                  {modelId && !modelChoices.some((item) => item.id === modelId) && (
                    <option value={modelId}>사용 불가 · {selectedModel?.title ?? modelId}</option>
                  )}
                  {modelChoices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {modelLabel(item, library)}
                    </option>
                  ))}
                </select>
              </label>
              {!modelAvailable && workspace && (
                <p className="error" role="alert">
                  {!selectedModelId
                    ? '본문 모델이 지정되지 않았어요. 저장된 원고는 읽을 수 있지만 새 생성은 시작할 수 없어요.'
                    : '선택한 본문 모델을 사용할 수 없어 새 본문 실행이 차단돼요. 사용 가능한 모델을 고르거나 전체 설정을 확인해 주세요.'}
                </p>
              )}
              <small>
                본문 모델의 최신 저장본을 다음 요청부터 사용해요. 진행 중이거나 과거의 작업은 바뀌지
                않아요.
              </small>
            </div>
            <div hidden={tab !== 'prompts'} className="chat-profile-prompt-options">
              <label>
                이 채팅의 작문 프롬프트
                <select
                  value={promptId ?? ''}
                  onChange={(event) =>
                    change({
                      ...value,
                      pinned: {
                        ...value.pinned,
                        mainPromptPresetId: event.target.value || undefined,
                      },
                    })
                  }
                >
                  <option value="">전역 따르기 · {workspace?.main.title ?? '불러오는 중…'}</option>
                  {promptId && !pinnedPrompt && (
                    <option value={promptId}>사용 불가 · {promptId}</option>
                  )}
                  {promptChoices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              {promptId && !pinnedPrompt && (
                <p className="error" role="alert">
                  고정한 작문 프리셋을 사용할 수 없어 새 본문 실행이 차단돼요. 다른 프리셋을
                  고르거나 전역 따르기로 바꿔 저장해 주세요.
                </p>
              )}
              <small>
                고정한 프리셋의 최신 저장본을 다음 요청부터 사용해요. 과거와 진행 중인 작업은 바뀌지
                않아요. 창작 옵션은 선택한 프롬프트의 정의를 따라요.
              </small>
            </div>
            <div hidden={tab !== 'prompts'} className="settings-inherited">
              <h4>전체 채팅 설정에서 사용하는 모델</h4>
              <dl>
                {(['translation', 'status'] as const).map((role, index) => (
                  <div key={role}>
                    <dt>{['번역', '장면 해설'][index]}</dt>
                    <dd>
                      {library.models.find((item) => item.id === workspace?.modelRoutes[role]?.id)
                        ?.title ??
                        (workspace
                          ? workspace.modelRoutes[role]?.id
                            ? '사용 불가 · 등록된 모델을 찾을 수 없어요'
                            : '사용할 모델 미지정'
                          : '불러오는 중…')}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>로어·번역 거절·이미지 배치 판단</dt>
                  <dd>JEV</dd>
                </div>
              </dl>
              <button
                type="button"
                className="secondary"
                onClick={() => onGlobalSettings('models')}
              >
                <SettingsIcon size={18} aria-hidden="true" />
                전역 모델 설정
              </button>
            </div>
            <div hidden={tab !== 'prompts'} className="settings-inherited">
              <h4>전체 채팅 설정에서 사용하는 프롬프트</h4>
              <dl>
                <div>
                  <dt>번역</dt>
                  <dd>{workspace?.translation.title ?? '불러오는 중…'}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="secondary"
                onClick={() => onGlobalSettings('prompts')}
              >
                <SettingsIcon size={18} aria-hidden="true" />
                전역 프롬프트 설정
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
          className="profile-savebar form-actions settings-save-actions"
          hidden={tab !== 'characters' && !dirty && !lorePending}
        >
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
            {saving
              ? '저장 중…'
              : status || (dirty || lorePending ? '저장하지 않은 변경이 있어요.' : '')}
          </span>
          {(dirty || lorePending) && (
            <small>대화 구성·프롬프트·모델·로어 정책·자동 배치의 변경을 함께 저장해요.</small>
          )}
          <SaveButton
            label="채팅 설정 저장"
            disabled={saving || !dirty || lorePending}
            aria-busy={saving}
          />
        </div>
        {tab !== 'characters' && !dirty && !lorePending && status && <p role="status">{status}</p>}
      </form>
    </section>
  );
}
