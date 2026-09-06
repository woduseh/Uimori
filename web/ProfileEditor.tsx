import { useEffect, useState } from 'react';
import type { ChatProfile, Content, ContentRef, Library, ModelPreset, TaskRole } from '../core/product.js';
import { api } from './api.js';
import { CreativeEditor } from './CreativeEditor.js';
import { contentLabels, refValue } from './LibraryPanel.js';

export function ProfileEditor({ profile, library, onSaved, onError }: { profile: ChatProfile; library: Library; onSaved: () => Promise<void>; onError: (error: string) => void }) {
  const [value, setValue] = useState(profile);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [presetRef, setPresetRef] = useState('');
  const [archived, setArchived] = useState<{ contents: Content[]; models: ModelPreset[] }>({ contents: [], models: [] });
  useEffect(() => { if (!dirty) setValue(profile); }, [profile, dirty]);
  useEffect(() => {
    let alive = true;
    const refs = [...new Map(Object.values(value.routes).filter((item): item is ContentRef => item !== null).map(ref => [refValue(ref), ref])).values()];
    void Promise.all([
      Promise.all(value.attachments.filter(ref => !library.contents.some(item => refValue(item) === refValue(ref))).map(ref => api<Content>(`/revisions/content/${ref.id}/${ref.revision}`))),
      Promise.all(refs.filter(ref => !library.models.some(item => refValue(item) === refValue(ref))).map(ref => api<ModelPreset>(`/revisions/model/${ref.id}/${ref.revision}`))),
    ]).then(([contents, models]) => { if (alive) setArchived({ contents, models }); }).catch(error => { if (alive) onError(error.message); });
    return () => { alive = false; };
  }, [value.attachments, value.routes, library, onError]);
  const contents = [...library.contents, ...archived.contents.filter(old => !library.contents.some(item => refValue(item) === refValue(old)))];
  const models = [...library.models, ...archived.models.filter(old => !library.models.some(item => refValue(item) === refValue(old)))];
  const change = (next: ChatProfile) => { setValue(next); setDirty(true); };
  const toggleAttachment = (ref: ContentRef, checked: boolean) => change({ ...value, attachments: checked ? [...value.attachments.filter(item => item.id !== ref.id), ref] : value.attachments.filter(item => item.id !== ref.id || item.revision !== ref.revision) });
  async function save(work: () => Promise<unknown>) { setSaving(true); onError(''); try { await work(); setDirty(false); await onSaved(); } catch (error) { onError((error as Error).message); } finally { setSaving(false); } }
  return <details className="workspace-tools" data-testid="profile-editor"><summary>콘텐츠와 창작 제어 <small>장착 설정 v{profile.revision}</small></summary>
    <form className="editor-grid" onSubmit={event => { event.preventDefault(); void save(() => api(`/chats/${profile.chatId}/profile`, { expectedRevision: value.revision, attachments: value.attachments, creative: value.creative, routes: value.routes, image: value.image }, 'PUT')); }}>
      <fieldset className="attachment-list full"><legend>이 이야기에서 읽을 콘텐츠</legend>{!contents.length && <p className="muted">자료와 연결 관리에서 봇·페르소나·로어를 먼저 등록해 주세요.</p>}{contents.map(item => <label className="check" key={refValue(item)}><input type="checkbox" aria-label={`장착 ${contentLabels[item.kind]} ${item.title} v${item.revision}`} checked={value.attachments.some(ref => ref.id === item.id && ref.revision === item.revision)} onChange={event => toggleAttachment({ id: item.id, revision: item.revision }, event.target.checked)}/><span>{contentLabels[item.kind]} · {item.title} <small>{archived.contents.some(old => refValue(old) === refValue(item)) ? '보관된 ' : ''}v{item.revision} · {item.loading === 'pinned' ? '핵심 맥락' : '발견 가능'}</small></span></label>)}</fieldset>
      <div className="preset-apply full"><label>적용할 창작 프리셋<select aria-label="적용할 창작 프리셋" value={presetRef} onChange={event => setPresetRef(event.target.value)}><option value="">프리셋 선택</option>{library.presets.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · v{item.revision}</option>)}</select></label><button type="button" className="secondary" disabled={saving || !presetRef} onClick={() => { const preset = library.presets.find(item => refValue(item) === presetRef); if (preset) void save(() => api(`/chats/${profile.chatId}/preset`, { expectedRevision: value.revision, presetId: preset.id, presetRevision: preset.revision })); }}>프리셋으로 제어 전체 교체</button><small>저장된 창작 제어 그룹을 통째로 바꿔요. 이전 체크 값은 남지 않아요.</small></div>
      <CreativeEditor value={value.creative} onChange={creative => change({ ...value, creative })} prefix="profile"/>
      <fieldset className="control-grid"><legend>역할별 모델 경로</legend>{(['main', 'translation', 'status', 'image'] as TaskRole[]).map((role, index) => <label key={role}>{['원문 모델', '번역 모델', '표시 상태 모델', '이미지 선택 모델'][index]}<select aria-label={['원문 모델', '번역 모델', '표시 상태 모델', '이미지 선택 모델'][index]} value={value.routes[role] ? refValue(value.routes[role]!) : ''} onChange={event => { const model = models.find(item => refValue(item) === event.target.value); change({ ...value, routes: { ...value.routes, [role]: model ? { id: model.id, revision: model.revision } : null } }); }}><option value="">Scripted mock</option>{models.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · {item.modelId} · {archived.models.some(old => refValue(old) === refValue(item)) ? '보관된 ' : ''}v{item.revision}</option>)}</select></label>)}<label className="check"><input aria-label="보조 이미지 표시" type="checkbox" checked={value.image} onChange={event => change({ ...value, image: event.target.checked })}/>보조 이미지 표시</label><small>메인 원고에 이미지를 끼워 넣지 않고 원문 블록에 별도 표시해요.</small></fieldset>
      <div className="form-actions full"><button disabled={saving || !dirty}>콘텐츠와 제어 저장</button>{dirty && <button type="button" className="secondary" onClick={() => { setValue(profile); setDirty(false); onError(''); }}>장착 설정 다시 불러오기</button>}</div>
    </form>
  </details>;
}
