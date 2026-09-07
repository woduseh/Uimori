import { useEffect, useRef, useState } from 'react';
import type { Connection, Library, ModelPreset, ProviderProtocol } from '../core/product.js';
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import { SOL_GATEWAYS, solGatewayForEndpoint } from '../core/sol-config.js';
import { api, ApiError } from './api.js';
import { initialModel, modelDraft, modelPayload, ProviderModelFields, selectModelConnection, type ModelDraft } from './ProviderModelFields.js';
import { ProviderReadiness } from './ProviderReadiness.js';
import { ProviderRegistrationAssistant } from './ProviderRegistrationAssistant.js';
import './ProviderManagement.css';

const versionRef=(item:{id:string;revision:number})=>`${item.id}@${item.revision}`;
type ConnectionDraft={title:string;protocol:ProviderProtocol;endpoint:string;credentialEnv:string;enabled:boolean;requestTier:'standard'|'flex'};
const initialConnection=():ConnectionDraft=>({title:'',protocol:'fixture-sse-v1',endpoint:'',credentialEnv:'',enabled:false,requestTier:'flex'});
const connectionDraft=(item:Connection):ConnectionDraft=>({title:item.title,protocol:item.protocol,endpoint:item.endpoint,credentialEnv:item.credentialEnv??'',enabled:item.enabled,requestTier:item.requestTier??'flex'});
function connectionPayload(value:ConnectionDraft) {
  return {title:value.title,protocol:value.protocol,endpoint:value.endpoint,...(value.credentialEnv.trim()?{credentialEnv:value.credentialEnv.trim()}:{}),...(value.protocol==='vertex-gemini-v1'?{requestTier:value.requestTier}:{}),enabled:value.enabled};
}
type Confirmation={kind:'connection'|'model';id:string;title:string;body:Record<string,unknown>;fromForm:boolean};
const matches=(query:string,...values:(string|undefined)[])=>!query||values.some(value=>value?.toLocaleLowerCase().includes(query));
const capability=(value:boolean|null|undefined)=>value===true?'사용자 확인 · 지원':value===false?'사용자 확인 · 미지원':'미확인';

export function ConnectionEditor({library,reload,onError}:{library:Library;reload:()=>Promise<void>;onError:(error:string)=>void}) {
  const [query,setQuery]=useState('');
  const [connection,setConnection]=useState(initialConnection); const [editingConnection,setEditingConnection]=useState<Connection>(); const [connectionCopy,setConnectionCopy]=useState(false);
  const [model,setModel]=useState(initialModel); const [editingModel,setEditingModel]=useState<ModelPreset>(); const [modelCopy,setModelCopy]=useState(false);
  const [selectedConnection,setSelectedConnection]=useState<Connection>();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [conflict,setConflict]=useState<'connection'|'model'|'status'|null>(null),[confirmation,setConfirmation]=useState<Confirmation>();
  const [registeredModel,setRegisteredModel]=useState<ModelPreset>();
  const connectionForm=useRef<HTMLFormElement>(null),modelForm=useRef<HTMLFormElement>(null),confirmationPanel=useRef<HTMLElement>(null);
  useEffect(()=>{if(confirmation)confirmationPanel.current?.scrollIntoView({block:'nearest'});},[confirmation]);
  const chosen=selectedConnection&&versionRef(selectedConnection)===model.connectionRef?selectedConnection:undefined;
  const liveChosen=library.connections.find(item=>item.id===chosen?.id);
  const modelConnections=chosen&&!library.connections.some(item=>versionRef(item)===versionRef(chosen))?[chosen,...library.connections]:library.connections;
  const definition=providerDefinition(connection.protocol),vertex=connection.protocol==='vertex-gemini-v1',solConnection=connection.protocol==='sol-responses-v1';
  const gateway=(()=>{try{return solConnection?solGatewayForEndpoint(connection.endpoint):'vercel';}catch{return 'local';}})();
  const official=['openai-responses-v1','anthropic-messages-v1','vercel-chat-v1'].includes(connection.protocol)||(solConnection&&gateway!=='local');
  const endpointLabel=vertex?'Vertex endpoint':connection.protocol==='fixture-sse-v1'?'로컬 endpoint':'API 기본 주소';
  const filter=query.trim().toLocaleLowerCase();
  const connections=library.connections.filter(item=>matches(filter,item.title,item.endpoint,providerDefinition(item.protocol).label));
  const models=library.models.filter(item=>matches(filter,item.title,item.modelId,library.connections.find(c=>c.id===item.connectionId)?.title));

  async function perform(work:()=>Promise<void>,scope:'connection'|'model'|'status'='status') {
    setBusy(true);setError('');onError('');setMessage('');
    try {await work();await reload();}
    catch(caught){const detail=caught instanceof Error?caught.message:'작업을 완료하지 못했어요.';setError(detail);onError(detail);if(caught instanceof ApiError&&caught.status===409)setConflict(scope);await reload().catch(()=>undefined);}
    finally{setBusy(false);}
  }
  function showConnection(item:Connection,copy=false) {
    setConnection({...connectionDraft(item),...(copy?{title:item.title+' 복사',enabled:false}:{})});setEditingConnection(copy?undefined:structuredClone(item));setConnectionCopy(copy);setConflict(null);setConfirmation(undefined);setError('');onError('');
    requestAnimationFrame(()=>connectionForm.current?.scrollIntoView({block:'start'}));
  }
  async function showModel(item:ModelPreset,copy=false) {
    const linked=library.connections.find(c=>c.id===item.connectionId&&c.revision===item.connectionRevision)??await api<Connection>(`/revisions/connection/${item.connectionId}/${item.connectionRevision}`);
    setSelectedConnection(structuredClone(linked));setModel({...modelDraft(item),...(copy?{title:item.title+' 복사'}:{})});setEditingModel(copy?undefined:structuredClone(item));setModelCopy(copy);setConflict(null);setConfirmation(undefined);
    requestAnimationFrame(()=>modelForm.current?.scrollIntoView({block:'start'}));
  }
  function chooseConnection(item:Connection) {setSelectedConnection(structuredClone(item));setModel(current=>selectModelConnection(current,item));}
  async function saveConnection(body:Record<string,unknown>,id?:string,fromForm=true) {
    const saved=await api<Connection>(id?`/connections/${id}`:'/connections',body,id?'PUT':'POST');
    if(fromForm){setEditingConnection(saved);setConnection(connectionDraft(saved));setConnectionCopy(false);setConflict(null);if(!id&&!editingModel){chooseConnection(saved);requestAnimationFrame(()=>modelForm.current?.scrollIntoView({block:'start'}));}}
    setConfirmation(undefined);setMessage(saved.title+(id?' 연결 변경 저장됨':' 연결 등록됨'));
  }
  async function saveModel(body:Record<string,unknown>,id?:string,fromForm=true) {
    const saved=await api<ModelPreset>(id?`/model-presets/${id}`:'/model-presets',body,id?'PUT':'POST');
    if(fromForm){setEditingModel(saved);setModel(modelDraft(saved));setModelCopy(false);setConflict(null);setRegisteredModel(saved);}
    setConfirmation(undefined);setMessage(saved.title+(id?' 모델 변경 저장됨':' 모델 프리셋 등록됨'));
  }
  async function catalog(item:Connection) {
    const result=await api<Connection>(`/connections/${item.id}/catalog`,{});
    if(result.catalogError)throw new Error('모델 목록을 확인하지 못했어요. 마지막 저장 목록과 수동 모델 ID를 유지해요.');
    if(chosen?.id===item.id&&!editingModel&&!modelCopy&&!model.modelId){setSelectedConnection(result);setModel(current=>({...current,connectionRef:versionRef(result)}));}
    setMessage(result.protocol==='vertex-gemini-v1'?'로컬 지원 모델 목록 확인 완료 · 공급자 조회 없음':'모델 목록 조회 완료');
  }
  function statusConnection(item:Connection) {
    const body={...connectionPayload(connectionDraft(item)),enabled:!item.enabled,expectedRevision:item.revision};
    if(item.enabled)setConfirmation({kind:'connection',id:item.id,title:item.title,body,fromForm:false});else void perform(()=>saveConnection(body,item.id,false));
  }
  function statusModel(item:ModelPreset) {
    const {id,revision,source:_,...body}=item; const updated={...body,enabled:item.enabled===false,expectedRevision:revision};
    if(item.enabled!==false)setConfirmation({kind:'model',id,title:item.title,body:updated,fromForm:false});else void perform(()=>saveModel(updated,id,false));
  }
  async function latest(kind:'connection'|'model') {
    const fresh=await api<Library>('/library');
    if(kind==='connection'&&editingConnection){const value=fresh.connections.find(item=>item.id===editingConnection.id);if(!value)throw new Error('연결을 찾지 못했어요.');showConnection(value);}
    if(kind==='model'&&editingModel){const value=fresh.models.find(item=>item.id===editingModel.id);if(!value)throw new Error('모델을 찾지 못했어요.');await showModel(value);}
    setMessage('최신 저장 내용으로 편집 초안을 교체했어요.');
  }
  function newConnection(){setConnection(initialConnection());setEditingConnection(undefined);setConnectionCopy(false);setConflict(null);setError('');requestAnimationFrame(()=>connectionForm.current?.scrollIntoView({block:'start'}));}
  function newModel(){setModel(chosen?selectModelConnection(initialModel(),chosen):initialModel());setEditingModel(undefined);setModelCopy(false);setConflict(null);setError('');requestAnimationFrame(()=>modelForm.current?.scrollIntoView({block:'start'}));}

  return <section className="connection-editor" data-testid="connection-editor" aria-label="연결과 모델">
    <div className="connection-notice"><strong>공급자 연결과 모델을 준비하세요</strong><p>연결을 저장하고 모델을 등록한 뒤 이야기의 역할에 배정해요. 인증 값은 서버에 두고 여기에는 환경변수 이름만 저장해요.</p><p>모델별 기능과 가격은 미확인이에요. 과거 실행과 이야기의 모델 버전은 수정·복제로 자동 교체되지 않아요.</p></div>
    <div className="provider-toolbar"><label>연결·모델 검색<input type="search" aria-label="연결·모델 검색" placeholder="이름, 주소, 모델 ID" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="provider-actions"><button type="button" className="secondary" disabled={busy} onClick={newConnection}>새 연결 입력</button><button type="button" className="secondary" disabled={busy} onClick={newModel}>새 모델 입력</button><button type="button" className="secondary" disabled={busy} onClick={()=>{void perform(async()=>{await reload();setMessage('목록을 새로 읽었어요. 편집 초안은 유지돼요.');});}}>목록 새로고침</button></div></div>
    <section aria-label="저장한 연결"><h3>저장한 연결 <small>{connections.length}개</small></h3><div className="connection-list provider-saved-list">{connections.map(item=><article className="compact-card" key={versionRef(item)} aria-label={item.title+' 연결'}><div className="provider-section-heading"><strong>{item.title}</strong><span className="provider-status">v{item.revision} · {item.enabled?'사용 허용':'비활성'}</span></div><small>{providerDefinition(item.protocol).label}{item.protocol==='vertex-gemini-v1'?` · ${item.requestTier==='flex'?'Flex':'Standard'} (서버 설정 우선)`:''}</small><code>{item.endpoint}</code>{item.catalogError&&<p className="error">모델 목록 조회 실패 · 마지막 저장 목록을 유지해요.</p>}<div className="provider-actions"><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 연결 수정'} onClick={()=>showConnection(item)}>수정</button><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 연결 복제'} onClick={()=>showConnection(item,true)}>복제</button><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 연결 '+(item.enabled?'비활성':'활성화')} onClick={()=>statusConnection(item)}>{item.enabled?'비활성':'활성화'}</button><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 모델 입력에 사용'} onClick={()=>{chooseConnection(item);requestAnimationFrame(()=>modelForm.current?.scrollIntoView({block:'start'}));}}>모델 입력에 사용</button><button type="button" className="secondary" disabled={busy} aria-label={item.title+' '+(item.protocol==='vertex-gemini-v1'?'로컬 지원 모델 확인':'모델 목록 새로고침')} onClick={()=>{void perform(()=>catalog(item));}}>{item.protocol==='vertex-gemini-v1'?'로컬 지원 모델 확인':'모델 목록 새로고침'}</button></div></article>)}{connections.length===0&&<p className="provider-empty">{filter?'검색 조건에 맞는 연결이 없어요.':'아직 저장한 연결이 없어요.'}</p>}</div></section>
    <section className="registered-models" aria-label="저장한 모델 프리셋"><h3>저장한 모델 프리셋 <small>{models.length}개</small></h3><div className="provider-saved-list">{models.map(item=><article className="compact-card" key={versionRef(item)} aria-label={item.title+' 모델'}><div className="provider-section-heading"><strong>{item.title}</strong><span className="provider-status">v{item.revision} · {item.enabled===false?'새 선택에서 제외':'모델 활성'}</span></div><small>{item.modelId} · 최대 {item.maxOutputTokens.toLocaleString()} 토큰{item.timeoutMs!==undefined&&` · 제한 ${item.timeoutMs/1000}초`}</small><small>{library.connections.find(c=>c.id===item.connectionId)?.title??'보관된 연결'} · 연결 v{item.connectionRevision}</small><details className="provider-capabilities"><summary>기능·출처·가격 확인</summary><p>모델별 공급자 기능: 미확인 · 가격: 미확인</p><p>도구 호출: {capability(item.userOverrides?.tools)}<br/>구조화 출력: {capability(item.userOverrides?.structuredOutput)}</p>{item.userOverrides?.note&&<p className="provider-override-note">사용자 메모: {item.userOverrides.note}</p>}<p>등록 출처: {item.source?.kind==='catalog'?'목록에서 선택':item.source?.kind==='manual'?'직접 입력':'미기록'}{item.source&&` · 연결 v${item.source.connectionRevision}`}<br/>목록 확인일: {item.source?.catalogUpdatedAt??'미확인'}</p></details><div className="provider-actions"><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 모델 수정'} onClick={()=>{void perform(()=>showModel(item),'model');}}>수정</button><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 모델 복제'} onClick={()=>{void perform(()=>showModel(item,true),'model');}}>복제</button><button type="button" className="secondary" disabled={busy} aria-label={item.title+' 모델 '+(item.enabled===false?'활성화':'비활성')} onClick={()=>statusModel(item)}>{item.enabled===false?'활성화':'비활성'}</button></div></article>)}{models.length===0&&<p className="provider-empty">{filter?'검색 조건에 맞는 모델이 없어요.':'아직 저장한 모델 프리셋이 없어요.'}</p>}</div></section>
    {confirmation&&<section ref={confirmationPanel} className="provider-impact" aria-label="비활성 영향 확인"><strong>{confirmation.title} · 비활성으로 바꿀까요?</strong><p>{confirmation.kind==='connection'?'이 연결을 사용하는 기존 이야기의 다음 호출도 차단돼요. 저장된 원고와 이야기의 모델 선택은 유지돼요.':'새 이야기와 새 모델 선택에서 제외돼요. 기존 이야기가 고정한 모델 버전은 계속 사용할 수 있어요.'}</p><p>이미 저장된 원문·번역과 과거 실행 기록은 바꾸지 않아요.</p><div className="provider-actions"><button type="button" disabled={busy} onClick={()=>{void perform(()=>confirmation.kind==='connection'?saveConnection(confirmation.body,confirmation.id,confirmation.fromForm):saveModel(confirmation.body,confirmation.id,confirmation.fromForm),confirmation.fromForm?confirmation.kind:'status');}}>{confirmation.kind==='connection'?'연결':'모델'} 비활성 확인</button><button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmation(undefined)}>비활성 취소</button></div>{conflict==='status'&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void perform(async()=>{await reload();setConfirmation(undefined);setConflict(null);setMessage('최신 목록에서 대상을 다시 선택해 주세요.');});}}>최신 목록 다시 불러오기</button>}</section>}
    <form ref={connectionForm} className="editor-grid provider-management-form" aria-label="연결 편집 양식" onSubmit={event=>{event.preventDefault();const body={...connectionPayload(connection),...(editingConnection?{expectedRevision:editingConnection.revision}:{})};if(editingConnection?.enabled&&!connection.enabled){setConfirmation({kind:'connection',id:editingConnection.id,title:connection.title,body,fromForm:true});return;}void perform(()=>saveConnection(body,editingConnection?.id),'connection');}}>
      <h3 className="full">{editingConnection?'연결 수정':connectionCopy?'연결 복제 검토':'연결 등록'}</h3>
      {editingConnection&&<div className="provider-draft-note full"><strong>편집 기준 v{editingConnection.revision}</strong><p>주소·프로토콜·인증 참조를 바꾸면 과거 버전을 쓰는 요청도 차단될 수 있어요. 이야기의 모델 참조는 자동 교체되지 않아요.</p>{library.connections.find(item=>item.id===editingConnection.id)?.revision!==editingConnection.revision&&<p>목록에 더 최신 버전이 있어요. 편집 중인 초안과 기준 버전은 유지했어요.</p>}<button type="button" className="secondary" disabled={busy} onClick={()=>{void perform(()=>latest('connection'),'connection');}}>최신 연결 다시 불러오기 · 초안 교체</button></div>}
      {connectionCopy&&<p className="provider-draft-note full">새 ID로 복제해요. 사용 허용은 꺼져 있으며, 아래에 복사된 서버 환경변수 이름을 확인한 뒤 등록하세요.</p>}
      {conflict==='connection'&&<p className="error full" role="alert">저장 충돌이 발생했어요. 초안은 유지했어요. 최신 연결을 불러오면 현재 입력을 교체해요.</p>}
      <fieldset className="editor-fields full" disabled={busy}>
        <label>연결 이름<input aria-label="연결 이름" required maxLength={160} value={connection.title} onChange={event=>setConnection({...connection,title:event.target.value})}/></label>
        <label>연결 프로토콜<select aria-label="연결 프로토콜" value={connection.protocol} onChange={event=>{const protocol=event.target.value as ProviderProtocol,definition=providerDefinition(protocol);setConnection({...connection,protocol,endpoint:definition.endpointDefault,credentialEnv:definition.credentialEnvDefault});}}>{PROVIDER_DEFINITIONS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        {solConnection&&<label className="full">Sol 게이트웨이<select aria-label="Sol 게이트웨이" value={gateway} onChange={event=>{const selected=SOL_GATEWAYS.find(item=>item.id===event.target.value);setConnection({...connection,endpoint:selected?.endpoint??'http://127.0.0.1:8080/v1',credentialEnv:selected?.credentialEnv??''});}}>{SOL_GATEWAYS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}<option value="local">로컬 Responses 연결</option></select></label>}
        <label className="full">{endpointLabel}<input aria-label={endpointLabel} type="url" required readOnly={official} placeholder={vertex?'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models':connection.protocol==='fixture-sse-v1'?'http://127.0.0.1:포트':'https://provider.example/v1'} value={connection.endpoint} onChange={event=>setConnection({...connection,endpoint:event.target.value})}/></label>
        <label className="full">서버 환경변수 이름<input aria-label="서버 환경변수 이름" autoComplete="off" required={official} pattern="NARRATIVE_PROVIDER_[A-Z0-9_]+" placeholder={vertex?'비우면 서버 ADC 사용':'NARRATIVE_PROVIDER_NAME'} value={connection.credentialEnv} onChange={event=>setConnection({...connection,credentialEnv:event.target.value})}/></label>
        {vertex&&<label>Vertex 요청 요금제<select aria-label="Vertex 요청 요금제" value={connection.requestTier} onChange={event=>setConnection({...connection,requestTier:event.target.value as 'standard'|'flex'})}><option value="flex">Flex · 지연 가능, 자동 Standard 전환 없음</option><option value="standard">Standard</option></select></label>}
        <label className="check"><input type="checkbox" checked={connection.enabled} onChange={event=>setConnection({...connection,enabled:event.target.checked})}/>이 연결 사용</label>
        <small className="full">{vertex?'환경변수 이름을 비우면 서버의 GOOGLE_APPLICATION_CREDENTIALS 파일로 인증해요. 서버 NR_VERTEX_REQUEST_TIER 설정이 선택보다 우선해요.':connection.protocol==='openai-chat-v1'?'기본 주소 뒤에 /chat/completions를 붙여요. 인증 없는 로컬 서버는 환경변수 이름을 비워 두세요.':'인증 키 값은 입력하지 마세요. 서버의 환경변수와 NR_PROVIDER_ORIGINS 허용 주소를 설정한 뒤 사용할 수 있어요.'}</small>
        {connection.protocol==='vercel-chat-v1'&&<small className="full">Vercel AI Gateway key를 환경변수에 넣고 모델 ID는 공급자/모델 형식으로 지정해요.</small>}
        {solConnection&&<small className="full">Sol은 Responses 형식으로 연결해요. Vercel 모델 ID는 공급자/모델 형식이고 다른 게이트웨이는 해당 모델 ID를 사용해요. 로컬 연결은 127.0.0.1 또는 [::1]의 /v1 주소만 허용해요.</small>}
        <details className="provider-definition full"><summary>연결 템플릿 정보</summary><dl><dt>정의</dt><dd>{definition.id} · v{definition.revision}</dd><dt>확인일</dt><dd>{definition.source.checkedAt}</dd><dt>근거</dt><dd>로컬 어댑터 · {definition.source.reference}</dd><dt>인증 방식</dt><dd>{definition.auth}</dd><dt>목록 방식</dt><dd>{definition.catalog==='remote'?'명시 요청 시 원격 조회':'로컬 지원 목록'}</dd><dt>설정할 수 있는 옵션</dt><dd>{definition.optionKeys.join(', ')}</dd></dl><ul>{definition.limitations.map(item=><li key={item}>{item}</li>)}</ul><p>연결 템플릿은 로컬 구현의 설명이에요. 모델별 기능과 가격은 미확인이에요.</p></details>
      </fieldset><div className="provider-actions full"><button disabled={busy}>{editingConnection?'연결 변경 저장':'연결 등록'}</button>{(editingConnection||connectionCopy)&&<button type="button" className="secondary" disabled={busy} onClick={newConnection}>연결 편집 끝내기</button>}</div>
    </form>
    <form ref={modelForm} className="editor-grid provider-management-form" aria-label="모델 편집 양식" onSubmit={event=>{event.preventDefault();if(!chosen)return;const body={...modelPayload(model,chosen),...(editingModel?{expectedRevision:editingModel.revision}:{})};if(editingModel&&editingModel.enabled!==false&&!model.enabled){setConfirmation({kind:'model',id:editingModel.id,title:model.title,body,fromForm:true});return;}void perform(()=>saveModel(body,editingModel?.id),'model');}}>
      <h3 className="full">{editingModel?'모델 프리셋 수정':modelCopy?'모델 프리셋 복제 검토':'모델 프리셋 등록'}</h3>
      {editingModel&&<div className="provider-draft-note full"><strong>편집 기준 v{editingModel.revision}</strong><p>저장하면 같은 모델의 새 버전이 생겨요. 기존 이야기와 과거 실행이 가리키는 버전은 유지돼요.</p>{library.models.find(item=>item.id===editingModel.id)?.revision!==editingModel.revision&&<p>더 최신 버전이 있어요. 현재 입력과 기준 버전은 바꾸지 않았어요.</p>}<button type="button" className="secondary" disabled={busy} onClick={()=>{void perform(()=>latest('model'),'model');}}>최신 모델 다시 불러오기 · 초안 교체</button></div>}
      {modelCopy&&<p className="provider-draft-note full">설정과 연결 버전을 검토하고 새 ID로 등록해요. 원래 모델과 이야기의 선택은 바뀌지 않아요.</p>}
      {conflict==='model'&&<p className="error full" role="alert">저장 충돌이 발생했어요. 초안은 유지했어요. 최신 모델을 불러오면 현재 입력을 교체해요.</p>}
      <fieldset className="editor-fields full" disabled={busy}>
        <label className="full">모델 프리셋 이름<input aria-label="모델 프리셋 이름" required maxLength={160} value={model.title} onChange={event=>setModel({...model,title:event.target.value})}/></label>
        <label className="full">모델 연결<select aria-label="모델 연결" required value={model.connectionRef} onChange={event=>{const item=modelConnections.find(item=>versionRef(item)===event.target.value);if(item)chooseConnection(item);else{setSelectedConnection(undefined);setModel({...model,connectionRef:''});}}}><option value="">연결 선택</option>{modelConnections.map(item=><option key={versionRef(item)} value={versionRef(item)}>{item.title} · v{item.revision}{item.enabled?'':' · 비활성'}{library.connections.some(current=>versionRef(current)===versionRef(item))?'':' · 보관된 버전'}</option>)}</select></label>
        {chosen&&<><p className="provider-selection-reference full">모델은 연결 v{chosen.revision}에 고정돼요. 준비 상태는 이 연결의 현재 서버 설정을 표시해요.</p>{!chosen.enabled&&<p className="provider-draft-note full">비활성 연결 버전으로 저장한 모델은 역할에서 새로 선택할 수 없어요. 연결을 활성화한 뒤 모델 편집에서 최신 연결 버전을 선택하고 저장해 주세요.</p>}{liveChosen&&liveChosen.revision!==chosen.revision&&<button type="button" className="secondary full" onClick={()=>chooseConnection(liveChosen)}>최신 연결 v{liveChosen.revision} 선택 · 모델 입력 옵션 초기화</button>}<ProviderReadiness key={versionRef(chosen)} connection={chosen} busy={busy} onCatalog={item=>{void perform(()=>catalog(item));}}/></>}
        <ProviderModelFields value={model} onChange={setModel} connection={chosen}/>
      </fieldset><div className="provider-actions full"><button disabled={busy||!chosen}>{editingModel?'모델 변경 저장':'모델 프리셋 등록'}</button>{(editingModel||modelCopy)&&<button type="button" className="secondary" disabled={busy} onClick={newModel}>모델 편집 끝내기</button>}</div>
    </form>
    {error&&<p className="error" role="alert">{error}</p>}<p role="status">{message}</p>
    {registeredModel&&<section className="provider-next-step" aria-label="등록한 모델 사용 방법"><strong>{registeredModel.title} · 다음으로 역할에 배정하세요</strong><p>비활성 연결로 등록했다면 연결을 활성화한 뒤 모델 편집에서 최신 연결 버전을 선택하고 저장해 주세요.</p><ol><li>설정 창을 닫고 새 이야기에서 본문·번역 모델을 선택해요.</li><li>기존 이야기는 이야기 설정 → 모델에서 필요한 역할을 선택하고 저장해요. 상태·기억은 이야기 설정의 해당 작업 설정에서 선택해요.</li></ol><small>{registeredModel.enabled===false?'지금은 새 선택에서 제외된 모델이에요. 활성화한 뒤 새로 배정할 수 있어요.':'역할 선택 전에는 기존 이야기의 모델을 바꾸지 않아요.'}</small></section>}
    <ProviderRegistrationAssistant library={library} reload={reload} onError={onError}/>
  </section>;
}
