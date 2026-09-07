import { useEffect, useState } from 'react';
import type { ProviderProtocol } from '../core/product.js';
import { api } from './api.js';

type Status = { status: 'official' | 'configured' | 'needs-approval' | 'invalid' | 'local'; origin: string | null };

/** Checks server policy only; changing a draft never contacts a provider. */
export function ProviderEndpointStatus({protocol,endpoint}:{protocol:ProviderProtocol;endpoint:string}) {
  const key=JSON.stringify([protocol,endpoint]);
  const [state,setState]=useState<{key:string;value?:Status;error?:boolean}>();
  useEffect(()=>{
    if(!endpoint.trim()||protocol==='codex-app-server-v1')return;
    let current=true;
    const timer=setTimeout(()=>{
      void api<Status>('/provider-management/endpoint-status',{protocol,endpoint})
        .then(value=>{if(current)setState({key,value});})
        .catch(()=>{if(current)setState({key,error:true});});
    },200);
    return()=>{current=false;clearTimeout(timer);};
  },[protocol,endpoint,key]);
  if(!endpoint.trim()||protocol==='codex-app-server-v1')return null;
  const value=state?.key===key?state.value:undefined;
  return <div className="provider-draft-note full" role="status" aria-label="연결 주소 확인">
    {value?.status==='official'?<p>공식 공급자 주소예요. 별도 주소 허용 설정 없이 사용할 수 있어요.</p>
      :value?.status==='configured'?<p>서버에서 허용한 사용자 지정 주소예요.</p>
      :value?.status==='needs-approval'?<><p>사용자 지정 주소는 서버에서 한 번 허용해야 해요. 연결 초안은 저장할 수 있어요.</p><p><code>NR_PROVIDER_ORIGINS</code>에 <code>{value.origin}</code>을 추가하고 서버를 다시 시작해 주세요. 기존 주소가 있다면 쉼표로 구분해 추가해요.</p><small>Windows 사용자 환경변수나 서버 실행 설정에 저장하면 매번 입력하지 않아도 돼요.</small></>
      :value?.status==='invalid'?<p>이 연결 방식에 맞는 API 기본 주소를 입력해 주세요. 사용자명·비밀번호·쿼리·#fragment는 포함할 수 없어요.{protocol==='vertex-gemini-v1'&&' Gemini는 global 주소를 지원해요.'}</p>
      :state?.key===key&&state.error?<p>주소 허용 상태를 확인하지 못했어요. 입력한 초안은 유지돼요.</p>
      :<p>주소 허용 상태를 확인하고 있어요…</p>}
  </div>;
}
