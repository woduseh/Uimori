import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Chat, ChatDetail, Run, Source } from '../core/types.js';
import type { Content, Library } from '../core/product.js';
import { api, ApiError } from './api.js';
import { refValue } from './LibraryPanel.js';

function initialView() {
  const params = new URLSearchParams(location.search); const chat = params.get('chat') || '';
  return { chat, branch: params.get('branch') || '', source: params.get('source') || '' };
}
function ancestry(sources: Source[], head: string | null) {
  const byId = new Map(sources.map(source => [source.id, source])); const seen = new Set<string>(); const result: Source[] = [];
  while (head && !seen.has(head)) { seen.add(head); const source = byId.get(head); if (!source) break; result.unshift(source); head = source.parentRevision; }
  return result;
}
type RunPayload = { request: string; expectedRevision: string | null; expectedSettingsRevision: number; branchId?: string; expectedProfileRevision?: number };
type PendingCommand = { payload: string; id: string };
function readCommand(key: string): { record: PendingCommand; payload: RunPayload } | null {
  try {
    const record = JSON.parse(sessionStorage.getItem(key) || 'null') as PendingCommand | null;
    if (!record || typeof record.id !== 'string' || !record.id || typeof record.payload !== 'string') return null;
    const payload = JSON.parse(record.payload) as RunPayload;
    if (!payload || typeof payload.request !== 'string' || !payload.request.trim() || !(payload.expectedRevision === null || typeof payload.expectedRevision === 'string') || !Number.isInteger(payload.expectedSettingsRevision)) return null;
    if (payload.branchId !== undefined && typeof payload.branchId !== 'string' || payload.expectedProfileRevision !== undefined && !Number.isInteger(payload.expectedProfileRevision)) return null;
    return { record, payload };
  } catch { return null; }
}
function clearCommand(key: string, id: string) {
  if (readCommand(key)?.record.id === id) sessionStorage.removeItem(key);
}
function definiteRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

type Position = { source: string; anchor: string; offset: number; top: number };
export function useStory() {
  const [chats,setChats] = useState<Chat[]>([]); const [selected,setSelected] = useState(() => initialView().chat);
  const [viewedBranch,setViewedBranch] = useState(() => initialView().branch); const [readSource,setReadSource] = useState(() => initialView().source);
  const [loadedDetail,setDetail] = useState<ChatDetail|null>(null); const [library,setLibrary] = useState<Library|null>(null);
  const detail = loadedDetail?.chat.id === selected ? loadedDetail : null;
  const [archivedContents,setArchivedContents] = useState<Content[]>([]);
  const [draft,setDraft] = useState(''); const [error,setError] = useState(''); const [notice,setNotice] = useState('');
  const [submitting,setSubmitting] = useState<string[]>([]); const submitLocks = useRef(new Set<string>());
  const [connected,setConnected] = useState(false); const [destination,setDestination] = useState<'story'|'library'>('story');
  const [profileDirty,setProfileDirty] = useState(false); const [quickBusy,setQuickBusy] = useState(false);
  const reader = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  const current = useRef(selected); const currentView = useRef(''); const currentDraftKey = useRef(''); const refreshVersion = useRef(0); const restoredView = useRef('');
  // A completed server operation may navigate only while its original viewing intent is current.
  // Increment on every navigation, including A -> B -> A and changes within the same story.
  const navigationEpoch = useRef(0);
  const refresh = useCallback(async (id: string) => {
    if (current.current !== id) return; const version = ++refreshVersion.current; const value = await api<ChatDetail>(`/chats/${id}`);
    if (current.current === id && refreshVersion.current === version) { setDetail(value); setChats(old => old.map(chat => chat.id === id ? value.chat : chat)); }
  }, []);
  current.current = selected;
  const loadChats = useCallback(async () => setChats(await api<Chat[]>('/chats')), []);
  const loadLibrary = useCallback(async () => setLibrary(await api<Library>('/library')), []);
  useEffect(() => { void Promise.all([loadChats(),loadLibrary()]).catch(e => setError(e.message)); }, [loadChats,loadLibrary]);
  useEffect(() => {
    setDetail(null); setError(''); setNotice(''); setConnected(false); setProfileDirty(false); setArchivedContents([]);
    if (!selected) return; let alive = true; let timer: ReturnType<typeof setTimeout>|undefined;
    void refresh(selected).catch(e => { if (alive) setError(e.message); });
    const stream = new EventSource(`/api/chats/${selected}/events`);
    stream.onopen = () => { if (alive) setConnected(true); }; stream.onerror = () => { if (alive) setConnected(false); };
    // Batch event bursts; refreshVersion still rejects out-of-order HTTP responses.
    stream.onmessage = () => { if (!alive || timer) return; timer = setTimeout(() => { timer = undefined; if (alive) void refresh(selected).catch(e => { if (alive) setError(e.message); }); },60); };
    return () => { alive = false; clearTimeout(timer); stream.close(); };
  },[selected,refresh]);
  useEffect(() => {
    let alive = true; if (!detail?.profile || !library) return;
    const missing = detail.profile.attachments.filter(ref => !library.contents.some(item => refValue(item) === refValue(ref)));
    void Promise.all(missing.map(ref => api<Content>(`/revisions/content/${ref.id}/${ref.revision}`))).then(items => { if (alive) setArchivedContents(items); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  },[detail?.profile,library]);
  const viewKey = `${selected}:${viewedBranch}`; const draftKey = `draft:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`; currentDraftKey.current = draftKey; currentView.current = viewKey;
  const savePosition = useCallback(() => {
    const node = reader.current; if (!node || restoredView.current !== viewKey || !selected) return;
    const box = node.getBoundingClientRect(); const blocks = [...node.querySelectorAll<HTMLElement>('[data-block-anchor]')].filter(item => item.offsetParent !== null);
    const block = blocks.find(item => item.getBoundingClientRect().bottom > box.top+12);
    const position: Position = { source: block?.closest('[data-source-id]')?.getAttribute('data-source-id') || '',anchor: block?.dataset.blockAnchor?.split(' ')[0] || '',offset: block ? block.getBoundingClientRect().top-box.top : 0,top: node.scrollTop };
    sessionStorage.setItem(`reading:${viewKey}`,JSON.stringify(position));
  },[selected,viewKey]);
  useLayoutEffect(() => {
    setDraft(sessionStorage.getItem(draftKey) || '');
    const cursor = JSON.parse(sessionStorage.getItem(`cursor:${draftKey}`) || 'null') as {start:number;end:number}|null;
    const frame = requestAnimationFrame(() => { if (cursor && currentDraftKey.current === draftKey) input.current?.setSelectionRange(cursor.start,cursor.end); });
    return () => cancelAnimationFrame(frame);
  },[draftKey]);
  useEffect(() => { const before = () => savePosition(); addEventListener('pagehide',before); return () => { savePosition(); removeEventListener('pagehide',before); }; },[savePosition]);
  function rememberCursor() { const node = input.current; if (node) sessionStorage.setItem(`cursor:${draftKey}`,JSON.stringify({start:node.selectionStart,end:node.selectionEnd})); }
  function editDraft(value: string) { setDraft(value); sessionStorage.setItem(draftKey,value); }
  const branch = detail?.branches?.find(item => item.id === viewedBranch) ?? detail?.branches?.find(item => item.default);
  const sources = useMemo(() => detail ? branch ? ancestry(detail.sources,branch.headRevision) : detail.sources : [],[detail,branch]);
  const visibleRuns = detail?.runs.filter(run => !branch || !run.snapshot.branchId && branch.default || run.snapshot.branchId === branch.id) ?? [];
  useLayoutEffect(() => {
    if (!detail || destination !== 'story' || restoredView.current === viewKey || !reader.current) return;
    const node = reader.current;
    const saved = JSON.parse(sessionStorage.getItem(`reading:${viewKey}`) || 'null') as Position | null;
    const frame = requestAnimationFrame(() => {
      if (current.current !== selected || currentView.current !== viewKey || reader.current !== node) return;
      const sourceTarget = readSource ? document.getElementById(`source-${readSource}`) : null;
      if (sourceTarget && node.contains(sourceTarget)) node.scrollTop += sourceTarget.getBoundingClientRect().top - node.getBoundingClientRect().top;
      else {
        const block = saved?.anchor ? [...node.querySelectorAll<HTMLElement>('[data-block-anchor]')].find(item => item.offsetParent !== null && item.closest('[data-source-id]')?.getAttribute('data-source-id') === saved.source && item.dataset.blockAnchor?.split(' ').includes(saved.anchor)) : null;
        if (block && saved) node.scrollTop += block.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
        else node.scrollTop = saved?.top || 0;
      }
      restoredView.current = viewKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [detail, selected, viewKey, readSource, destination]);
  const setViewUrl = (chat:string,branchId='',source='') => { const params=new URLSearchParams({chat}); if(branchId)params.set('branch',branchId); if(source)params.set('source',source); history.pushState(null,'',`?${params}`); };
  const select = (id:string) => { navigationEpoch.current++; savePosition(); rememberCursor(); const target=sessionStorage.getItem(`branch:${id}`)||''; setViewUrl(id,target); setSelected(id); setViewedBranch(target); setReadSource(''); setDestination('story'); restoredView.current=''; };
  const chooseBranch = (id:string) => { navigationEpoch.current++; savePosition(); rememberCursor(); setViewUrl(selected,id); sessionStorage.setItem(`branch:${selected}`,id); setViewedBranch(id); setReadSource(''); restoredView.current=''; };
  const chooseSource = (id: string) => {
    navigationEpoch.current++; savePosition(); setReadSource(id); setViewUrl(selected, viewedBranch, id);
    if (!id) return;
    const node = reader.current; const chosenView = viewKey;
    requestAnimationFrame(() => {
      const target = document.getElementById(`source-${id}`);
      if (currentView.current !== chosenView || reader.current !== node || !node || !target || !node.contains(target)) return;
      node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
    });
  };
  useEffect(() => { const onPop=() => { navigationEpoch.current++; savePosition(); rememberCursor(); const view=initialView(); setSelected(view.chat);setViewedBranch(view.branch);setReadSource(view.source);setDestination('story');restoredView.current=''; }; addEventListener('popstate',onPop);return () => removeEventListener('popstate',onPop); },[savePosition]);
  function showLibrary(){navigationEpoch.current++;savePosition();setDestination('library');restoredView.current='';}
  async function generate() {
    if (!detail || detail.chat.id !== selected || submitLocks.current.has(viewKey) || sessionStorage.getItem(`pending-profile:${selected}`)) return;
    const chat = detail.chat; const sentKey = draftKey; const sentView = viewKey;
    const commandKey = `command:${chat.id}${viewedBranch ? `:${viewedBranch}` : ''}`;
    const previous = readCommand(commandKey);
    if (!previous && !draft.trim()) return;
    // An uncertain request keeps its original snapshot as well as its key.
    // A newer draft is never silently sent after recovering that earlier request.
    const payload: RunPayload = previous?.payload ?? { request: draft, expectedRevision: branch ? branch.headRevision : chat.headRevision, expectedSettingsRevision: chat.settingsRevision, ...(viewedBranch && branch ? { branchId: branch.id } : {}), ...(detail.profile ? { expectedProfileRevision: detail.profile.revision } : {}) };
    const sentDraft = payload.request;
    const idempotencyKey = previous?.record.id ?? crypto.randomUUID();
    sessionStorage.setItem(commandKey, JSON.stringify({ payload: JSON.stringify(payload), id: idempotencyKey }));
    submitLocks.current.add(sentView); setSubmitting([...submitLocks.current]); setError(''); setNotice('');
    let accepted = false;
    try {
      await api<Run>(`/chats/${chat.id}/runs`, { ...payload, idempotencyKey });
      accepted = true;
      clearCommand(commandKey, idempotencyKey);
      if (sessionStorage.getItem(sentKey) === sentDraft) {
        sessionStorage.removeItem(sentKey);
        if (currentDraftKey.current === sentKey) setDraft('');
      }
      if (currentView.current === sentView) setNotice(previous
        ? sessionStorage.getItem(sentKey) ? '이전 요청의 수락을 확인했어요. 새로 작성한 초안은 남겨두었어요.' : '이전 요청의 수락을 확인했어요.'
        : '요청을 받았어요. 서버에서 이어서 만들어요.');
    } catch (error) {
      if (definiteRejection(error) && (!previous || error instanceof ApiError && error.status === 409)) clearCommand(commandKey, idempotencyKey);
      if (currentView.current === sentView) setError(error instanceof Error ? error.message : '요청의 수락 여부를 확인하지 못했어요.');
    }
    // Failure to refresh an accepted run must not turn it into a pending command.
    try { await refresh(chat.id); }
    catch (error) { if (accepted && currentView.current === sentView) setError('요청은 수락됐어요. 화면을 다시 불러오지 못해 연결을 확인하고 있어요.'); }
    finally { submitLocks.current.delete(sentView); setSubmitting([...submitLocks.current]); }
  }
  const forkLocks = useRef(new Set<string>());
  const [forking, setForking] = useState<string[]>([]);
  async function fork(sourceId: string) {
    const chatId = selected; const epoch = navigationEpoch.current;
    const lock = `${chatId}:${sourceId}`; const key = `fork-command:${lock}`;
    if (!detail?.sources.some(source => source.id === sourceId) || forkLocks.current.has(lock)) return;
    forkLocks.current.add(lock); setForking([...forkLocks.current]);
    const idempotencyKey = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, idempotencyKey); setError('');
    try {
      const next = await api<Chat>(`/chats/${chatId}/fork`, { fromRevision: sourceId, idempotencyKey });
      if (sessionStorage.getItem(key) === idempotencyKey) sessionStorage.removeItem(key);
      setChats(current => [next, ...current.filter(chat => chat.id !== next.id)]);
      if (current.current === chatId && navigationEpoch.current === epoch) select(next.id);
    } catch (error) {
      if (definiteRejection(error) && sessionStorage.getItem(key) === idempotencyKey) sessionStorage.removeItem(key);
      if (current.current === chatId && navigationEpoch.current === epoch) setError(error instanceof Error ? error.message : '이야기 복사를 확인하지 못했어요. 다시 누르면 같은 요청을 확인해요.');
    } finally { forkLocks.current.delete(lock); setForking([...forkLocks.current]); }
  }
  const quickLock = useRef(false);
  async function quickChange(kind: 'preset' | 'persona' | 'model', value: string) {
    if (!detail?.profile || detail.chat.id !== selected || !library || profileDirty || quickLock.current) return;
    const chatId = detail.chat.id; const profile = detail.profile;
    quickLock.current = true; setQuickBusy(true); setError(''); setNotice('');
    try {
      if (kind === 'preset') {
        const preset = library.presets.find(item => refValue(item) === value);
        if (!preset) return;
        await api(`/chats/${chatId}/preset`, { expectedRevision: profile.revision, presetId: preset.id, presetRevision: preset.revision });
      } else {
        let contents = [...library.contents, ...archivedContents];
        if (kind === 'persona') {
          const missing = profile.attachments.filter(ref => !contents.some(item => refValue(item) === refValue(ref)));
          // Resolve pinned revisions before classifying and replacing a persona.
          contents = [...contents, ...await Promise.all(missing.map(ref => api<Content>(`/revisions/content/${ref.id}/${ref.revision}`)))];
        }
        const persona = contents.find(item => item.kind === 'persona' && refValue(item) === value);
        const model = library.models.find(item => refValue(item) === value);
        if (kind === 'persona' && value && !persona || kind === 'model' && value && !model) throw new Error('선택한 설정을 찾지 못했어요. 목록을 다시 확인해 주세요.');
        const attachments = kind === 'persona' ? [...profile.attachments.filter(ref => !contents.some(item => item.kind === 'persona' && refValue(item) === refValue(ref))), ...(persona ? [{ id: persona.id, revision: persona.revision }] : [])] : profile.attachments;
        const routes = kind === 'model' ? { ...profile.routes, main: model ? { id: model.id, revision: model.revision } : null } : profile.routes;
        await api(`/chats/${chatId}/profile`, { expectedRevision: profile.revision, attachments, creative: profile.creative, routes, image: profile.image }, 'PUT');
      }
      if (current.current === chatId) setNotice('다음 요청에 적용할 설정을 저장했어요.');
      await refresh(chatId);
    } catch (error) {
      if (current.current === chatId) setError(error instanceof Error ? error.message : '설정을 저장하지 못했어요.');
      await refresh(chatId).catch(() => undefined);
    } finally { quickLock.current = false; setQuickBusy(false); }
  }
  const active=visibleRuns.find(run=>run.status==='queued'||run.status==='running'||run.status==='waiting_for_state');
  const allContents=[...library?.contents??[],...archivedContents];
  const attachmentsReady = !!detail?.profile && detail.profile.attachments.every(ref => allContents.some(item => refValue(item) === refValue(ref)));
  const pendingRequest = selected ? readCommand(`command:${selected}${viewedBranch ? `:${viewedBranch}` : ''}`)?.payload.request ?? null : null;
  const attached=allContents.filter(item=>detail?.profile?.attachments.some(ref=>refValue(ref)===refValue(item)));
  const bot=attached.find(item=>item.kind==='bot');const persona=attached.find(item=>item.kind==='persona');
  const preset=library?.presets.find(item=>JSON.stringify(item.controls)===JSON.stringify(detail?.profile?.creative));
  const profileAsset=detail?.assets?.find(asset=>asset.allowedUse!=='inline');
  const tasks=detail?detail.runs.filter(run=>['running','queued','waiting_for_state'].includes(run.status)).length+detail.jobs.filter(job=>['running','queued'].includes(job.status)).length:0;
  const pendingProfile=!!selected&&!!sessionStorage.getItem(`pending-profile:${selected}`);
  return {chats,selected,viewedBranch,readSource,detail,library,draft,error,notice,connected,destination,profileDirty,quickBusy,reader,input,viewKey,active,allContents,bot,persona,preset,profileAsset,tasks,pendingProfile,branch,sources,visibleRuns,submitting,attachmentsReady,pendingRequest,forking,
    setError,setNotice,setProfileDirty,refresh,loadChats,loadLibrary,savePosition,rememberCursor,editDraft,select,chooseBranch,chooseSource,showLibrary,generate,fork,quickChange};
}
export type StoryState=ReturnType<typeof useStory>;
