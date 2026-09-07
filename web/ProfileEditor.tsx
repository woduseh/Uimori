import { useEffect, useState } from 'react';
import type { ChatProfile, Content, ContentKind, ContentRef, CreativePreset, Library, ModelPreset, TaskRole } from '../core/product.js';
import { api } from './api.js';
import { CreativeEditor } from './CreativeEditor.js';
import { PromptEditor } from './PromptEditor.js';
import { contentLabels, refValue } from './LibraryPanel.js';

type ProfileSection = 'characters' | 'world' | 'creative' | 'prompts' | 'models';
const sections: { id: ProfileSection; title: string }[] = [{ id: 'characters', title: '인물' }, { id: 'world', title: '세계와 자료' }, { id: 'creative', title: '창작 제어' }, { id: 'prompts', title: '프롬프트' }, { id: 'models', title: '모델' }];
const kindDescriptions: Record<ContentKind, string> = { bot: '이야기에 등장하는 인물과 봇을 골라요.', persona: '내가 맡을 인물이에요. 선택하지 않아도 괜찮아요.', lore: '배경과 세계의 지식을 연결해요.', canon: '작가가 선언한 설정과 과거예요.', skill: '모델이 참고할 창작 방법이에요.', glossary: '이름과 번역 표현을 일관되게 유지해요.' };

export function ProfileEditor({ profile, library, onSaved, onError, onDirtyChange, onLibraryChanged, initialTab = 'characters' }: { profile: ChatProfile; library: Library; onSaved: () => Promise<void>; onError: (error: string) => void; onDirtyChange?: (dirty: boolean) => void; onLibraryChanged?: () => Promise<void>; initialTab?: ProfileSection }) {
  const [value, setValue] = useState(profile);
  const [dirty, setDirty] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presetRef, setPresetRef] = useState('');
  const [presetTitle, setPresetTitle] = useState('');
  const [tab, setTab] = useState<ProfileSection>(initialTab);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [archived, setArchived] = useState<{ contents: Content[]; models: ModelPreset[] }>({ contents: [], models: [] });
  useEffect(() => { if (!dirty) setValue(current => profile.chatId !== current.chatId || profile.revision >= current.revision ? profile : current); }, [profile, dirty]);
  useEffect(() => { onDirtyChange?.(dirty || promptDirty); }, [dirty, promptDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    let alive = true;
    const refs = [...new Map(Object.values(value.routes).filter((item): item is ContentRef => item !== null).map(ref => [refValue(ref), ref])).values()];
    void Promise.all([
      Promise.all(value.attachments.filter(ref => !library.contents.some(item => refValue(item) === refValue(ref))).map(ref => api<Content>(`/revisions/content/${ref.id}/${ref.revision}`))),
      Promise.all(refs.filter(ref => !library.models.some(item => refValue(item) === refValue(ref))).map(ref => api<ModelPreset>(`/revisions/model/${ref.id}/${ref.revision}`))),
    ]).then(([contents, models]) => { if (alive) setArchived({ contents, models }); }).catch(caught => { if (alive) { setError(caught.message); onError(caught.message); } });
    return () => { alive = false; };
  }, [value.attachments, value.routes, library, onError]);
  const contents = [...library.contents, ...archived.contents.filter(old => !library.contents.some(item => refValue(item) === refValue(old)))];
  const models = [...library.models, ...archived.models.filter(old => !library.models.some(item => refValue(item) === refValue(old)))];
  const change = (next: ChatProfile) => { setValue(next); setDirty(true); setStatus(''); };
  const toggleAttachment = (ref: ContentRef, checked: boolean) => change({ ...value, attachments: checked ? [...value.attachments.filter(item => item.id !== ref.id), ref] : value.attachments.filter(item => item.id !== ref.id || item.revision !== ref.revision) });
  async function save(work: () => Promise<ChatProfile>, message = '이야기 설정을 저장했어요.') {
    setSaving(true); onError(''); setError(''); setStatus('');
    try { const accepted = await work(); setValue(accepted); setDirty(false); setStatus(message); await onSaved(); return true; }
    catch (caught) { const message = (caught as Error).message; setError(message); onError(message); return false; }
    finally { setSaving(false); }
  }
  const profileBody = (next: ChatProfile) => ({ expectedRevision: next.revision, attachments: next.attachments, creative: next.creative, routes: next.routes, image: next.image, ...(next.prompts ? { prompts: next.prompts } : {}) });
  function renderAttachments(kind: ContentKind) {
    const available = contents.filter(item => item.kind === kind && `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const selectedCount = contents.filter(item => item.kind === kind && value.attachments.some(ref => refValue(ref) === refValue(item))).length;
    return <fieldset className="profile-attachment-group" key={kind}><legend>{contentLabels[kind]} <small>{selectedCount ? `${selectedCount}개 선택` : '선택 안 함'}</small></legend><p className="muted">{kindDescriptions[kind]}</p><div className="profile-attachment-options">{available.map(item => {
      const isArchived = archived.contents.some(old => refValue(old) === refValue(item));
      return <label className="check profile-attachment" key={refValue(item)}><input type="checkbox" aria-label={`장착 ${contentLabels[item.kind]} ${item.title} v${item.revision}`} checked={value.attachments.some(ref => refValue(ref) === refValue(item))} onChange={event => toggleAttachment({ id: item.id, revision: item.revision }, event.target.checked)}/><span><strong>{item.title}</strong>{item.description && <small>{item.description}</small>}<small>{isArchived ? `보관된 버전 v${item.revision} · ` : ''}{item.loading === 'pinned' ? '항상 포함' : '모델이 필요할 때 읽기'}</small></span></label>;
    })}{available.length === 0 && <p className="muted">{query ? '검색된 자료가 없어요.' : `서재에서 ${contentLabels[kind]} 자료를 먼저 만들 수 있어요.`}</p>}</div></fieldset>;
  }
  return <section className="profile-editor" data-testid="profile-editor" aria-label="콘텐츠와 창작 제어">
    <p className="muted profile-intro">이 이야기에서 사용할 인물과 창작 방식을 정해요.</p>
    <div className="profile-tabs" role="tablist" aria-label="이야기 설정 분류" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const index = sections.findIndex(item => item.id === tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length;
      setTab(sections[next].id); (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
    }}>{sections.map(item => <button type="button" role="tab" id={`profile-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="profile-fields" tabIndex={tab === item.id ? 0 : -1} key={item.id} className="secondary" onClick={() => setTab(item.id)}>{item.title}</button>)}</div>
    <form onSubmit={event => { event.preventDefault(); void save(() => api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody(value), 'PUT')); }}>
      <div id="profile-fields" role="tabpanel" aria-labelledby={`profile-tab-${tab}`}><fieldset className="profile-fields" disabled={saving}>
        {(tab === 'characters' || tab === 'world') && <><label className="profile-search">자료 찾기<input type="search" aria-label="이야기 자료 검색" placeholder="이름이나 설명으로 찾기" value={query} onChange={event => setQuery(event.target.value)}/></label>{(tab === 'characters' ? ['bot', 'persona'] as ContentKind[] : ['lore', 'canon', 'skill', 'glossary'] as ContentKind[]).map(renderAttachments)}<p className="muted">선택한 버전은 이 이야기에 고정돼요. 모델은 연결한 자료를 허용된 범위에서 자유롭게 검색하고 읽어요.</p></>}
        {tab === 'creative' && <div className="editor-grid"><div className="preset-apply full"><label>적용할 창작 프리셋<select aria-label="적용할 창작 프리셋" value={presetRef} onChange={event => setPresetRef(event.target.value)}><option value="">프리셋 선택</option>{library.presets.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · v{item.revision}</option>)}</select></label><button type="button" className="secondary" disabled={saving || !presetRef} onClick={() => {
          const preset = library.presets.find(item => refValue(item) === presetRef); if (!preset) return;
          void save(() => dirty ? api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody({ ...value, creative: structuredClone(preset.controls) }), 'PUT') : api<ChatProfile>(`/chats/${profile.chatId}/preset`, { expectedRevision: value.revision, presetId: preset.id, presetRevision: preset.revision }), `${preset.title}의 창작 제어를 적용했어요.`);
        }}>프리셋으로 제어 전체 교체</button><small>창작 제어 전체를 바꾸고 저장해요. 인물·자료·모델 선택은 유지해요{dirty ? ' (다른 탭의 수정값도 함께 저장해요)' : ''}.</small></div><CreativeEditor value={value.creative} onChange={creative => change({ ...value, creative })} prefix="profile"/><div className="preset-apply full"><label>새 프리셋 이름<input aria-label="이야기 프리셋 이름" value={presetTitle} maxLength={160} placeholder="이 창작 방식에 이름 붙이기" onChange={event => setPresetTitle(event.target.value)}/></label><button type="button" className="secondary" disabled={saving || !presetTitle.trim()} onClick={() => {
          setSaving(true); setError(''); setStatus(''); onError('');
          void api<CreativePreset>('/creative-presets', { title: presetTitle.trim(), controls: structuredClone(value.creative) }).then(async preset => { setStatus(`${preset.title} 프리셋을 저장했어요.`); await onLibraryChanged?.(); }).catch(caught => { setError(caught.message); onError(caught.message); }).finally(() => setSaving(false));
        }}>현재 제어를 프리셋으로 저장</button><small>화면에 편집 중인 창작 제어를 새 프리셋으로 보관해요. 원본 프리셋과 이야기의 저장된 설정은 바꾸지 않아요.</small></div></div>}
        <div hidden={tab !== 'prompts'}><PromptEditor library={library} reload={onLibraryChanged} onError={onError} selections={value.prompts} onDirtyChange={setPromptDirty} onApply={(role, reference) => save(() => api<ChatProfile>(`/chats/${profile.chatId}/profile`, profileBody({ ...value, prompts: { ...value.prompts, [role]: reference } }), 'PUT'), '프롬프트 선택을 이야기에 적용했어요.')}/></div>
        {tab === 'models' && <fieldset className="control-grid"><legend>역할별 모델</legend>{(['main', 'translation', 'status', 'image'] as TaskRole[]).map((role, index) => <label key={role}>{['본문 모델', '번역 모델', '표시 상태 모델', '이미지 선택 모델'][index]}<select aria-label={['원문 모델', '번역 모델', '표시 상태 모델', '이미지 선택 모델'][index]} value={value.routes[role] ? refValue(value.routes[role]!) : ''} onChange={event => { const model = models.find(item => refValue(item) === event.target.value); change({ ...value, routes: { ...value.routes, [role]: model ? { id: model.id, revision: model.revision } : null } }); }}><option value="">Scripted mock · 모의 생성</option>{models.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · {item.modelId} · {archived.models.some(old => refValue(old) === refValue(item)) ? '보관된 ' : ''}v{item.revision}</option>)}</select></label>)}<label className="check"><input aria-label="보조 이미지 표시" type="checkbox" checked={value.image} onChange={event => change({ ...value, image: event.target.checked })}/>보조 이미지 표시</label><small>이미지는 원고와 별도로 표시해요. 재사용할 연결과 모델 프리셋은 앱 설정에서 관리해요. 선택한 연결의 프로토콜과 서버 실행 한도가 적용돼요.</small></fieldset>}
      </fieldset></div>
      {profile.revision > value.revision && dirty && <p className="error" role="alert">다른 요청에서 이야기 설정이 바뀌었어요. 입력은 유지했어요. 최신 설정을 확인한 뒤 다시 저장해 주세요.</p>}
      {error && <p className="error" role="alert">{error} 입력한 내용은 유지했어요.</p>}
      <div className="profile-savebar form-actions"><button disabled={saving || !dirty}>{saving ? '저장 중…' : '콘텐츠와 제어 저장'}</button>{dirty && <button type="button" className="secondary" disabled={saving} onClick={() => { setValue(profile); setDirty(false); setError(''); setStatus('최신 설정을 불러왔어요.'); onError(''); }}>장착 설정 다시 불러오기</button>}<span role="status">{status || (dirty ? '저장하지 않은 변경이 있어요.' : '')}</span></div>
      <details className="profile-diagnostics"><summary>설정 저장 정보</summary><small>장착 설정 v{value.revision}</small></details>
    </form>
  </section>;
}
