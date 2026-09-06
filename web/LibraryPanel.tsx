import { useState } from 'react';
import { defaultCreative, type Connection, type Content, type ContentKind, type CreativePreset, type Library, type ModelPreset } from '../core/product.js';
import { api } from './api.js';
import { CreativeEditor } from './CreativeEditor.js';

export const contentLabels: Record<ContentKind, string> = { bot: '봇', persona: '페르소나', lore: '로어', canon: '작가 설정', skill: '창작 스킬', glossary: '명칭집' };
export const refValue = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
const freshContent = (): Omit<Content, 'id' | 'revision'> => ({ kind: 'lore', title: '', description: '', text: '', loading: 'discoverable', relatedIds: [] });

export function LibraryPanel({ library, reload, onError }: { library: Library | null; reload: () => Promise<void>; onError: (error: string) => void }) {
  const [tab, setTab] = useState<'content' | 'presets' | 'connections'>('content');
  return <details className="workspace-tools" data-testid="library-panel"><summary>자료와 연결 관리 <small>콘텐츠 · 창작 프리셋 · 모델</small></summary>
    <p className="muted">자료를 새 revision으로 보관한 뒤 각 이야기에서 사용할 버전을 선택해요.</p>
    <div className="segmented" role="tablist" aria-label="작업실 관리">{(['content', 'presets', 'connections'] as const).map((name, index) => <button type="button" role="tab" aria-selected={tab === name} className={tab === name ? '' : 'secondary'} key={name} onClick={() => setTab(name)}>{['콘텐츠', '창작 프리셋', '연결과 모델'][index]}</button>)}</div>
    {!library ? <p role="status">자료 목록을 불러오는 중이에요…</p> : tab === 'content' ? <ContentEditor library={library} reload={reload} onError={onError}/> : tab === 'presets' ? <PresetEditor library={library} reload={reload} onError={onError}/> : <ConnectionEditor library={library} reload={reload} onError={onError}/>}
  </details>;
}

function ContentEditor({ library, reload, onError }: { library: Library; reload: () => Promise<void>; onError: (error: string) => void }) {
  const [selected, setSelected] = useState<Content | null>(null);
  const [value, setValue] = useState(freshContent);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [relatedText, setRelatedText] = useState('');
  const choose = (key: string) => {
    const item = library.contents.find(item => refValue(item) === key) ?? null;
    setSelected(item); setValue(item ? { kind: item.kind, title: item.title, description: item.description, text: item.text, loading: item.loading, relatedIds: item.relatedIds } : freshContent()); setRelatedText(item?.relatedIds.join(', ') ?? ''); setSaved('');
  };
  return <form className="editor-grid" onSubmit={async event => {
    event.preventDefault(); setBusy(true); onError(''); setSaved('');
    try {
      const item = await api<Content>(selected ? `/content/${selected.id}` : '/content', { ...value, relatedIds: relatedText.split(',').map(id => id.trim()).filter(Boolean), ...(selected ? { expectedRevision: selected.revision } : {}) }, selected ? 'PUT' : 'POST');
      await reload(); setSelected(item); setValue({ kind: item.kind, title: item.title, description: item.description, text: item.text, loading: item.loading, relatedIds: item.relatedIds }); setSaved(`${item.title} · v${item.revision} 저장됨`);
    } catch (error) { onError((error as Error).message); } finally { setBusy(false); }
  }}>
    <label className="full">편집할 자료<select aria-label="편집할 자료" value={selected ? refValue(selected) : ''} onChange={event => choose(event.target.value)}><option value="">새 자료 만들기</option>{library.contents.map(item => <option key={refValue(item)} value={refValue(item)}>{contentLabels[item.kind]} · {item.title} · v{item.revision}</option>)}</select></label>
    <label>자료 종류<select aria-label="자료 종류" value={value.kind} disabled={!!selected} onChange={event => { const kind = event.target.value as ContentKind; setValue({ ...value, kind, loading: ['bot', 'persona', 'canon'].includes(kind) ? 'pinned' : 'discoverable' }); }}>{Object.entries(contentLabels).map(([kind, title]) => <option key={kind} value={kind}>{title}</option>)}</select></label>
    <label>자료 이름<input aria-label="자료 이름" value={value.title} maxLength={160} required onChange={event => setValue({ ...value, title: event.target.value })}/></label>
    <label className="full">자료 설명<input aria-label="자료 설명" value={value.description} maxLength={1000} onChange={event => setValue({ ...value, description: event.target.value })}/></label>
    <label className="full">자료 본문<textarea aria-label="자료 본문" rows={7} value={value.text} maxLength={100000} required onChange={event => setValue({ ...value, text: event.target.value })}/></label>
    <label>기본 로딩<select aria-label="기본 로딩" value={value.loading} onChange={event => setValue({ ...value, loading: event.target.value as Content['loading'] })}><option value="pinned">핵심 맥락에 포함</option><option value="discoverable">목록과 읽기 도구로 발견</option></select></label>
    <label>관련 자료 ID<input aria-label="관련 자료 ID" value={relatedText} onChange={event => setRelatedText(event.target.value)} placeholder="쉼표로 구분"/></label>
    {value.kind === 'canon' && <small className="full">작가가 선언한 과거·설정으로 보관해요. 실제로 생성한 대화 기록으로 바꾸지 않아요.</small>}
    {value.kind === 'skill' && <small className="full">창작 방법을 설명하는 자료예요. 읽기 도구나 앱의 권한을 늘리지 않아요.</small>}
    <div className="form-actions full"><button disabled={busy}>{selected ? '새 revision 저장' : '자료 등록'}</button>{selected && <button type="button" className="secondary" onClick={() => choose('')}>새 자료 작성</button>}<span role="status">{saved}</span></div>
  </form>;
}

function PresetEditor({ library, reload, onError }: { library: Library; reload: () => Promise<void>; onError: (error: string) => void }) {
  const [title, setTitle] = useState('');
  const [controls, setControls] = useState(defaultCreative);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  return <form className="editor-grid" onSubmit={async event => {
    event.preventDefault(); setBusy(true); onError('');
    try { const result = await api<CreativePreset>('/creative-presets', { title, controls }); await reload(); setSaved(`${result.title} 저장됨`); }
    catch (error) { onError((error as Error).message); } finally { setBusy(false); }
  }}>
    <label className="full">프리셋에서 시작<select aria-label="프리셋에서 시작" defaultValue="" onChange={event => { const preset = library.presets.find(item => refValue(item) === event.target.value); if (preset) { setControls(structuredClone(preset.controls)); setTitle(`${preset.title} 사본`); } }}><option value="">기본값</option>{library.presets.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · v{item.revision}</option>)}</select></label>
    <label className="full">새 창작 프리셋 이름<input aria-label="새 창작 프리셋 이름" value={title} maxLength={160} required onChange={event => setTitle(event.target.value)}/></label>
    <CreativeEditor value={controls} onChange={setControls} prefix="preset"/>
    <div className="form-actions full"><button disabled={busy}>창작 프리셋 저장</button><span role="status">{saved}</span></div>
  </form>;
}

function ConnectionEditor({ library, reload, onError }: { library: Library; reload: () => Promise<void>; onError: (error: string) => void }) {
  const [connection, setConnection] = useState({ title: '', endpoint: '', credentialEnv: '', enabled: false });
  const [model, setModel] = useState({ title: '', connectionRef: '', modelId: '', maxOutputTokens: 8192, temperature: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const chosen = library.connections.find(item => refValue(item) === model.connectionRef);
  async function perform(work: () => Promise<void>) { setBusy(true); onError(''); setMessage(''); try { await work(); await reload(); } catch (error) { onError((error as Error).message); await reload().catch(() => undefined); } finally { setBusy(false); } }
  return <div className="connection-editor">
    <p className="muted">기본 생성은 scripted mock이에요. 현재 등록 가능한 전송은 로컬 검사용 fixture-sse-v1이며 실서비스 지원을 뜻하지 않아요. 연결 등록과 별개로 서버가 허용한 loopback 주소만 호출해요.</p>
    <div className="connection-list">{library.connections.map(item => <article className="compact-card" key={refValue(item)}><strong>{item.title} · v{item.revision}</strong><small>{item.protocol} · {item.enabled ? '활성 설정' : '비활성'}</small><code>{item.endpoint}</code>{item.catalogError && <p className="error">모델 목록을 새로 받지 못했어요. 기존 연결과 수동 모델 ID는 유지해요.</p>}<button className="secondary" disabled={busy} onClick={() => { void perform(async () => { await api(`/connections/${item.id}/catalog`, {}); setMessage('모델 목록 새로고침 완료'); }); }}>모델 목록 새로고침</button></article>)}</div>
    <form className="editor-grid" onSubmit={event => { event.preventDefault(); void perform(async () => { const created = await api<Connection>('/connections', { title: connection.title, protocol: 'fixture-sse-v1', endpoint: connection.endpoint, ...(connection.credentialEnv.trim() ? { credentialEnv: connection.credentialEnv.trim() } : {}), enabled: connection.enabled }); setMessage(`${created.title} 연결 등록됨`); }); }}>
      <h3 className="full">연결 등록</h3><label>연결 이름<input aria-label="연결 이름" required maxLength={160} value={connection.title} onChange={event => setConnection({ ...connection, title: event.target.value })}/></label>
      <label>로컬 endpoint<input aria-label="로컬 endpoint" type="url" required placeholder="http://127.0.0.1:포트" value={connection.endpoint} onChange={event => setConnection({ ...connection, endpoint: event.target.value })}/></label>
      <label>서버 환경변수 이름<input aria-label="서버 환경변수 이름" autoComplete="off" pattern="NARRATIVE_PROVIDER_[A-Z0-9_]+" placeholder="NARRATIVE_PROVIDER_NAME" value={connection.credentialEnv} onChange={event => setConnection({ ...connection, credentialEnv: event.target.value })}/></label>
      <label className="check"><input type="checkbox" checked={connection.enabled} onChange={event => setConnection({ ...connection, enabled: event.target.checked })}/>이 연결 사용</label>
      <small className="full">인증 값은 서버 환경변수에서만 읽어요. 브라우저에는 환경변수 이름만 전달하고 키는 저장하지 않아요.</small>
      <button disabled={busy}>연결 등록</button>
    </form>
    <form className="editor-grid" onSubmit={event => { event.preventDefault(); if (!chosen) return; void perform(async () => { const created = await api<ModelPreset>('/model-presets', { title: model.title, connectionId: chosen.id, connectionRevision: chosen.revision, modelId: model.modelId, maxOutputTokens: model.maxOutputTokens, temperature: model.temperature === '' ? null : Number(model.temperature) }); setMessage(`${created.title} 모델 프리셋 등록됨`); }); }}>
      <h3 className="full">모델 프리셋 등록</h3><label>모델 프리셋 이름<input aria-label="모델 프리셋 이름" required maxLength={160} value={model.title} onChange={event => setModel({ ...model, title: event.target.value })}/></label>
      <label>모델 연결<select aria-label="모델 연결" required value={model.connectionRef} onChange={event => setModel({ ...model, connectionRef: event.target.value })}><option value="">연결 선택</option>{library.connections.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title} · v{item.revision}</option>)}</select></label>
      <label>모델 ID<input aria-label="모델 ID" list="available-models" required value={model.modelId} onChange={event => setModel({ ...model, modelId: event.target.value })}/><datalist id="available-models">{chosen?.catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist></label>
      <label>최대 출력 토큰<input aria-label="최대 출력 토큰" type="number" min={1} max={100000} value={model.maxOutputTokens} onChange={event => setModel({ ...model, maxOutputTokens: Number(event.target.value) })}/></label>
      <label>Temperature<input aria-label="Temperature" type="number" step={0.1} min={0} max={2} placeholder="기본값" value={model.temperature} onChange={event => setModel({ ...model, temperature: event.target.value })}/></label>
      <small>목록에 없는 ID도 직접 등록할 수 있어요. 알려지지 않은 기능·가격은 미확인으로 유지해요.</small><button disabled={busy || !chosen}>모델 프리셋 등록</button>
    </form><p role="status">{message}</p>
  </div>;
}
