import { useEffect, useRef, useState } from 'react';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { api } from './api.js';

export function PackageTransfer({getPackage,onPrepared,onError,disabled=false}:{getPackage:()=>ContentPackage;onPrepared:(pkg:ContentPackage)=>void;onError:(message:string)=>void;disabled?:boolean}) {
  const [busy,setBusy]=useState(false);const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  async function save() {
    const current=++generation.current;setBusy(true);
    try {
      const pkg=getPackage();const data=pkg.images?.length?await api('/package-bundles/export',{package:pkg}):pkg;
      if(current!==generation.current)return;
      const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      link.href=url;link.download=`${pkg.title||'package'}.uimori.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){if(current===generation.current)onError((error as Error).message);}finally{if(current===generation.current)setBusy(false);}
  }
  async function load(file:File) {
    const current=++generation.current;setBusy(true);
    try {
      if(file.size>64*1024*1024)throw new Error('이미지 포함 패키지 파일은 64 MB 이하여야 해요.');
      const parsed=JSON.parse(await file.text());if(current!==generation.current)return;
      const pkg=parsed.format==='uimori-package-bundle'?(await api<{package:ContentPackage}>('/package-bundles/prepare',parsed)).package:validateContentPackage(parsed.package??parsed);
      if(current===generation.current)onPrepared(pkg);
    }catch(error){if(current===generation.current)onError((error as Error).message);}finally{if(current===generation.current)setBusy(false);}
  }
  return <div className="library-package-transfer">
    <section className="library-transfer-card"><h3>파일로 내보내기</h3><p className="muted">현재 초안과 이미지 파일을 함께 보관해요. 연결한 모듈과 히든 스토리 자료는 가져올 서재에도 같은 개정이 있어야 해요.</p><button type="button" className="secondary" disabled={disabled||busy} onClick={()=>void save()}>패키지 JSON 내보내기</button></section>
    <section className="library-transfer-card"><h3>파일에서 가져오기</h3><p className="muted">내용을 확인한 뒤 현재 초안에 적용해요.</p><label><span className="sr-only">패키지 JSON 가져오기</span><input type="file" aria-label="패키지 JSON 가져오기" disabled={disabled||busy} accept=".json,application/json" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void load(file);}}/></label></section>
    {busy&&<p role="status">패키지 파일을 준비하고 있어요…</p>}
  </div>;
}
