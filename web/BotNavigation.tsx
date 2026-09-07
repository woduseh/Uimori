import { DeleteButton } from './DeleteButton.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Boxes, Clock3, Folder, Plus, Search, Settings2, Users } from 'lucide-react';
import type { Content, Library } from '../core/product.js';
import type { Chat } from '../core/types.js';
import type { ChatFolder } from '../server/chat-organization.js';
import { api } from './api.js';
import './bot-navigation.css';

export type { ChatFolder } from '../server/chat-organization.js';
type LibraryDestination = 'bot'|'persona'|'module'|'prompts';
type Props = {library:Library|null;chats:Chat[];selected:string;destination:'story'|'library';onSelect:(id:string)=>void;onNew:(bot:Content,folder?:ChatFolder)=>void;onLibrary:(tab:LibraryDestination)=>void;onChatsChanged:()=>Promise<void>;onError:(message:string)=>void;onSettings:()=>void;onTasks:()=>void;tasks:number};
const legacy='__legacy__';
const reference=(value:{id:string;revision:number})=>`${value.id}@${value.revision}`;

export function BotNavigation(props:Props) {
  const {library,chats,selected,destination,onSelect,onNew,onLibrary,onChatsChanged,onError,onSettings,onTasks,tasks}=props;
  const [botId,setBotId]=useState('');const [query,setQuery]=useState('');const [folders,setFolders]=useState<ChatFolder[]>([]);const [loading,setLoading]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [newTitle,setNewTitle]=useState('');
  const currentBot=useRef(botId);currentBot.current=botId;const epoch=useRef(0);const operation=useRef(false);
  const selectedOwner=chats.find(chat=>chat.id===selected)?.botId??'';
  useEffect(()=>{if(selected&&destination==='story'){setBotId(selectedOwner);setQuery('');}},[selected,selectedOwner,destination]);
  const ownerIds=useMemo(()=>new Set(chats.map(chat=>chat.botId??'')),[chats]);
  const bots=useMemo(()=>library?.contents.filter(content=>content.kind==='bot'||ownerIds.has(content.id))??[],[library,ownerIds]);
  const bot=bots.find(content=>content.id===botId);
  const scoped=chats.filter(chat=>(chat.botId??'')===botId);
  const visible=scoped.filter(chat=>chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const personas=library?.contents.filter(content=>content.kind==='persona'||content.hasPackage||content.package)??[];
  useEffect(()=>{const version=++epoch.current;setFolders([]);setNewTitle('');setError('');if(!botId)return;let alive=true;setLoading(true);
    void api<ChatFolder[]>(`/bots/${encodeURIComponent(botId)}/folders`).then(value=>{if(alive&&epoch.current===version)setFolders(value);}).catch(reason=>{if(alive&&epoch.current===version)setError(reason.message);}).finally(()=>{if(alive&&epoch.current===version)setLoading(false);});
    return()=>{alive=false;};
  },[botId]);
  async function perform(action:()=>Promise<unknown>) {
    if(operation.current)return;operation.current=true;setBusy(true);setError('');const owner=botId;const version=epoch.current;
    try{await action();await onChatsChanged();if(owner===currentBot.current&&version===epoch.current){const value=await api<ChatFolder[]>(`/bots/${encodeURIComponent(owner)}/folders`);if(owner===currentBot.current&&version===epoch.current)setFolders(value);}}
    catch(reason){const message=reason instanceof Error?reason.message:'변경 내용을 저장하지 못했어요.';onError(message);if(owner===currentBot.current)setError(message);
      // Refresh revisions after a conflict, retaining the user's editable form values.
      try{const value=await api<ChatFolder[]>(`/bots/${encodeURIComponent(owner)}/folders`);if(owner===currentBot.current&&version===epoch.current)setFolders(value);await onChatsChanged();}catch{/* The original error remains visible. */}}
    finally{operation.current=false;setBusy(false);}
  }
  async function start(folder?:ChatFolder) {
    if(!bot||operation.current)return;operation.current=true;setBusy(true);const owner=bot.id;const version=epoch.current;
    try{const full=library?.contentBodiesOmitted||bot.hasPackage&&!bot.package?await api<Content>(`/revisions/content/${encodeURIComponent(bot.id)}/${bot.revision}`):bot;if(owner===currentBot.current&&version===epoch.current)onNew(full,folder);}
    catch(reason){const message=reason instanceof Error?reason.message:'봇을 불러오지 못했어요.';setError(message);onError(message);}finally{operation.current=false;setBusy(false);}
  }
  function chooseBot(id:string){setBotId(id);setQuery('');}
  function chatList(folderId:string|null) {
    const items=visible.filter(chat=>(chat.folderId??null)===folderId);
    return <div className="bot-chat-list">{items.map(chat=><div className="bot-chat-item" key={chat.id}>
      <button className={`chat-link ${selected===chat.id&&destination==='story'?'selected':''}`} aria-current={selected===chat.id&&destination==='story'?'page':undefined} onClick={()=>onSelect(chat.id)}><strong>{chat.title}</strong>{selected===chat.id&&tasks>0&&<small>{tasks}개 작업 진행 중</small>}</button>
      <label className="bot-chat-move"><span className="sr-only">{chat.title} 폴더 이동</span><select aria-label={`${chat.title} 폴더 이동`} value={chat.folderId??''} disabled={busy||loading||chat.organizationRevision===undefined} onChange={event=>{const folderId=event.target.value||null;void perform(()=>api(`/chats/${chat.id}/organization`,{expectedRevision:chat.organizationRevision,folderId},'PATCH'));}}><option value="">미분류</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.title}</option>)}</select></label>
      <DeleteButton path={`/chats/${encodeURIComponent(chat.id)}`} preparePath={`/chats/${encodeURIComponent(chat.id)}/deletion-impact`} title={chat.title} label="채팅 삭제" disabled={busy} description="이 채팅의 모든 분기, 원문, 번역, 이미지와 실행 기록을 영구 삭제해요. 실행 중인 작업은 먼저 취소하거나 완료해 주세요." onError={onError} onDeleted={onChatsChanged}/>
    </div>)}{!items.length&&<p className="bot-empty-folder">{query?'검색 결과가 없어요.':'채팅이 없어요.'}</p>}</div>;
  }
  const navigation:[LibraryDestination,string,typeof BookOpen][]=[['bot','봇',BookOpen],['persona','페르소나',Users],['module','모듈',Boxes],['prompts','프롬프트',BookOpen]];
  return <div className="bot-navigation" data-testid="bot-navigation">
    <div className="brand">Uimori</div><nav className="bot-library-nav" aria-label="자료 탐색">{navigation.map(([tab,label,Icon])=><button type="button" className="nav-button" key={tab} onClick={()=>onLibrary(tab)}><Icon size={17}/>{label}</button>)}</nav>
    <div className="bot-navigation-scroll">
      {!botId?<><div className="bot-list-heading"><h2>나의 봇</h2><button className="icon-button" aria-label="봇 만들기" onClick={()=>onLibrary('bot')}><Plus size={18}/></button></div><label className="story-search"><Search size={16}/><input aria-label="봇 검색" placeholder="봇 검색" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {!library?<p role="status">봇을 불러오는 중이에요…</p>:<nav aria-label="봇별 채팅">{bots.filter(content=>content.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(content=><button className="bot-choice" key={content.id} onClick={()=>chooseBot(content.id)}><span className="bot-choice-avatar" aria-hidden="true">{Array.from(content.title)[0]||'·'}</span><span><strong>{content.title}</strong><small>채팅 {chats.filter(chat=>chat.botId===content.id).length}개</small></span></button>)}{ownerIds.has(legacy)&&<button type="button" className="bot-choice" onClick={()=>chooseBot(legacy)}><span><strong>봇 없는 채팅</strong><small>채팅 {chats.filter(chat=>chat.botId===legacy).length}개</small></span></button>}{!bots.length&&!ownerIds.has(legacy)&&<div className="bot-navigation-empty"><p>첫 봇을 준비해 보세요.</p><button className="secondary" onClick={()=>onLibrary('bot')}>봇 만들기</button></div>}</nav>}</>:
      <><button className="bot-back secondary" onClick={()=>chooseBot('')}><ArrowLeft size={16}/>봇 목록</button><div className="bot-owner-heading"><h2>{bot?.title??(botId===legacy?'봇 없는 채팅':'봇')}</h2><small>채팅 {scoped.length}개</small></div>{bot&&<button className="new-story-button secondary" disabled={busy} onClick={()=>{void start();}}><Plus size={17}/>새 채팅</button>}
        <label className="story-search"><Search size={16}/><input aria-label="채팅 검색" placeholder="이 봇의 채팅 검색" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        <details className="bot-folder-create"><summary>폴더 만들기</summary><form onSubmit={event=>{event.preventDefault();const title=newTitle.trim();if(title)void perform(async()=>{await api(`/bots/${encodeURIComponent(botId)}/folders`,{title});if(currentBot.current===botId)setNewTitle('');});}}><label>새 폴더 이름<input aria-label="새 폴더 이름" required maxLength={200} value={newTitle} onChange={event=>setNewTitle(event.target.value)}/></label><button type="submit" disabled={busy||!newTitle.trim()}>폴더 추가</button></form></details>
        {loading?<p role="status">폴더를 불러오는 중이에요…</p>:<nav aria-label="봇의 채팅 목록"><section className="bot-folder"><div className="bot-folder-heading"><h3><Folder size={15}/>미분류</h3></div>{chatList(null)}</section>{folders.map(folder=><section className="bot-folder" key={folder.id}><div className="bot-folder-heading"><h3><Folder size={15}/>{folder.title}</h3>{bot&&<button className="icon-button" aria-label={`${folder.title}에서 새 채팅`} disabled={busy} onClick={()=>{void start(folder);}}><Plus size={16}/></button>}</div>{chatList(folder.id)}<FolderSettings folder={folder} personas={personas} busy={busy} onSave={value=>perform(()=>api(`/bots/${encodeURIComponent(botId)}/folders/${folder.id}`,{expectedRevision:folder.revision,...value},'PATCH'))} onRemove={()=>perform(()=>api(`/bots/${encodeURIComponent(botId)}/folders/${folder.id}`,{expectedRevision:folder.revision},'DELETE'))}/></section>)}</nav>}</>}
      {error&&<p className="error" role="alert">{error}</p>}
    </div>
    <div className="nav-bottom"><button className="nav-button" aria-label="작업 현황" onClick={onTasks}><Clock3 size={19}/>작업 현황{tasks>0&&<span className="count">{tasks}</span>}</button><button className="nav-button" onClick={onSettings}><Settings2 size={19}/>설정</button></div>
  </div>;
}

function FolderSettings({folder,personas,busy,onSave,onRemove}:{folder:ChatFolder;personas:Content[];busy:boolean;onSave:(value:{title:string;defaultPersona:{id:string;revision:number}|null})=>Promise<void>;onRemove:()=>Promise<void>}) {
  const [title,setTitle]=useState(folder.title);const [persona,setPersona]=useState(folder.defaultPersona?reference(folder.defaultPersona):'');
  useEffect(()=>{setTitle(folder.title);setPersona(folder.defaultPersona?reference(folder.defaultPersona):'');},[folder.title,folder.defaultPersona?.id,folder.defaultPersona?.revision]);
  return <details className="bot-folder-settings"><summary>{folder.title} 폴더 설정</summary><form onSubmit={event=>{event.preventDefault();const selected=personas.find(content=>reference(content)===persona);void onSave({title,defaultPersona:selected?{id:selected.id,revision:selected.revision}:persona?folder.defaultPersona:null});}}><label>폴더 이름<input aria-label={`${folder.title} 폴더 이름`} value={title} maxLength={200} required onChange={event=>setTitle(event.target.value)}/></label><label>새 채팅 기본 페르소나<select aria-label={`${folder.title} 기본 페르소나`} value={persona} onChange={event=>setPersona(event.target.value)}><option value="">지정 안 함</option>{persona&&!personas.some(content=>reference(content)===persona)&&<option value={persona}>보관된 페르소나</option>}{personas.map(content=><option key={reference(content)} value={reference(content)}>{content.title}</option>)}</select></label><small>앞으로 이 폴더에서 시작하는 채팅에 적용돼요.</small><button className="secondary" disabled={busy||!title.trim()}>설정 저장</button></form><button type="button" className="bot-folder-release secondary" disabled={busy} onClick={()=>{void onRemove();}}>폴더 해제 · 채팅 유지</button></details>;
}
