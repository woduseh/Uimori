import { useEffect, useRef, useState } from 'react';
import { FileKey, Upload } from 'lucide-react';
import { api, ApiError } from './api.js';

type RegisteredCredential = { credentialEnv: string; projectId: string; clientEmail: string };
export function VertexCredentialUpload({credentialEnv,disabled,onRegistered,onBusy}:{credentialEnv:string;disabled:boolean;onRegistered:(credential:RegisteredCredential)=>void;onBusy:(value:boolean)=>void}) {
  const [uploading,setUploading]=useState(false),[error,setError]=useState('');
  const [registered,setRegistered]=useState<RegisteredCredential>();
  const epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[]);
  const stored=credentialEnv.startsWith('NARRATIVE_PROVIDER_VERTEX_FILE_');
  return <section className="vertex-credential-upload full" aria-label="Vertex 서비스 계정 JSON">
    <div className="provider-section-heading"><strong><FileKey size={18} aria-hidden="true"/>서비스 계정 JSON</strong><span className="provider-status">{stored?'JSON 인증 선택됨':'파일로 간편 등록'}</span></div>
    <p>Google Cloud에서 발급한 서비스 계정 키 파일을 선택해요. 프로젝트 ID와 인증 설정을 자동으로 채워요.</p>
    <label className="vertex-upload-field"><span><Upload size={16} aria-hidden="true"/>{uploading?'서버에 등록하는 중…':stored?'다른 JSON 파일로 변경':'Vertex 키 JSON 파일 선택'}</span><input type="file" aria-label="Vertex 키 JSON 파일" accept=".json,application/json" disabled={disabled||uploading} onChange={async event=>{
      const file=event.target.files?.[0];event.target.value='';if(!file)return;
      setError('');
      if(file.size>64*1024){setError('64 KB 이하의 서비스 계정 JSON 파일을 선택해 주세요.');return;}
      const current=++epoch.current;setUploading(true);onBusy(true);
      try {
        let serviceAccount:unknown;
        try{serviceAccount=JSON.parse(await file.text());}catch{throw new Error('서비스 계정 JSON 파일을 읽을 수 없어요. 파일 형식을 확인해 주세요.');}
        if(!serviceAccount||typeof serviceAccount!=='object'||Array.isArray(serviceAccount)||(serviceAccount as Record<string,unknown>).type!=='service_account')throw new Error('type이 service_account인 Google Cloud 키 JSON 파일을 선택해 주세요.');
        const value=await api<RegisteredCredential>('/provider-management/vertex-credentials',{serviceAccount});
        if(current!==epoch.current)return;
        setRegistered(value);onRegistered(value);
      } catch(caught){if(current===epoch.current)setError(caught instanceof ApiError&&caught.status===400?'유효한 Google Cloud 서비스 계정 키 파일인지 확인해 주세요. 프로젝트·이메일·개인 키 정보가 필요해요.':caught instanceof Error?caught.message:'키 파일을 등록하지 못했어요.');}
      finally{if(current===epoch.current){setUploading(false);onBusy(false);}}
    }}/></label>
    {stored&&registered?.credentialEnv===credentialEnv&&<p role="status">등록됨 · {registered.projectId}<br/><small>{registered.clientEmail}</small></p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <small>키 파일은 서버에 보관돼요. 등록만으로 Google에 요청하지 않으며, 저장된 키 원문은 다시 표시하거나 일반 백업에 포함하지 않아요.</small>
  </section>;
}
