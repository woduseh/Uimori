import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../core/types.js';
import type { Content, Library, ModelPreset, PromptPreset, SavedPromptCombination } from '../core/product.js';
import { api } from './api.js';
import { refValue } from './LibraryPanel.js';
import { modelLabel } from './storyLabels.js';
import { completePendingStoryProfile, savePendingStoryProfile, type NewStoryProfileIntent } from './pendingStory.js';
import { useModelSelection } from './model-selection.js';
import type { ChatFolder } from './BotNavigation.js';

type StorySelection = { title: string; bot: Content | null; persona: Content | null; prompt: PromptPreset | null; combination: SavedPromptCombination | null; main: ModelPreset | null; translation: ModelPreset | null; profile: NewStoryProfileIntent | null };

const modelsKey = 'uimori:new-story-models';
function rememberedModels(library: Library): { main: string; translation: string } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(modelsKey) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { main: '', translation: '' };
    const choices = saved as Record<string, unknown>;
    const available = library.models.filter(model => model.enabled !== false);
    const restore = (role: string) => available.some(item => item.id === choices[role]) ? String(choices[role]) : '';
    return { main: restore('main'), translation: restore('translation') };
  } catch { return { main: '', translation: '' }; }
}

export function NewStory({ library, initialBot, initialFolder, onCreated }: { library: Library; initialBot?: Content; initialFolder?: ChatFolder; onCreated: (chat: Chat) => Promise<void> }) {
  const {choices} = useModelSelection(library.models,library.connections);
  const [bot, setBot] = useState(initialBot ? refValue(initialBot) : '');
  const [persona, setPersona] = useState(initialFolder?.defaultPersona?refValue(initialFolder.defaultPersona):'');
  const [prompt,setPrompt]=useState('');const [combination,setCombination]=useState('');
  const [models, setModels] = useState(() => rememberedModels(library));
  const [title, setTitle] = useState(''); const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const created = useRef<Chat | null>(null); const uncertain = useRef(false);
  const submitted = useRef<StorySelection | null>(null); const creating = useRef(false); const profileRecorded = useRef(false);
  const availableModelKeys=JSON.stringify(choices.map(item=>item.id));
  useEffect(() => { if (initialBot && !submitted.current) setBot(refValue(initialBot)); }, [initialBot]);
  useEffect(()=>{
    // A submitted profile intent keeps its model IDs while settings remain editable.
    if(submitted.current)return;
    setModels(previous=>{
      const available=new Set<string>(JSON.parse(availableModelKeys));
      const main=available.has(previous.main)?previous.main:'',translation=available.has(previous.translation)?previous.translation:'';
      return main===previous.main&&translation===previous.translation?previous:{main,translation};
    });
  },[availableModelKeys]);
  function captureSelection(): StorySelection {
    const selectedBot = bot ? [initialBot,...library.contents].find(item => item && refValue(item) === bot) : null;
    const selectedPersona = persona ? library.contents.find(item => (item.kind === 'persona'||item.hasPackage||item.package) && refValue(item) === persona) : null;
    const available = choices;
    const main = models.main ? available.find(item => item.id === models.main) : null;
    const translation = models.translation ? available.find(item => item.id === models.translation) : null;
    if (models.main && !main || models.translation && !translation) throw new Error('선택한 모델을 사용할 수 없어요. 연결과 모델 목록을 확인한 뒤 다시 골라 주세요.');
    if (!selectedBot || persona && !selectedPersona) throw new Error('채팅의 소속 봇을 선택해 주세요. 목록이 바뀌었다면 자료를 다시 골라 주세요.');
    const selectedPrompt=library.promptPresets?.find(p=>refValue(p)===prompt&&p.role==='main');
    const selectedCombination=library.promptCombinations?.find(c=>refValue(c)===combination&&selectedPrompt&&refValue(c.prompt)===refValue(selectedPrompt));
    if(prompt&&!selectedPrompt||combination&&!selectedCombination)throw new Error('프롬프트와 창작 프리셋의 조합을 다시 확인해 주세요.');
    const selectedContents=[selectedBot,selectedPersona].filter((item):item is Content=>!!item);
    return structuredClone({
      title: title.trim() || (selectedBot ? `${selectedBot.title}의 채팅`.slice(0, 100) : '새로운 채팅'),
      bot: selectedBot ?? null, persona: selectedPersona ?? null, prompt: selectedPrompt ?? null, combination: selectedCombination ?? null, main: main ?? null, translation: translation ?? null,
      profile: selectedBot || selectedPersona || selectedPrompt || main || translation ? {
        attachments: selectedContents.filter(item=>!item.package&&!item.hasPackage).map(({ id, revision }) => ({ id, revision })),
        packageAttachments: selectedContents.filter(item=>item.package||item.hasPackage).map(item=>({id:item.id,revision:item.revision,role:item===selectedBot?'bot' as const:'persona' as const})),
        ...(selectedPrompt?{prompts:{main:{id:selectedPrompt.id,revision:selectedPrompt.revision}}}:{}),
        ...(selectedPrompt&&selectedCombination?{promptControls:{[refValue(selectedPrompt)]:{values:selectedCombination.values,combinations:[]}}}:{}),
        creative: null,
        ...(main || translation ? { models: { main: main ? { id: main.id } : null, translation: translation ? { id: translation.id } : null } } : {}),
      } : null,
    });
  }
  async function create() {
    if (creating.current) return;
    creating.current = true; setBusy(true); setError('');
    try {
      const selection = submitted.current ??= captureSelection();
      if (!created.current) {
        if (uncertain.current) throw new Error('채팅 생성 응답을 확인하지 못했어요. 목록을 새로 확인한 뒤 이어서 설정해 주세요. 중복 생성을 막기 위해 자동 재전송하지 않아요.');
        uncertain.current = true;
        created.current = await api<Chat>('/chats', { title: selection.title, botId:selection.bot!.id,folderId:initialFolder?.id??null });
        uncertain.current = false;
      }
      const chat = created.current;
      if (selection.profile) {
        if (!profileRecorded.current) {
          // Persist the intent before the next request so even a failed profile GET
          // leaves the new chat blocked until its original choices are saved.
          savePendingStoryProfile(chat.id, selection.profile);
          profileRecorded.current = true;
        }
        await completePendingStoryProfile(chat.id);
      }
      localStorage.setItem(modelsKey, JSON.stringify({ main: selection.main ? selection.main.id : '', translation: selection.translation ? selection.translation.id : '' }));
      await onCreated(chat);
    } catch (err) { setError((err as Error).message); } finally { creating.current = false; setBusy(false); }
  }
  const frozen = submitted.current;
  const locked = busy || !!frozen;
  const frozenContents = [frozen?.bot, frozen?.persona].filter((item): item is Content => !!item);
  const contents = library.contents.map(item => frozenContents.find(selected => refValue(selected) === refValue(item)) ?? item);
  for (const item of frozenContents) if (!contents.some(current => refValue(current) === refValue(item))) contents.push(item);
  const prompts = [...(library.promptPresets??[])];
  if (frozen?.prompt && !prompts.some(item => refValue(item) === refValue(frozen.prompt!))) prompts.push(frozen.prompt);
  const combinations = [...(library.promptCombinations??[])];
  if (frozen?.combination && !combinations.some(item => refValue(item) === refValue(frozen.combination!))) combinations.push(frozen.combination);
  for (const selected of [frozen?.main, frozen?.translation]) if (selected && !choices.some(item => item.id === selected.id)) choices.push(selected);
  const bots = contents.filter(item => (initialBot?item.id===initialBot.id:item.kind === 'bot') && `${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  return <form className="new-story" onSubmit={event => { event.preventDefault(); void create(); }}>
    <p className="muted">함께할 봇을 고르고, 첫 장면으로 시작해요.</p>
    <label>봇 찾기<input aria-label="시작할 봇 찾기" value={search} onChange={event => setSearch(event.target.value)} disabled={locked}/></label>
    <div className="bot-picker" role="group" aria-label="시작할 봇">{bots.map(item => <button type="button" key={refValue(item)} className={`bot-option ${bot === refValue(item) ? 'chosen' : ''}`} aria-pressed={bot === refValue(item)} onClick={() => setBot(refValue(item))} disabled={locked||!!initialBot}><strong>{item.title}</strong><small>{item.description || '등록한 봇으로 채팅을 시작해요'}</small></button>)}</div>
    <label>페르소나<select aria-label="시작 페르소나" value={persona} onChange={e => setPersona(e.target.value)} disabled={locked}><option value="">페르소나 없음</option>{contents.filter(item => item.kind === 'persona'||item.hasPackage||item.package).map(item => <option key={refValue(item)} value={refValue(item)}>{item.title}</option>)}</select></label>
    <label>프롬프트<select aria-label="시작 프롬프트" value={prompt} disabled={locked} onChange={e=>{setPrompt(e.target.value);setCombination('');}}><option value="">기본 프롬프트</option>{prompts.filter(p=>p.role==='main').map(p=><option value={refValue(p)} key={refValue(p)}>{p.title}</option>)}</select></label>
    {prompt&&<label>창작 프리셋<select aria-label="시작 옵션 조합" value={combination} disabled={locked} onChange={e=>setCombination(e.target.value)}><option value="">프롬프트 기본값</option>{combinations.filter(c=>refValue(c.prompt)===prompt).map(c=><option value={refValue(c)} key={refValue(c)}>{c.title}</option>)}</select></label>}
    <fieldset className="start-models"><legend>본문과 한국어 번역</legend>
      <label>본문 모델<select aria-label="시작 본문 모델" value={models.main} onChange={event => setModels(value => ({ ...value, main: event.target.value }))} disabled={locked}><option value="">검사용 모의 생성 · 실제 모델 없음</option>{models.main && !choices.some(item => item.id === models.main) && <option value={models.main} disabled>이전 선택 · 연결 확인 또는 재선택 필요</option>}{choices.map(item => <option key={item.id} value={item.id}>{modelLabel(item, library)}</option>)}</select></label>
      <label>한국어 번역 모델<select aria-label="시작 번역 모델" value={models.translation} onChange={event => setModels(value => ({ ...value, translation: event.target.value }))} disabled={locked}><option value="">검사용 모의 번역 · 실제 모델 없음</option>{models.translation && !choices.some(item => item.id === models.translation) && <option value={models.translation} disabled>이전 선택 · 연결 확인 또는 재선택 필요</option>}{choices.map(item => <option key={item.id} value={item.id}>{modelLabel(item, library)}</option>)}</select></label>
      <small>선택한 모델은 다음 채팅에도 제안해요. 채팅을 만든 뒤 장면을 보내면 본문을 생성해요. 번역은 번역 보기를 눌렀을 때 시작해요.</small>
    </fieldset>
    <label>채팅 이름 <small>비워 두면 자동으로 정해요</small><input aria-label="새 채팅 이름" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} disabled={locked}/></label>
    {error && <p className="error" role="alert">{error}{created.current && ' 채팅은 하나만 만들었어요. 설정 저장만 다시 시도해요.'}</p>}
    <button disabled={busy || uncertain.current || !bot}>{busy ? '채팅을 준비하는 중…' : created.current ? '설정 저장 다시 시도' : '채팅 만들기'}</button>
  </form>;
}
