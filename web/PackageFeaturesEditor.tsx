import { useEffect, useRef, useState } from 'react';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import type { Content, Library } from '../core/product.js';
import type { PackageModuleRef } from '../core/package-features.js';
import { defaultHiddenStoryConfig, hiddenConfigIssues, validateHiddenStoryConfig, type HiddenStoryConfig } from '../core/hidden-story.js';
import { validateHiddenConversion, type HiddenStoryNativePackage } from '../core/hidden-story-package.js';
import { resolvePromptValues } from '../core/prompt-program.js';
import { api } from './api.js';
import './package-authoring.css';

const referenceKey=(ref:PackageModuleRef|null|undefined)=>ref?`${ref.id}@${ref.revision}`:'';
type ReferenceStatus={title?:string;error?:string};

/** Preserve authored controls on explicit reuse; native schemas still bound their values. */
export function connectPackageHiddenStory(value:ContentPackage,module:HiddenStoryNativePackage,contentPolicy:HiddenStoryConfig['contentPolicy'],reuseControls=false):ContentPackage {
  const duplicates=module.program.controls.filter(control=>value.controls.some(existing=>existing.id===control.id));
  if(duplicates.length&&!reuseControls)throw new Error(`이미 있는 옵션 ID를 확인해 주세요: ${duplicates.map(control=>control.id).join(', ')}`);
  const config=defaultHiddenStoryConfig(contentPolicy),controls=[...value.controls];
  for(const expected of module.program.controls) {
    const existing=value.controls.find(control=>control.id===expected.id);
    if(existing) {
      if(existing.type!==expected.type||existing.type==='select'&&existing.options?.some(option=>!expected.options?.some(allowed=>allowed.value===option.value)))throw new Error(`히든 스토리 옵션 형식이 호환되지 않아요: ${expected.id}`);
      resolvePromptValues({version:1,blocks:[],controls:[expected]},{[expected.id]:existing.default});
      config.values[expected.id as keyof typeof config.values]=existing.default;
    }else controls.push({...structuredClone(expected),default:config.values[expected.id as keyof typeof config.values],group:'히든 스토리'});
  }
  return validateContentPackage({...value,controls,hiddenStory:{module:{id:module.id,revision:module.revision},config:validateHiddenStoryConfig(config),insertion:value.hiddenStory?.insertion??'before-current'}});
}

export function PackageFeaturesEditor({value,onChange,onDirtyChange}:{value:ContentPackage;onChange:(value:ContentPackage)=>void;onDirtyChange?:(dirty:boolean)=>void}) {
  const [library,setLibrary]=useState<Content[]>([]),[hiddenModules,setHiddenModules]=useState<HiddenStoryNativePackage[]>([]),[statuses,setStatuses]=useState<Record<string,ReferenceStatus>>({});
  const [selected,setSelected]=useState(''),[selectedHidden,setSelectedHidden]=useState(referenceKey(value.hiddenStory?.module)),[policy,setPolicy]=useState<HiddenStoryConfig['contentPolicy']>(value.hiddenStory?.config.contentPolicy??'general-fiction');
  const [revisionDrafts,setRevisionDrafts]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmRemove,setConfirmRemove]=useState(false),[reload,setReload]=useState(0);
  const latest=useRef({value,onChange});latest.current={value,onChange};
  const actionVersion=useRef(0),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;actionVersion.current++;};},[]);
  const refsKey=JSON.stringify(value.modules??[]),hiddenKey=referenceKey(value.hiddenStory?.module);
  useEffect(()=>{setSelectedHidden(hiddenKey);setPolicy(value.hiddenStory?.config.contentPolicy??'general-fiction');setConfirmRemove(false);},[value.id,hiddenKey]);
  useEffect(()=>{actionVersion.current++;setBusy(false);setRevisionDrafts({});setSelected('');},[value.id]);
  useEffect(()=>{onDirtyChange?.(Object.keys(revisionDrafts).length>0||busy);},[revisionDrafts,busy,onDirtyChange]);
  useEffect(()=>{
    let active=true;setLoading(true);
    Promise.allSettled([api<Library>('/library?view=summary'),api<HiddenStoryNativePackage[]>('/hidden-story/modules')]).then(results=>{
      if(!active)return;const [contents,modules]=results;
      if(contents.status==='fulfilled')setLibrary(contents.value.contents.filter(content=>content.id!==value.id&&(content.hasPackage||content.package)));
      if(modules.status==='fulfilled')setHiddenModules(current=>[...modules.value,...current.filter(item=>!modules.value.some(module=>referenceKey(module)===referenceKey(item)))]);
      if(results.some(result=>result.status==='rejected'))setError('자료 또는 히든 스토리 목록을 불러오지 못했어요. 다시 조회해 주세요.');
    }).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[value.id,reload]);
  useEffect(()=>{
    let active=true;const refs=value.modules??[];
    Promise.all(refs.map(async ref=>{try{const content=await api<Content>(`/revisions/content/${encodeURIComponent(ref.id)}/${ref.revision}`);return[referenceKey(ref),content.package?{title:content.title}:{error:'고정 버전이 공통 패키지가 아니에요.'}] as const;}catch{return[referenceKey(ref),{error:'고정한 자료 버전을 찾거나 읽을 수 없어요.'}] as const;}})).then(items=>{if(active)setStatuses(current=>({...Object.fromEntries(items),...(current[`hidden:${hiddenKey}`]?{[`hidden:${hiddenKey}`]:current[`hidden:${hiddenKey}`]}:{})}));});
    const ref=value.hiddenStory?.module;
    if(ref)api<HiddenStoryNativePackage>(`/hidden-story/modules/${encodeURIComponent(ref.id)}?revision=${ref.revision}`).then(module=>{if(active){setHiddenModules(current=>current.some(item=>referenceKey(item)===referenceKey(module))?current:[...current,module]);setStatuses(current=>({...current,[`hidden:${referenceKey(ref)}`]:{title:module.title}}));}}).catch(()=>{if(active)setStatuses(current=>({...current,[`hidden:${referenceKey(ref)}`]:{error:'고정한 히든 스토리 버전을 찾거나 읽을 수 없어요.'}}));});
    return()=>{active=false;};
  },[value.id,refsKey,hiddenKey,reload]);

  const currentAction=(request:number,id:string)=>alive.current&&actionVersion.current===request&&latest.current.value.id===id;
  async function act(work:(request:number,id:string)=>Promise<void>){if(busy)return;const request=++actionVersion.current,id=value.id;setBusy(true);setError('');setNotice('');try{await work(request,id);}catch(caught){if(currentAction(request,id))setError((caught as Error).message);}finally{if(currentAction(request,id))setBusy(false);}}
  function update(part:Partial<ContentPackage>):boolean{try{latest.current.onChange(validateContentPackage({...latest.current.value,...part}));setError('');setNotice('자료 초안에 반영했어요. 자료를 저장하면 새 버전으로 고정돼요.');return true;}catch(caught){setError((caught as Error).message);return false;}}
  async function addModule(){const item=library.find(content=>referenceKey(content)===selected);if(!item)return;await act(async(request,id)=>{
    const content=await api<Content>(`/revisions/content/${encodeURIComponent(item.id)}/${item.revision}`);if(!currentAction(request,id))return;
    if(!content.package)throw new Error('공통 패키지인 자료만 연결할 수 있어요.');const current=latest.current.value;
    if(content.id===current.id||current.modules?.some(ref=>ref.id===content.id))throw new Error('자기 자신이나 이미 연결한 자료는 추가할 수 없어요.');
    if(update({modules:[...current.modules??[],{id:content.id,revision:content.revision}]}))setSelected('');
  });}
  async function applyRevision(ref:PackageModuleRef){const text=revisionDrafts[ref.id],revision=Number(text);if(!text?.trim()||!Number.isSafeInteger(revision)||revision<1){setError('1 이상의 버전 번호를 입력해 주세요.');return;}await act(async(request,id)=>{
    const content=await api<Content>(`/revisions/content/${encodeURIComponent(ref.id)}/${revision}`);if(!currentAction(request,id))return;
    if(!content.package)throw new Error('공통 패키지인 자료 버전만 연결할 수 있어요.');
    if(!latest.current.value.modules?.some(item=>referenceKey(item)===referenceKey(ref)))return;
    if(update({modules:latest.current.value.modules.map(item=>item.id===ref.id?{id:ref.id,revision}:item)}))setRevisionDrafts(current=>{const next={...current};delete next[ref.id];return next;});
  });}
  const selectedNative=hiddenModules.find(module=>referenceKey(module)===selectedHidden),linkedNative=hiddenModules.find(module=>referenceKey(module)===hiddenKey);
  const duplicates=selectedNative?.program.controls.filter(control=>value.controls.some(existing=>existing.id===control.id))??[];
  function connect(reuseControls:boolean){if(!selectedNative)return;try{const next=connectPackageHiddenStory(latest.current.value,selectedNative,policy,reuseControls);latest.current.onChange(next);setError('');setNotice(reuseControls?'기존 옵션을 유지하고 히든 스토리를 연결했어요. 자료를 저장해 주세요.':'히든 스토리와 공통 옵션을 초안에 추가했어요. 자료를 저장해 주세요.');}catch(caught){setError((caught as Error).message);}}
  function importModule(file:File){void act(async(request,id)=>{if(file.size>1_000_000)throw new Error('1 MB 이하의 네이티브 JSON을 선택해 주세요.');const conversion=validateHiddenConversion(JSON.parse(await file.text()));if(!currentAction(request,id))return;const module=await api<HiddenStoryNativePackage>('/hidden-story/modules',{title:conversion.source.name||file.name,conversion});if(!currentAction(request,id))return;setHiddenModules(current=>[...current.filter(item=>referenceKey(item)!==referenceKey(module)),module]);setSelectedHidden(referenceKey(module));setNotice('로컬 모듈을 가져왔어요. 연결 버튼으로 이 자료 초안에 추가해 주세요.');});}
  let issues:string[]=[];if(value.hiddenStory){try{issues=hiddenConfigIssues(value.hiddenStory.config);}catch(caught){issues=[(caught as Error).message];}}
  return <div className="package-stack package-authoring-editor" aria-label="패키지 모듈과 기능 편집">
    <section className="package-stack"><h3>함께 사용하는 모듈</h3><p className="muted">이 자료를 장착하면 아래 모듈을 함께 사용해요. 여러 자료가 같은 모듈을 요구해도 한 번만 포함하며 채팅별 선택값을 사용해요.</p>
      {(value.modules??[]).map(ref=>{const status=statuses[referenceKey(ref)],draft=revisionDrafts[ref.id];return <fieldset className="package-entry" key={ref.id}><legend>{status?.title??library.find(content=>content.id===ref.id)?.title??ref.id}</legend><small>{ref.id} · 고정 버전 v{ref.revision}</small>{status?.error&&<p className="error" role="alert">{status.error} 참조를 해제하거나 읽을 수 있는 버전으로 바꿔 주세요.</p>}<label>고정 버전<input aria-label={`${ref.id} 고정 버전`} type="number" min={1} disabled={busy} value={draft??String(ref.revision)} onChange={event=>setRevisionDrafts(current=>{const next={...current};if(event.target.value===String(ref.revision))delete next[ref.id];else next[ref.id]=event.target.value;return next;})}/></label><div className="package-role-actions"><button type="button" className="secondary" disabled={draft===undefined||busy} onClick={()=>void applyRevision(ref)}>버전 확인 후 적용</button><button type="button" className="ghost" disabled={draft===undefined||busy} onClick={()=>setRevisionDrafts(current=>{const next={...current};delete next[ref.id];return next;})}>버전 초안 되돌리기</button><button type="button" className="ghost" disabled={busy} onClick={()=>{if(update({modules:value.modules?.filter(item=>item.id!==ref.id)}))setRevisionDrafts(current=>{const next={...current};delete next[ref.id];return next;});}}>모듈 참조 해제</button></div></fieldset>;})}
      <label>연결할 공통 자료<select aria-label="연결할 공통 모듈" disabled={busy||loading} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">자료 선택</option>{library.filter(content=>!value.modules?.some(ref=>ref.id===content.id)).map(content=><option key={referenceKey(content)} value={referenceKey(content)}>{content.title} · v{content.revision}</option>)}</select></label><button type="button" className="secondary" disabled={!selected||busy} onClick={()=>void addModule()}>필수 모듈 연결</button><small>선택한 버전을 고정해요. 서재에서 모듈을 수정해도 연결한 버전은 자동으로 바뀌지 않아요.</small>
    </section>
    <section className="package-stack"><h3>히든 스토리 기능</h3><p className="muted">기존 네이티브 히든 스토리 기능을 이 자료에 연결해요. 생성·읽기 화면의 펼침·다음 요청 제외 옵션을 각각 설정할 수 있어요.</p>
      {value.hiddenStory&&<div className="package-entry"><strong>연결됨 · {linkedNative?.title??statuses[`hidden:${hiddenKey}`]?.title??value.hiddenStory.module.id} · v{value.hiddenStory.module.revision}</strong>{statuses[`hidden:${hiddenKey}`]?.error&&<p className="error" role="alert">{statuses[`hidden:${hiddenKey}`].error}</p>}<p className="muted">옵션 탭의 히든 스토리 그룹에서 기본값을 편집해요. 채팅에서는 같은 옵션에 채팅별 값을 저장할 수 있어요.</p><label>요청 안의 삽입 위치<select aria-label="패키지 히든 스토리 삽입 위치" disabled={busy} value={value.hiddenStory.insertion??'before-current'} onChange={event=>update({hiddenStory:{...value.hiddenStory!,insertion:event.target.value as 'before-current'|'before-history'}})}><option value="before-current">현재 요청 직전</option><option value="before-history">대화 기록 앞</option></select></label><button type="button" className="ghost" disabled={busy} onClick={()=>setConfirmRemove(true)}>히든 스토리 기능 해제</button>{confirmRemove&&<div className="package-stack" role="alert"><p>이 자료의 기능 연결을 해제해요. 등록한 옵션과 이미 생성한 장면의 표시 설정은 유지돼요.</p><div className="package-role-actions"><button type="button" className="secondary" onClick={()=>{if(update({hiddenStory:undefined})){setConfirmRemove(false);setNotice('기능 연결을 해제했어요. 남겨 둔 옵션은 다시 연결할 때 명시적으로 재사용할 수 있어요.');}}}>기능 연결 해제 확인</button><button type="button" className="ghost" onClick={()=>setConfirmRemove(false)}>계속 사용</button></div></div>}</div>}
      <label>네이티브 히든 스토리 모듈<select aria-label="패키지 히든 스토리 모듈" disabled={busy||loading} value={selectedHidden} onChange={event=>setSelectedHidden(event.target.value)}><option value="">모듈 선택</option>{selectedHidden&&!selectedNative&&<option value={selectedHidden}>보관된 선택 · {selectedHidden}</option>}{hiddenModules.map(module=><option key={referenceKey(module)} value={referenceKey(module)}>{module.title} · v{module.revision}</option>)}</select></label>
      <label>창작 범위<select aria-label="패키지 히든 스토리 창작 범위" disabled={busy} value={policy} onChange={event=>{const next=event.target.value as HiddenStoryConfig['contentPolicy'];if(!value.hiddenStory||update({hiddenStory:{...value.hiddenStory,config:{...value.hiddenStory.config,contentPolicy:next}}}))setPolicy(next);}}><option value="general-fiction">일반 창작</option><option value="nonsexual">비성적 창작</option></select></label>
      {duplicates.length>0?<div className="package-stack"><p className="muted">같은 ID의 옵션 {duplicates.length}개가 있어요. 호환되는 옵션의 기본값·이름·그룹·조건을 유지하고 연결할 수 있어요. 형식이나 선택값이 호환되지 않으면 먼저 옵션을 수정해 주세요.</p><button type="button" className="secondary" disabled={busy||!selectedNative} onClick={()=>connect(true)}>기존 옵션을 유지하고 연결</button></div>:<button type="button" className="secondary" disabled={busy||!selectedNative} onClick={()=>connect(false)}>히든 스토리와 옵션 연결</button>}
      <details><summary>로컬 네이티브 모듈 가져오기</summary><label>네이티브 JSON<input aria-label="패키지 히든 스토리 JSON 가져오기" type="file" accept="application/json,.json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)importModule(file);}}/></label><small>외부에서 준비한 Uimori 네이티브 JSON을 검증해 로컬 목록에 등록해요.</small></details>
      {issues.length>0&&<details><summary>변경·미지원 항목 {issues.length}개</summary><ul>{issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></details>}
    </section>
    {loading&&<p role="status">자료와 기능 목록을 확인하는 중이에요…</p>}{busy&&<p role="status">선택한 자료 버전을 확인하는 중이에요…</p>}
    <button type="button" className="secondary" disabled={busy||loading} onClick={()=>{setError('');setReload(current=>current+1);}}>자료와 기능 목록 새로고침</button>
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </div>;
}
