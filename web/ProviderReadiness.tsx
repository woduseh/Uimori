import { useEffect, useState } from 'react';
import type { Connection } from '../core/product.js';
import { api } from './api.js';

type Readiness = {enabled:boolean;originApproved:boolean;credentialStatus:'configured'|'missing'|'not-required'|'adc-configured'|'adc-unchecked';catalogKind:'remote'|'local-support'};
const credentials:Record<Readiness['credentialStatus'],string> = {configured:'인증 참조 설정됨',missing:'인증 참조 설정 필요','not-required':'인증 참조 불필요','adc-configured':'ADC 파일 설정됨','adc-unchecked':'서버 ADC 설정 확인 필요'};

/** Only server configuration is inspected here. This never probes a provider. */
export function ProviderReadiness({connection,onCatalog,busy}:{connection:Connection;onCatalog:(connection:Connection)=>void;busy:boolean}) {
  const [state,setState]=useState<{key:string;value?:Readiness;error?:string}>();
  const [refresh,setRefresh]=useState(0); const key=`${connection.id}@${connection.revision}`;
  useEffect(()=>{
    if(connection.protocol==='codex-app-server-v1')return;
    let current=true;
    setState({key});
    void api<Readiness>(`/provider-management/connections/${connection.id}/readiness`).then(value=>{if(current)setState({key,value});}).catch(()=>{if(current)setState({key,error:'준비 상태를 읽지 못했어요. 등록한 연결과 모델 ID는 유지돼요.'});});
    return ()=>{current=false;};
  },[connection.id,connection.revision,connection.protocol,key,refresh]);
  const value=state?.key===key?state.value:undefined;
  const prepared=value?.enabled&&value.originApproved&&['configured','not-required','adc-configured'].includes(value.credentialStatus);
  if(connection.protocol==='codex-app-server-v1')return <section className="provider-readiness full" aria-label="선택한 연결 준비 상태">
    <strong>{connection.title} · Codex 연결</strong>
    <p>{connection.enabled?'연결 사용 허용':'연결 비활성'} · Uimori 서버에서 실행해요.</p>
    <p>설정 → 에이전트에서 Codex 로그인과 구독 한도를 확인해 주세요. 준비 상태 확인 자체는 실제 모델을 호출하지 않아요.</p>
    {connection.catalogError&&<p className="error">모델 목록 조회 실패 · 마지막 저장 목록과 수동 입력을 사용할 수 있어요.</p>}
    <div className="provider-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>onCatalog(connection)}>모델 목록 새로고침</button><small>로그인한 공식 Codex 실행기에 사용 가능한 모델 목록을 요청해요.</small></div>
  </section>;
  return <section className="provider-readiness full" aria-label="선택한 연결 준비 상태">
    <div className="provider-section-heading"><strong>{connection.title} · 준비 상태</strong><button type="button" className="secondary" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>준비 상태 다시 확인</button></div>
    {state?.key===key&&state.error?<p className="error" role="status">{state.error}</p>:!value?<p role="status">서버 설정을 확인하고 있어요…</p>:<>
      <p>{prepared?'서버 설정 준비됨':'사용 전 설정 확인이 필요해요'}</p>
      <ul><li>{value.enabled?'연결 사용 허용':'연결 비활성'}</li><li>{value.originApproved?'서버에서 주소 허용됨':'서버의 NR_PROVIDER_ORIGINS에서 주소 허용 필요'}</li><li>{credentials[value.credentialStatus]}</li></ul>
      <small>현재 서버 설정을 확인했어요. 실제 공급자 인증과 모델 응답은 응답 테스트로 확인해 주세요.</small>
    </>}
    {connection.catalogError&&<p className="error">모델 목록 조회 실패 · 마지막 저장 목록과 수동 입력을 사용할 수 있어요.</p>}
    <div className="provider-actions"><button type="button" className="secondary" disabled={busy} onClick={()=>onCatalog(connection)}>{connection.protocol==='vertex-gemini-v1'?'로컬 지원 모델 확인':'모델 목록 새로고침'}</button><small>{connection.protocol==='vertex-gemini-v1'?'로컬 지원 목록만 확인해요.':'누르면 이 연결의 공급자에 모델 목록을 요청해요. 수동 ID 입력도 가능해요.'}</small></div>
  </section>;
}
