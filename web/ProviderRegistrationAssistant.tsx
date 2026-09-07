import { useEffect, useRef, useState } from 'react';
import type { Library } from '../core/product.js';
import { REGISTRATION_LIMITS, type RegistrationView } from '../core/provider-registration.js';
import { providerDefinition } from '../core/provider-definitions.js';
import { useModelSelection } from './model-selection.js';
import { api, ApiError } from './api.js';

const storageKey='uimori.provider-registration.request-key';
const label=(value:{id:string;revision:number})=>`${value.id}@${value.revision}`;
const errors:Record<string,string>={
  PROPOSAL_STALE:'연결 설정이 바뀌었어요. 현재 설정으로 새 제안을 요청해 주세요.',
  REGISTRATION_PROPOSAL_INVALID:'등록 가능한 설정안을 만들지 못했어요. 프로토콜과 모델 ID를 구체적으로 적거나 수동으로 등록해 주세요.',
  SERVER_INTERRUPTED_NO_AUTOMATIC_REPLAY:'서버가 중단되어 요청을 다시 실행하지 않았어요. 필요하면 새 제안을 명시적으로 요청해 주세요.',
};
const optionLabels:Record<string,string>={title:'프리셋 이름',modelId:'모델 ID',maxOutputTokens:'최대 출력 토큰',temperature:'Temperature',timeoutMs:'제한 시간(ms)',thinkingLevel:'생각 수준',structuredOutput:'구조화 출력',reasoningEffort:'Reasoning effort',thinkingMode:'Thinking',thinkingBudgetTokens:'Thinking 토큰',evaluationTools:'선택형 평가 도구',enabled:'새 선택에 표시'};

/** Agent registration uses an explicitly chosen model; only the reviewed proposal can create settings. */
export function ProviderRegistrationAssistant({library,reload,onError}:{library:Library;reload:()=>Promise<void>;onError:(error:string)=>void}) {
  const {choices}=useModelSelection(library.models,library.connections);
  const [target,setTarget]=useState(''),[request,setRequest]=useState(''),[run,setRun]=useState<RegistrationView>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[restoring,setRestoring]=useState(true);
  const pendingKey=useRef<string|undefined>(undefined),pendingIntent=useRef(''),locked=useRef(false),epoch=useRef(0);
  const running=run?.status==='running';
  useEffect(()=>{
    let alive=true;const key=sessionStorage.getItem(storageKey);
    if(!key){setRestoring(false);return;}
    pendingKey.current=key;
    void api<RegistrationView>(`/provider-management/registrations/by-key/${encodeURIComponent(key)}`).then(value=>{if(alive){setRun(value);setRequest(value.request);setTarget(label(value.target));pendingKey.current=undefined;}}).catch(caught=>{if(alive){if(caught instanceof ApiError&&caught.status===404){pendingKey.current=undefined;pendingIntent.current='';sessionStorage.removeItem(storageKey);setError('이전 요청이 등록되지 않았어요. 내용을 확인하고 새로 요청할 수 있어요.');}else setError('이전 요청 상태를 확인하지 못했어요. 상태를 다시 확인한 뒤 새 요청을 시작해 주세요.');}}).finally(()=>{if(alive)setRestoring(false);});
    return()=>{alive=false;epoch.current++;};
  },[]);
  useEffect(()=>{
    if(!run||run.status!=='running')return;
    let alive=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{const value=await api<RegistrationView>(`/provider-management/registrations/${run.id}`);if(alive){setRun(value);setError('');if(value.status==='running')timer=setTimeout(()=>{void poll();},1000);}}
      catch{if(alive)setError('요청 상태를 읽지 못했어요. 서버의 요청은 계속될 수 있어요. 상태를 다시 확인해 주세요.');}
    };
    timer=setTimeout(()=>{void poll();},750);return()=>{alive=false;if(timer)clearTimeout(timer);};
  },[run?.id,run?.status]);
  async function perform(work:()=>Promise<void>) {
    if(locked.current)return;locked.current=true;setBusy(true);setError('');onError('');
    try{await work();}catch(caught){const message=(caught as Error).message;setError(message);onError(message);}finally{locked.current=false;setBusy(false);}
  }
  async function refresh() {
    const key=sessionStorage.getItem(storageKey);if(!key)return;
    try{const value=await api<RegistrationView>(`/provider-management/registrations/by-key/${encodeURIComponent(key)}`);setRun(value);setRequest(value.request);setTarget(label(value.target));pendingKey.current=undefined;pendingIntent.current='';}
    catch(caught){if(caught instanceof ApiError&&caught.status===404){pendingKey.current=undefined;pendingIntent.current='';sessionStorage.removeItem(storageKey);}throw caught;}
  }
  async function submit() {
    const model=choices.find(item=>label(item)===target);if(!model)return;
    const intent=JSON.stringify({request,target:{id:model.id,revision:model.revision}});
    if(pendingKey.current&&pendingIntent.current&&pendingIntent.current!==intent)throw new Error('이전 요청 상태를 먼저 확인해 주세요.');
    const key=pendingKey.current??crypto.randomUUID();pendingKey.current=key;pendingIntent.current=intent;sessionStorage.setItem(storageKey,key);
    const scope=epoch.current;let value:RegistrationView;
    try{value=await api<RegistrationView>('/provider-management/registrations',{key,request,target:{id:model.id,revision:model.revision}});}
    catch(caught){if(caught instanceof ApiError&&[400,401,403,404,422].includes(caught.status)){pendingKey.current=undefined;pendingIntent.current='';sessionStorage.removeItem(storageKey);}throw caught;}
    if(scope!==epoch.current)return;setRun(value);pendingKey.current=undefined;pendingIntent.current='';
  }
  const proposal=run?.plan;
  const selectedId=proposal?.connection.kind==='existing'?proposal.connection.id:undefined;
  const selected=library.connections.find(item=>item.id===selectedId);
  const draft=proposal?.connection.kind==='new'?proposal.connection.draft:undefined;
  const ready=run?.status==='ready';
  return <details className="provider-registration-assistant full" data-testid="provider-registration-assistant"><summary>에이전트에게 모델 등록 요청하기</summary>
    <p>등록에 사용할 공급자·모델·옵션을 적으면 선택한 모델 또는 Codex 에이전트가 설정안을 제안해요. 내용을 검토한 뒤 적용할 수 있어요.</p>
    <p className="muted">선택한 보조 모델에 요청 내용과 연결·모델 목록의 이름·ID·프로토콜을 보내요. 이야기 본문과 인증 값은 보내지 않아요. 요청당 실행 요청은 최대 {REGISTRATION_LIMITS.maxCalls}회예요. API 비용 또는 Codex 구독 한도를 사용하며, Codex 내부 모델 호출 횟수는 별도예요.</p>
    <form className="editor-grid" onSubmit={event=>{event.preventDefault();void perform(submit);}}>
      <fieldset className="editor-fields full" disabled={busy||running||restoring}>
        <label className="full">등록을 도울 모델<select aria-label="등록을 도울 모델" required value={target} onChange={event=>setTarget(event.target.value)}><option value="">저장한 모델 선택</option>{target&&!choices.some(item=>label(item)===target)&&<option value={target} disabled>이전 요청 모델 · 새 요청에 사용 불가</option>}{choices.map(model=><option key={label(model)} value={label(model)}>{model.title} · {model.modelId}</option>)}</select></label>
        <label className="full">등록 요청<textarea aria-label="등록 요청" required maxLength={REGISTRATION_LIMITS.requestCharacters} rows={4} value={request} placeholder="예: OpenAI 연결에 모델 ID example-model을 등록하고 최대 출력은 8192로 설정해 줘. API 키는 적지 마세요." onChange={event=>setRequest(event.target.value)}/></label>
        <small className="full">새 API 형식을 설치하거나 모델의 실제 기능·가격을 확인하는 기능은 아니에요. 선택한 프리셋에 평가 도구가 켜져 있어도 이 등록 요청은 설정 제안 도구만 사용해요.</small>
      </fieldset>
      <button disabled={busy||running||restoring||!choices.some(item=>label(item)===target)||!request.trim()}>{pendingKey.current?'동일 요청 상태 확인':'설정안 제안 요청'}</button>
    </form>
    {!choices.length&&<p>먼저 위에서 연결과 보조용 모델을 하나 저장해 주세요. 수동 등록은 보조 모델 없이 사용할 수 있어요.</p>}
    {run&&<section aria-label="모델 등록 제안" className="compact-card">
      <strong>{running?'설정안을 작성하고 있어요…':ready?'적용 전 설정안을 검토하세요':run.status==='applied'?'등록을 적용했어요':run.status==='cancelled'?'요청을 취소했어요':'설정안 작성이 완료되지 않았어요'}</strong>
      <small>원래 요청: {run.request}</small>
      <small>실행 요청 {run.modelCalls}회{run.usage?` · 입력 ${run.usage.inputTokens??'미확인'} / 출력 ${run.usage.outputTokens??'미확인'} 토큰 · 실제 금액 ${run.usage.costUsd===null?'미확인':run.usage.costUsd+' USD'}`:''}</small>
      {run.error&&<p role="status">{errors[run.error]??'설정안을 채택하지 않았어요. 조건을 확인하고 새 요청 또는 수동 등록을 이용해 주세요.'}<small>{run.error}</small></p>}
      {proposal&&<>
        <h4>{draft?'새 연결 · 비활성 상태로 등록':'기존 연결 사용'}</h4>
        <dl><dt>연결</dt><dd>{draft?.title??selected?.title??(proposal.connection.kind==='existing'?proposal.connection.id:'')}</dd>
          {draft?<><dt>프로토콜</dt><dd>{providerDefinition(draft.protocol).label}</dd><dt>기본 주소</dt><dd><code>{draft.endpoint}</code></dd><dt>인증 참조</dt><dd>{draft.credentialEnv??'서버 기본 설정 / 인증 없음'}</dd>{draft.requestTier&&<><dt>요금제</dt><dd>{draft.requestTier}</dd></>}</>:proposal.connection.kind==='existing'&&<><dt>연결 버전</dt><dd>{proposal.connection.revision}</dd></>}
        </dl>
        <h4>새 모델 프리셋</h4><dl>{Object.entries(proposal.model).map(([key,value])=><div key={key}><dt>{key==='maxOutputTokens'&&(draft?.protocol??selected?.protocol)==='codex-app-server-v1'?'출력 목표 토큰':optionLabels[key]??key}</dt><dd>{value===null?'공급자 기본값':typeof value==='object'?JSON.stringify(value):String(value)}</dd></div>)}</dl>
        <p>기존 채팅의 모델과 과거 실행은 바꾸지 않아요. 새 모델 ID가 현재 프로토콜에서 작동하는지, 옵션과 가격이 맞는지는 미확인이에요.{draft?' 새 연결의 서버 인증과 허용 주소를 준비한 뒤 직접 활성화해 주세요. 모델 편집에서 활성화된 최신 연결 버전을 선택하고 저장하면 역할에 배정할 수 있어요.':''}</p>
        {ready&&<button type="button" disabled={busy} onClick={()=>{void perform(async()=>{const value=await api<RegistrationView>(`/provider-management/registrations/${run.id}/apply`,{expectedRevision:run.revision,planHash:run.planHash});setRun(value);await reload();});}}>검토한 연결·모델 등록 적용</button>}
        {run.status==='applied'&&<p role="status">설정 목록에 저장했어요. 새 이야기 또는 이야기 설정의 모델 탭에서 사용할 역할에 배정해 주세요.</p>}
      </>}
    </section>}
    <div className="provider-actions">{sessionStorage.getItem(storageKey)&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void perform(refresh);}}>등록 요청 상태 다시 확인</button>}{running&&<button type="button" className="secondary" disabled={busy} onClick={()=>{void perform(async()=>{await api(`/provider-management/registrations/${run.id}/cancel`,{});await refresh();});}}>설정안 요청 취소</button>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
  </details>;
}
