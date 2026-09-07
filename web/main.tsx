import { ReaderPages } from './ReaderPages.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, BookOpen, Clock3, Copy, Maximize, Menu, Minimize, Plus, Search, Settings2, SlidersHorizontal, Square, Type } from 'lucide-react';
import type { Content } from '../core/product.js';
import { api, labels } from './api.js';
import { LibraryPanel, refValue } from './LibraryPanel.js';
import { HiddenStoryPanel } from './HiddenStoryPanel.js';
import { NativeBotPanel } from './NativeBotPanel.js';
import { ProfileEditor } from './ProfileEditor.js';
import { SourceReader } from './SourceReader.js';
import { PackageBehaviorPanel } from './PackageBehaviorPanel.js';
import { StoryPanel } from './StoryPanel.js';
import { AssetEditor } from './AssetEditor.js';
import { SessionGate } from './SessionGate.js';
import { Dialog } from './Dialog.js';
import { NewStory } from './NewStory.js';
import { BotNavigation, type ChatFolder } from './BotNavigation.js';
import { completePendingStoryProfile } from './pendingStory.js';
import { SettingsEditor } from './RuntimeSettings.js';
import { AppSettingsPanel, BranchesPanel, TasksPanel } from './WorkspacePanels.js';
import { useStory } from './useStory.js';
import { modelLabel } from './storyLabels.js';
import './style.css';
import './product.css';

type Panel = ''|'navigation'|'new'|'story'|'branches'|'tasks'|'settings'|'reading';
function App() {
  const s=useStory();
  const [panel,setPanel]=useState<Panel>(''); const [storySearch,setStorySearch]=useState('');
  const [initialBot,setInitialBot]=useState<Content>(); const [initialFolder,setInitialFolder]=useState<ChatFolder>(); const [libraryTab,setLibraryTab]=useState<'bot'|'persona'|'module'|'prompts'>('bot'); const [newKey,setNewKey]=useState(0);
  const [focus,setFocus]=useState(false); const [inspectedRun,setInspectedRun]=useState('');
  const [theme,setTheme]=useState<'system'|'dark'|'light'>(()=>{const value=localStorage.getItem('uimori:theme');return value==='dark'||value==='light'?value:'system';});
  const [font,setFont]=useState(()=>localStorage.getItem('uimori:font')||'sans');
  const [fontSize,setFontSize]=useState(()=>Math.max(16,Math.min(22,Number(localStorage.getItem('uimori:font-size')||18))));
  const [enterSend,setEnterSend]=useState(()=>localStorage.getItem('uimori:enter-send')==='true');
  const [readingLanguage,setReadingLanguage]=useState(()=>localStorage.getItem('uimori:reading-language')||'translation');
  const composing=useRef(false);
  const [libraryDirty,setLibraryDirty]=useState(false);const [pendingNavigation,setPendingNavigation]=useState<null|(()=>void)>(null);
  const currentPrompt=s.detail?.profile?.prompts?.main;const currentCombination=s.library?.promptCombinations?.find(c=>currentPrompt&&refValue(c.prompt)===refValue(currentPrompt)&&JSON.stringify(c.values)===JSON.stringify(s.detail?.profile?.promptControls?.[refValue(c.prompt)]?.values));
  useLayoutEffect(()=>{
    const node=s.input.current;if(!node)return;
    node.style.height='auto';node.style.height=`${Math.min(node.scrollHeight,180)}px`;
  },[s.draft,s.viewKey,s.destination]);
  const mainModel=s.library?.models.find(item=>s.detail?.profile?.routes.main&&refValue(item)===refValue(s.detail.profile.routes.main));
  const mainDescription=mainModel?modelLabel(mainModel,s.library):s.detail?.profile?.routes.main?'보관된 본문 모델':'검사용 모의 생성 · 실제 모델 없음';
  useEffect(()=>{
    const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.dataset.theme=theme==='system'?media.matches?'dark':'light':theme;};
    apply();media.addEventListener('change',apply);localStorage.setItem('uimori:theme',theme);return()=>media.removeEventListener('change',apply);
  },[theme]);
  useEffect(()=>{document.documentElement.dataset.readingFont=font;document.documentElement.style.setProperty('--reading',`${fontSize}px`);localStorage.setItem('uimori:font',font);localStorage.setItem('uimori:font-size',String(fontSize));},[font,fontSize]);
  useEffect(()=>{localStorage.setItem('uimori:enter-send',String(enterSend));},[enterSend]);
  useEffect(()=>{localStorage.setItem('uimori:reading-language',readingLanguage);},[readingLanguage]);
  useEffect(()=>{const viewport=visualViewport;const update=()=>document.documentElement.style.setProperty('--app-height',`${viewport?.height??innerHeight}px`);update();viewport?.addEventListener('resize',update);return()=>viewport?.removeEventListener('resize',update);},[]);
  useEffect(()=>{const onPop=()=>setPanel('');addEventListener('popstate',onPop);return()=>removeEventListener('popstate',onPop);},[]);
  function newStory(bot?:Content,folder?:ChatFolder){setInitialBot(bot);setInitialFolder(folder);setNewKey(old=>old+1);setPanel('new');}
  function select(id:string){const go=()=>{s.select(id);setPanel('');};if(libraryDirty&&s.destination==='library')setPendingNavigation(()=>go);else go();}
  function showLibrary(tab:'bot'|'persona'|'module'|'prompts'='bot'){setLibraryTab(tab);s.showLibrary();setPanel('');}
  function inspect(id:string){setInspectedRun(id);setPanel('tasks');}
  const navigation=<BotNavigation library={s.library} chats={s.chats} selected={s.selected} destination={s.destination} onSelect={select} onNew={newStory} onLibrary={showLibrary} onChatsChanged={s.loadChats} onError={s.setError} onSettings={()=>setPanel('settings')} onTasks={()=>inspect('')} tasks={s.tasks}/>;
  return <div className={`app-shell ${focus?'focus-reading':''}`}>
    <aside className="sidebar">{navigation}</aside>
    <main className="story-workspace">
      <header className="workspace-header"><button className="icon-button mobile-menu" aria-label="탐색 메뉴" onClick={()=>setPanel('navigation')}><Menu size={20}/></button><div className="header-title"><h1>{s.destination==='library'?({bot:'봇',persona:'페르소나',module:'모듈',prompts:'프롬프트'}[libraryTab]):s.detail?.chat.title||'Uimori'}</h1><small>{s.destination==='library'?'내 자료와 창작 방식':s.bot?.title||(s.selected?'채팅을 이어가는 중':'나의 채팅')}</small></div><div className="header-actions">{s.selected&&s.destination==='story'&&<><button className="icon-button" aria-label="채팅 포크" title="여기까지 복사해서 새 채팅으로 이어가기" disabled={!s.sources.length||s.forking.some(key=>key.startsWith(`${s.selected}:`))} onClick={()=>{const source=s.sources.at(-1);if(source)void s.fork(source.id);}}><Copy size={19}/></button><button className="icon-button reading-button" aria-label="읽기 설정" title="읽기 설정" onClick={()=>setPanel('reading')}><Type size={20}/></button><button className="icon-button" aria-label={focus?'집중 읽기 종료':'집중 읽기'} title="집중 읽기" onClick={()=>setFocus(!focus)}>{focus?<Minimize size={19}/>:<Maximize size={19}/>}</button><button className="icon-button" aria-label="채팅 설정" title="채팅 설정" onClick={()=>setPanel('story')}><SlidersHorizontal size={20}/></button></>}</div></header>
      {s.destination==='library'?<div className="destination-scroll"><LibraryPanel library={s.library} reload={s.loadLibrary} onError={s.setError} onStartStory={newStory} initialTab={libraryTab} onTabChange={setLibraryTab} onDirtyChange={setLibraryDirty}/>{s.error&&<p className="error" role="alert">{s.error}</p>}</div>:<>
        <div ref={s.reader} className="reader-scrollport" data-reader-scrollport onScroll={s.savePosition}><section className="reader" aria-label="원고">
          {!s.selected?<div className="empty-state"><BookOpen size={32}/><h2>어떤 채팅을 시작할까요?</h2><p className="muted">서재에서 봇을 고르거나, 원하는 장면으로 시작해요.</p><button onClick={()=>newStory()}>새 채팅</button><button className="secondary" onClick={()=>showLibrary()}>서재 둘러보기</button></div>:!s.detail?<p role="status">채팅을 불러오는 중이에요…</p>:<>
            <div className="story-context">{s.profileAsset&&<img className="profile-asset" data-testid="profile-asset" src={s.profileAsset.url} alt={s.profileAsset.description||s.profileAsset.title}/>}<span>{s.bot?.title||'나의 채팅'}{s.persona&&` · 페르소나 ${s.persona.title}`}</span>{(s.detail.branches?.length??0)>1&&<button className="secondary" onClick={()=>setPanel('branches')}>보관된 전개</button>}</div>
            {!s.connected&&<p className="connection-note" role="status">연결을 다시 확인하는 중이에요.</p>}
            {!s.sources.length&&!s.visibleRuns.length&&!s.active&&<div className="first-scene"><h2>첫 장면을 들려주세요.</h2><p className="muted">배경과 인물, 일어나길 바라는 일을 아래에 적어주세요.</p></div>}
            <ReaderPages detail={s.detail} head={s.branch?.headRevision??null} onSelect={s.chooseSource}/>
            {s.sources.map((source,index)=><SourceReader hasPackages={!!s.detail!.runs.find(run=>run.id===source.runId)?.hasPackages} presentationRefreshKey={s.detail!.reader.cursor} hiddenConfig={s.detail!.runs.find(run=>run.id===source.runId)?.hiddenConfig} key={source.id} source={source} index={index+(s.detail?.reader?.start??0)} request={s.detail!.runs.find(run=>run.id===source.runId)?.request} jobs={s.detail!.jobs.filter(job=>job.sourceRevision===source.id)} assets={s.detail!.assets??[]} refresh={()=>s.refresh(s.selected)} onError={s.setError} onFork={s.fork} onInspect={inspect}/>)}
            <ReaderPages detail={s.detail} head={s.branch?.headRevision??null} onSelect={s.chooseSource} end/>{!!s.detail.profile?.packageAttachments?.length&&<PackageBehaviorPanel chatId={s.selected} branchId={s.branch?.id} refreshKey={s.detail.reader.cursor} onChange={()=>{void s.refresh(s.selected);}}/>}
            {s.visibleRuns.filter(run=>!run.sourceRevision).map(run=><article className="pending-turn" key={run.id} data-testid="pending-run"><div className="request-message"><small>내 장면 요청</small><p>{run.request}</p></div><div className="run-outcome"><strong>{run.status==='waiting_for_state'?'상태 확인 대기':s.active?.id===run.id?'다음 장면을 만들고 있어요':labels[run.status]}</strong>{run.error&&<p className="error">{run.error}</p>}{run.partialText&&<><small>확정되지 않은 부분 출력</small><p className="partial-prose">{run.partialText}</p></>}<button className="secondary" onClick={()=>inspect(run.id)}>작업 상세</button></div></article>)}
          </>}
        </section></div>
        {s.selected&&<div className="composer-dock">{s.pendingProfile&&<div className="error" role="alert">시작 설정 저장이 끝나지 않았어요.<button className="secondary" onClick={()=>{void(async()=>{try{const chatId=s.selected;await completePendingStoryProfile(chatId);await s.refresh(chatId);}catch(err){s.setError((err as Error).message);}})();}}>시작 설정 다시 저장</button></div>}{s.error&&<div className="error" role="alert">{s.error}</div>}
          <form className="composer" onSubmit={event=>{event.preventDefault();void s.generate();}}><label className="sr-only" htmlFor="request">다음 장면 요청</label><textarea ref={s.input} id="request" rows={2} maxLength={4000} value={s.draft} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onSelect={s.rememberCursor} onChange={event=>{s.editDraft(event.target.value);}} onKeyDown={event=>{if(event.key!=='Enter'||event.nativeEvent.isComposing||composing.current||event.keyCode===229)return;if(event.ctrlKey||event.metaKey||enterSend&&!event.shiftKey){event.preventDefault();if(!s.active)void s.generate();}}} placeholder="다음 장면을 부탁하거나, 채팅을 이어가세요…"/>
            <div className="composer-bottom"><div className="quick-controls"><label><span className="sr-only">빠른 창작 프리셋</span><select aria-label="빠른 창작 프리셋" value={currentCombination?refValue(currentCombination):''} disabled={s.quickBusy||s.profileDirty||!s.detail} onChange={event=>{void s.quickChange('combination',event.target.value);}}><option value="">창작 프리셋 · 현재 설정</option>{s.library?.promptCombinations?.filter(c=>s.detail?.profile?.prompts?.main&&refValue(c.prompt)===refValue(s.detail.profile.prompts.main)).map(item=><option value={refValue(item)} key={refValue(item)}>{item.title}</option>)}</select></label><label><span className="sr-only">빠른 페르소나</span><select aria-label="빠른 페르소나" value={s.persona?refValue(s.persona):''} disabled={s.quickBusy||s.profileDirty||!s.detail||!s.attachmentsReady} onChange={event=>{void s.quickChange('persona',event.target.value);}}><option value="">{s.attachmentsReady?'페르소나 없음':'페르소나 확인 중…'}</option>{s.allContents.filter(item=>item.kind==='persona').map(item=><option key={refValue(item)} value={refValue(item)}>{item.title}</option>)}</select></label><label className="quick-model"><span className="sr-only">빠른 본문 모델</span><select aria-label="빠른 본문 모델" value={s.detail?.profile?.routes.main?refValue(s.detail.profile.routes.main):''} disabled={s.quickBusy||s.profileDirty||!s.detail} onChange={event=>{void s.quickChange('model',event.target.value);}}><option value="">검사용 모의 생성 · 실제 모델 없음</option>{s.detail?.profile?.routes.main&&!s.quickModels.some(item=>refValue(item)===refValue(s.detail!.profile!.routes.main!))&&<option value={refValue(s.detail.profile.routes.main)}>보관된 본문 모델</option>}{s.quickModels.map(item=><option key={refValue(item)} value={refValue(item)}>{modelLabel(item,s.library)}</option>)}</select></label></div>{s.active?<button type="button" className="send-button" aria-label="원문 생성 취소" title="원문 생성 중단" onClick={()=>{void api(`/runs/${s.active!.id}/cancel`,{}).then(()=>s.refresh(s.selected)).catch(e=>s.setError(e.message));}}><Square size={18}/></button>:<button className="send-button" aria-label={s.pendingRequest?'이전 요청 확인':'원문 생성'} title={s.pendingRequest?'이전 전송의 수락 확인':'보내기'} disabled={s.submitting.includes(s.viewKey)||(!s.draft.trim()&&!s.pendingRequest)||!s.detail||s.pendingProfile}><ArrowUp size={21}/></button>}</div>
          </form><div className="composer-caption"><span role="status">{s.submitting.includes(s.viewKey)?'요청을 보내는 중…':s.active?`원문 ${labels[s.active.status]} · 작업 상세에서 확인`:s.pendingRequest?'이전 전송의 수락을 확인해 주세요. 새 초안은 보존돼요.':s.notice||mainDescription}{s.profileDirty&&' · 채팅 설정에 미저장 변경'}</span><span>{enterSend?'Enter 보내기 · Shift+Enter 줄바꿈':'Ctrl+Enter 보내기'}</span></div>
        </div>}
      </>}
    </main>
    <Dialog open={!!pendingNavigation} title="편집 중인 자료" onClose={()=>setPendingNavigation(null)}><p>저장하지 않은 자료 편집이 있어요.</p><button className="secondary" onClick={()=>setPendingNavigation(null)}>계속 편집</button><button onClick={()=>{const go=pendingNavigation;setPendingNavigation(null);setLibraryDirty(false);go?.();}}>초안 버리고 이동</button></Dialog>
    <Dialog open={panel==='navigation'} title="탐색" onClose={()=>setPanel('')} className="navigation-dialog">{navigation}</Dialog>
    <Dialog open={panel==='new'} title="새 채팅" onClose={()=>setPanel('')}>{s.library&&<NewStory key={newKey} library={s.library} initialBot={initialBot} initialFolder={initialFolder} onCreated={async chat=>{await s.loadChats();select(chat.id);}}/>}</Dialog>
    <Dialog scopeKey={s.selected} open={panel==='story'} title="채팅 설정" onClose={()=>setPanel('')} wide>{s.detail&&s.library&&<>{s.detail.profile&&<ProfileEditor ownerBotId={s.detail.chat.botId} branchId={s.branch?.id} key={s.selected} profile={s.detail.profile} library={s.library} onSaved={()=>s.refresh(s.selected)} onError={s.setError} onDirtyChange={s.setProfileDirty} onLibraryChanged={s.loadLibrary}/>}{s.detail.profile&&<HiddenStoryPanel forceNonsexual={s.detail.reader.nativeBotAttached} profile={s.detail.profile} onChanged={()=>{void s.refresh(s.selected);}} onError={s.setError}/>}<NativeBotPanel refreshKey={s.detail.reader.cursor} chatId={s.selected} branchId={s.branch?.id??`main:${s.selected}`} headRevision={s.branch?.headRevision??s.detail.chat.headRevision} sourceHash={s.detail.reader.headSourceHash} onChanged={()=>{void s.refresh(s.selected);}} onError={s.setError} onRunRequest={(text,commandId)=>{s.editDraft(text,commandId);setPanel('');s.input.current?.focus();}}/><StoryPanel key={`story:${s.selected}`} chatId={s.selected} branchId={s.branch?.id??`main:${s.selected}`} headRevision={s.branch?.headRevision??s.detail.chat.headRevision} settingsRevision={s.detail.chat.settingsRevision} profileRevision={s.detail.profile?.revision} models={s.library.models} connections={s.library.connections} onChanged={()=>{void s.refresh(s.selected);}} onError={s.setError}/><AssetEditor key={`assets:${s.selected}`} chatId={s.selected} assets={s.detail.assets??[]} refresh={()=>s.refresh(s.selected)} onError={s.setError}/><SettingsEditor key={`runtime:${s.selected}`} chat={s.detail.chat} onSaved={()=>s.refresh(s.selected)} onError={s.setError}/><button className="secondary" onClick={()=>setPanel('reading')}>읽기 설정 열기</button>{s.error&&<p role="alert" className="error">{s.error}</p>}</>}</Dialog>
    <Dialog open={panel==='branches'} title="보관된 전개" onClose={()=>setPanel('')}><BranchesPanel state={s} onClose={()=>setPanel('')}/></Dialog>
    <Dialog scopeKey={s.selected} open={panel==='tasks'} title="작업 현황" onClose={()=>setPanel('')} wide>{panel==='tasks'&&<TasksPanel state={s} inspectedRun={inspectedRun} onInspect={setInspectedRun} onClose={()=>setPanel('')}/>}</Dialog>
    <Dialog open={panel==='reading'} title="읽기 설정" onClose={()=>setPanel('')}><div className="settings-stack"><label>새 원고의 기본 보기<select aria-label="새 원고의 기본 보기" value={readingLanguage} onChange={event=>setReadingLanguage(event.target.value)}><option value="translation">한국어 번역</option><option value="original">원문</option></select></label><small>번역이 없으면 원문을 먼저 보여 줘요. 번역 보기를 눌러 번역을 시작하고, 이미 저장된 번역은 다시 호출하지 않아요.</small><label>본문 글꼴<select aria-label="본문 글꼴" value={font} onChange={event=>setFont(event.target.value)}><option value="sans">기본 고딕</option><option value="serif">명조</option></select></label><label>본문 크기<input aria-label="본문 크기" type="range" min={16} max={22} step={1} value={fontSize} onChange={event=>setFontSize(Number(event.target.value))}/><span>{fontSize}px</span></label><label>화면 테마<select aria-label="화면 테마" value={theme} onChange={event=>setTheme(event.target.value as typeof theme)}><option value="system">기기 설정</option><option value="dark">어두운 화면</option><option value="light">밝은 화면</option></select></label><button className="secondary" onClick={()=>{setFocus(true);setPanel('');}}>집중 읽기 시작</button></div></Dialog>
    <Dialog open={panel==='settings'} title="설정" onClose={()=>setPanel('')} wide className="settings-dialog">{panel==='settings'&&<><AppSettingsPanel state={s} theme={theme} setTheme={setTheme} enterSend={enterSend} setEnterSend={setEnterSend}/>{s.error&&<p className="error" role="alert">{s.error}</p>}</>}</Dialog>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SessionGate><App/></SessionGate>);
