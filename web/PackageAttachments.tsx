import { useEffect, useState } from 'react';
import type { ChatProfile, Content, Library } from '../core/product.js';
import type { PackageAttachment, PackageRole } from '../core/content-package.js';
import { api } from './api.js';
import { refValue } from './LibraryPanel.js';
import { isPackageContent } from './PackageFields.js';
const keyOf=(r:PackageAttachment)=>`${r.id}@${r.revision}:${r.role}`;

export function PackageAttachments({profile,library,onChange,onError,ownerBotId}:{profile:ChatProfile;library:Library;onChange:(p:ChatProfile)=>void;onError:(s:string)=>void;ownerBotId?:string}){
  const [full,setFull]=useState<Content[]>([]);const [selected,setSelected]=useState('');const [role,setRole]=useState<PackageRole>('module');const [busy,setBusy]=useState(false);
  const attachments=profile.packageAttachments??[];
  useEffect(()=>{let active=true;setBusy(true);Promise.all(attachments.map(r=>api<Content>(`/revisions/content/${r.id}/${r.revision}`))).then(values=>{if(active)setFull(values);}).catch(e=>{if(active)onError(e.message);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[profile.packageAttachments,profile.chatId]);
  function changeAttachments(next:PackageAttachment[]){const keys=new Set(next.map(keyOf));onChange({...profile,packageAttachments:next,packageValues:Object.fromEntries(Object.entries(profile.packageValues??{}).filter(([key])=>keys.has(key)))});}
  async function add(){
    const item=library.contents.find(x=>refValue(x)===selected);if(!item)return;setBusy(true);
    try{const content=item.package?item:await api<Content>(`/revisions/content/${item.id}/${item.revision}`);if(!content.package)throw new Error('자료 설정에서 공통 패키지로 확장한 뒤 장착할 수 있어요.');
      const ref={id:content.id,revision:content.revision,role};
      if(role==='bot'&&ownerBotId&&ownerBotId!=='__legacy__'&&ownerBotId!==ref.id)throw new Error('채팅의 소속 봇은 바꿀 수 없어요.');
      const next=attachments.filter(r=>!(r.id===ref.id&&r.role===ref.role)&&(role==='module'||r.role!==role));
      const legacy=role==='persona'?profile.attachments.filter(r=>!library.contents.some(c=>c.id===r.id&&c.kind==='persona')):profile.attachments;
      const keys=new Set([...next,ref].map(keyOf));
      onChange({...profile,attachments:legacy,packageAttachments:[...next,ref],packageValues:Object.fromEntries(Object.entries(profile.packageValues??{}).filter(([k])=>keys.has(k)))});setSelected('');
    }catch(e){onError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="package-attachments" aria-label="장착 패키지">
    {busy&&<p role="status">패키지 내용을 확인하는 중이에요…</p>}
    {attachments.map(r=>{const content=full.find(c=>c.id===r.id&&c.revision===r.revision);const pkg=content?.package;const scope=keyOf(r);return <article className="package-attachment" key={scope}>
      <header><div><small>{r.role==='bot'?'소속 봇 · 고정':r.role==='persona'?'내 페르소나':'추가 모듈'}</small><h3>{content?.title??library.contents.find(c=>c.id===r.id)?.title??'보관된 패키지'}</h3></div>{r.role!=='bot'&&<button type="button" className="ghost" onClick={()=>changeAttachments(attachments.filter(x=>keyOf(x)!==scope))}>해제</button>}</header>
      <small>v{r.revision} · 로어 {pkg?.lore.length??'…'}개{pkg?.instructions.length?` · 지침 ${pkg.instructions.length}개`:''}</small>
      {pkg&&<details><summary>사용할 로어와 지침 확인</summary>{pkg.lore.map(l=><p key={l.id}><strong>{l.title}</strong> · {l.loading==='pinned'?'항상 포함':'필요할 때 읽기'}</p>)}{pkg.roleBindings?.[r.role]&&<p>{pkg.roleBindings[r.role]}</p>}{pkg.instructions.map(i=><p key={i.id}>{i.target} · {i.text.slice(0,160)}</p>)}</details>}
      {!!pkg?.controls.length&&<div className="package-options">{pkg.controls.map(c=>{const value=profile.packageValues?.[scope]?.[c.id]??c.default;const set=(v:typeof value)=>onChange({...profile,packageValues:{...profile.packageValues,[scope]:{...profile.packageValues?.[scope],[c.id]:v}}});return <label key={c.id} className={c.type==='boolean'?'check':''}>{c.type==='boolean'?<><input aria-label={`${content!.title} ${c.label}`} type="checkbox" checked={value===true} onChange={e=>set(e.target.checked)}/>{c.label}</>:<>{c.label}{c.type==='select'?<select value={String(value)} onChange={e=>set(c.options?.find(o=>String(o.value)===e.target.value)?.value??null)}>{c.options?.map(o=><option value={String(o.value)} key={String(o.value)}>{o.label}</option>)}</select>:<input type={c.type==='number'?'number':'text'} value={String(value??'')} min={c.min} max={c.max} onChange={e=>set(c.type==='number'?Number(e.target.value):e.target.value)}/>}</>}{c.description&&<small>{c.description}</small>}</label>;})}</div>}
    </article>;})}
    <fieldset className="package-entry"><legend>패키지 추가</legend><label>자료<select aria-label="추가할 패키지" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">자료 선택</option>{library.contents.filter(isPackageContent).map(c=><option key={refValue(c)} value={refValue(c)}>{c.title}</option>)}</select></label><label>이 채팅에서의 역할<select aria-label="패키지 장착 역할" value={role} onChange={e=>setRole(e.target.value as PackageRole)}><option value="module">모듈 · 추가 지침과 설정</option><option value="persona">페르소나 · 내가 맡는 인물</option>{(!ownerBotId||ownerBotId==='__legacy__')&&<option value="bot">봇</option>}</select></label><button type="button" className="secondary" disabled={!selected||busy} onClick={()=>void add()}>패키지 장착</button><small>같은 자료를 다른 역할로 사용할 수 있어요. 역할별 지침은 자료 설정에서 확인해요.</small></fieldset>
  </section>;
}
