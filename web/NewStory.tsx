import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../core/types.js';
import type { Content, CreativePreset, Library, ModelPreset } from '../core/product.js';
import { api } from './api.js';
import { refValue } from './LibraryPanel.js';
import { modelLabel } from './storyLabels.js';
import { completePendingStoryProfile, savePendingStoryProfile, type NewStoryProfileIntent } from './pendingStory.js';

type StorySelection = { title: string; bot: Content | null; persona: Content | null; preset: CreativePreset | null; main: ModelPreset | null; translation: ModelPreset | null; profile: NewStoryProfileIntent | null };

const modelsKey = 'uimori:new-story-models';
function availableModels(library: Library) {
  return library.models.filter(model => library.connections.some(connection => connection.id === model.connectionId && connection.enabled));
}
function rememberedModels(library: Library): { main: string; translation: string } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(modelsKey) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { main: '', translation: '' };
    const choices = saved as Record<string, unknown>;
    const available = availableModels(library);
    const restore = (role: string) => available.some(item => refValue(item) === choices[role]) ? String(choices[role]) : '';
    return { main: restore('main'), translation: restore('translation') };
  } catch { return { main: '', translation: '' }; }
}

export function NewStory({ library, initialBot, onCreated }: { library: Library; initialBot?: Content; onCreated: (chat: Chat) => Promise<void> }) {
  const [bot, setBot] = useState(initialBot ? refValue(initialBot) : '');
  const [persona, setPersona] = useState(''); const [preset, setPreset] = useState('');
  const [models, setModels] = useState(() => rememberedModels(library));
  const [title, setTitle] = useState(''); const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const created = useRef<Chat | null>(null); const uncertain = useRef(false);
  const submitted = useRef<StorySelection | null>(null); const creating = useRef(false); const profileRecorded = useRef(false);
  useEffect(() => { if (initialBot && !submitted.current) setBot(refValue(initialBot)); }, [initialBot]);
  function captureSelection(): StorySelection {
    const selectedBot = bot ? library.contents.find(item => item.kind === 'bot' && refValue(item) === bot) : null;
    const selectedPersona = persona ? library.contents.find(item => item.kind === 'persona' && refValue(item) === persona) : null;
    const selectedPreset = preset ? library.presets.find(item => refValue(item) === preset) : null;
    const available = availableModels(library);
    const main = models.main ? available.find(item => refValue(item) === models.main) : null;
    const translation = models.translation ? available.find(item => refValue(item) === models.translation) : null;
    if (models.main && !main || models.translation && !translation) throw new Error('선택한 모델을 사용할 수 없어요. 연결과 모델 목록을 확인한 뒤 다시 골라 주세요.');
    if (bot && !selectedBot || persona && !selectedPersona || preset && !selectedPreset) throw new Error('선택한 자료의 목록이 바뀌었어요. 봇, 페르소나와 프리셋을 다시 골라 주세요.');
    return structuredClone({
      title: title.trim() || (selectedBot ? `${selectedBot.title}의 이야기`.slice(0, 100) : '새로운 이야기'),
      bot: selectedBot ?? null, persona: selectedPersona ?? null, preset: selectedPreset ?? null, main: main ?? null, translation: translation ?? null,
      profile: selectedBot || selectedPersona || selectedPreset || main || translation ? {
        attachments: [selectedBot, selectedPersona].filter((item): item is Content => !!item).map(({ id, revision }) => ({ id, revision })),
        creative: selectedPreset?.controls ?? null,
        ...(main || translation ? { models: { main: main ? { id: main.id, revision: main.revision } : null, translation: translation ? { id: translation.id, revision: translation.revision } : null } } : {}),
      } : null,
    });
  }
  async function create() {
    if (creating.current) return;
    creating.current = true; setBusy(true); setError('');
    try {
      const selection = submitted.current ??= captureSelection();
      if (!created.current) {
        if (uncertain.current) throw new Error('이야기 생성 응답을 확인하지 못했어요. 목록을 새로 확인한 뒤 이어서 설정해 주세요. 중복 생성을 막기 위해 자동 재전송하지 않아요.');
        uncertain.current = true;
        created.current = await api<Chat>('/chats', { title: selection.title });
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
      localStorage.setItem(modelsKey, JSON.stringify({ main: selection.main ? refValue(selection.main) : '', translation: selection.translation ? refValue(selection.translation) : '' }));
      await onCreated(chat);
    } catch (err) { setError((err as Error).message); } finally { creating.current = false; setBusy(false); }
  }
  const frozen = submitted.current;
  const locked = busy || !!frozen;
  const frozenContents = [frozen?.bot, frozen?.persona].filter((item): item is Content => !!item);
  const contents = library.contents.map(item => frozenContents.find(selected => refValue(selected) === refValue(item)) ?? item);
  for (const item of frozenContents) if (!contents.some(current => refValue(current) === refValue(item))) contents.push(item);
  const presets = library.presets.map(item => frozen?.preset && refValue(frozen.preset) === refValue(item) ? frozen.preset : item);
  if (frozen?.preset && !presets.some(item => refValue(item) === refValue(frozen.preset!))) presets.push(frozen.preset);
  const choices = availableModels(library);
  for (const selected of [frozen?.main, frozen?.translation]) if (selected && !choices.some(item => refValue(item) === refValue(selected))) choices.push(selected);
  const bots = contents.filter(item => item.kind === 'bot' && `${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  return <form className="new-story" onSubmit={event => { event.preventDefault(); void create(); }}>
    <p className="muted">함께할 봇을 고르고, 첫 장면으로 시작해요.</p>
    <label>봇 찾기<input aria-label="시작할 봇 찾기" value={search} onChange={event => setSearch(event.target.value)} disabled={locked}/></label>
    <div className="bot-picker" role="group" aria-label="시작할 봇"><button type="button" className={`bot-option ${!bot ? 'chosen' : ''}`} aria-pressed={!bot} onClick={() => setBot('')} disabled={locked}>봇 없이 시작<small>직접 세계와 장면을 요청해요</small></button>{bots.map(item => <button type="button" key={refValue(item)} className={`bot-option ${bot === refValue(item) ? 'chosen' : ''}`} aria-pressed={bot === refValue(item)} onClick={() => setBot(refValue(item))} disabled={locked}><strong>{item.title}</strong><small>{item.description || '등록한 봇으로 이야기를 시작해요'}</small></button>)}</div>
    <label>페르소나<select aria-label="시작 페르소나" value={persona} onChange={e => setPersona(e.target.value)} disabled={locked}><option value="">페르소나 없음</option>{contents.filter(item => item.kind === 'persona').map(item => <option key={refValue(item)} value={refValue(item)}>{item.title}</option>)}</select></label>
    <label>창작 프리셋<select aria-label="시작 창작 프리셋" value={preset} onChange={e => setPreset(e.target.value)} disabled={locked}><option value="">기본 창작 제어</option>{presets.map(item => <option key={refValue(item)} value={refValue(item)}>{item.title}</option>)}</select></label>
    <fieldset className="start-models"><legend>본문과 한국어 번역</legend>
      <label>본문 모델<select aria-label="시작 본문 모델" value={models.main} onChange={event => setModels(value => ({ ...value, main: event.target.value }))} disabled={locked}><option value="">검사용 모의 생성 · 실제 모델 없음</option>{choices.map(item => <option key={refValue(item)} value={refValue(item)}>{modelLabel(item, library)}</option>)}</select></label>
      <label>한국어 번역 모델<select aria-label="시작 번역 모델" value={models.translation} onChange={event => setModels(value => ({ ...value, translation: event.target.value }))} disabled={locked}><option value="">검사용 모의 번역 · 실제 모델 없음</option>{choices.map(item => <option key={refValue(item)} value={refValue(item)}>{modelLabel(item, library)}</option>)}</select></label>
      <small>선택한 모델은 다음 이야기에도 제안해요. 이야기를 만든 뒤 장면을 보내면 본문 생성과 한국어 번역을 시작해요.</small>
    </fieldset>
    <label>이야기 이름 <small>비워 두면 자동으로 정해요</small><input aria-label="새 이야기 이름" value={title} maxLength={100} onChange={e => setTitle(e.target.value)} disabled={locked}/></label>
    {error && <p className="error" role="alert">{error}{created.current && ' 이야기는 하나만 만들었어요. 설정 저장만 다시 시도해요.'}</p>}
    <button disabled={busy || uncertain.current}>{busy ? '이야기를 준비하는 중…' : created.current ? '설정 저장 다시 시도' : '이야기 만들기'}</button>
  </form>;
}
