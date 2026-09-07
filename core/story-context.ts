import { readMemorySource, searchMemorySources, searchMemoryEntries, visibleMemoryEntries, type MemoryEntry } from './memory.js';
import type { RunSnapshot, ToolEvent } from './types.js';
import type { ToolAction } from './provider.js';
import { hiddenMemoryEntryAllowed, hiddenReadRange, hiddenSourceRequestView } from './hidden-context.js';

export const STORY_READ_NAMES = ['memory.search','memory.read','story.search','story.read'];
export const STORY_RESULT_MAX_BYTES = 24000;
const PROVENANCE_MAX_BYTES = 3000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Evidence bodies are retrieved with story.read; memory metadata keeps the exact source coordinates. */
function provenance(entry: MemoryEntry, sourceOffset = 0) {
  const base: Record<string, unknown> = { id: entry.id, chatId: entry.chatId, kind: entry.kind, atRevision: entry.atRevision, atHash: entry.atHash };
  if(entry.knowledge)base.knowledge=entry.knowledge;
  if (entry.kind === 'character-belief' || entry.kind === 'hypothesis') base.actor = entry.actor;
  if (entry.kind === 'author-canon') base.declaration = { author: entry.declaration.author };
  const sources = entry.kind === 'author-canon' ? [] : entry.sources;
  if (sourceOffset > sources.length) throw new Error('SOURCE_OFFSET_INVALID');
  const refs: { revision: string; hash: string; start: number; end: number }[] = [];
  if (entry.kind !== 'author-canon') base.sources = refs;
  if (bytes(base) > PROVENANCE_MAX_BYTES) throw new Error('PROVENANCE_TOO_LARGE');
  for (const ref of sources.slice(sourceOffset, sourceOffset + 12)) {
    refs.push({ revision: ref.revision, hash: ref.hash, start: ref.start, end: ref.end });
    if (bytes(base) > PROVENANCE_MAX_BYTES) { refs.pop(); break; }
  }
  if (sourceOffset < sources.length && !refs.length) throw new Error('PROVENANCE_TOO_LARGE');
  const next = sourceOffset + refs.length;
  return { entry: base, sourceCount: sources.length, sourceOffset, provenanceTruncated: next < sources.length, sourceContinuation: next < sources.length ? { id: entry.id, sourceOffset: next } : null };
}

function boundedRead<T>(start: number, desiredEnd: number, build: (end: number) => T): T {
  let result = build(desiredEnd);
  if (bytes(result) <= STORY_RESULT_MAX_BYTES) return result;
  let low = start; let high = desiredEnd;
  if (bytes(build(start)) > STORY_RESULT_MAX_BYTES) throw new Error('RESULT_METADATA_TOO_LARGE');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(build(middle)) <= STORY_RESULT_MAX_BYTES) low = middle; else high = middle - 1;
  }
  if (low === start && desiredEnd > start) throw new Error('RESULT_METADATA_TOO_LARGE');
  return build(low);
}

function boundedSearch(total: number, offset: number, candidates: unknown[]) {
  const results: unknown[] = [];
  const result = () => ({ results, total, nextOffset: offset + results.length < total ? offset + results.length : null, ...(results.length < candidates.length ? { diagnostics: ['RESULT_BYTE_BUDGET_PAGE_LIMIT'] } : {}) });
  for (const candidate of candidates) {
    results.push(candidate);
    if (bytes(result()) > STORY_RESULT_MAX_BYTES) { results.pop(); break; }
  }
  while (results.length && bytes(result()) > STORY_RESULT_MAX_BYTES) results.pop();
  if (candidates.length && !results.length) throw new Error('RESULT_METADATA_TOO_LARGE');
  return result();
}

/** Search only inside a kept source span: a query cannot cross an omitted hidden region. */
function searchHiddenSources(snapshot:RunSnapshot,query:string,offset:number,limit:number){
  if(!query.trim())throw new Error('QUERY_REQUIRED');
  const matches=snapshot.history.flatMap(item=>{
    const view=hiddenSourceRequestView(snapshot,item.revision);
    for(const range of view.keptRanges){const match=item.text.slice(range.start,range.end).indexOf(query);if(match<0)continue;
      const start=Math.max(range.start,range.start+match-60),end=Math.min(range.end,start+240),quote=item.text.slice(start,end);
      return[{revision:item.revision,text:quote,source:{revision:item.revision,hash:view.sourceHash,start,end,quote},truncated:start>0||end<item.text.length,nextOffset:end<item.text.length?end:null}];
    }return[];
  });
  return{results:matches.slice(offset,offset+limit),total:matches.length,nextOffset:offset+limit<matches.length?offset+limit:null};
}

export function executeStoryRead(snapshot:RunSnapshot,action:ToolAction,allowWithoutMemory=false):ToolEvent {
  const denied=(code:string):ToolEvent=>({callId:action.callId,name:action.name,args:{},result:{code},denied:true});
  if((!snapshot.story?.memory && !allowWithoutMemory) || !STORY_READ_NAMES.includes(action.name))return denied('TOOL_NOT_ALLOWED');
  const scope={chatId:snapshot.chatId,history:snapshot.history};const memory=snapshot.story?.memory;
  const args=action.args;
  const search=action.name.endsWith('.search');
  if(Object.keys(args).some(key=>!(search?['query','offset','limit']:action.name==='memory.read'?['id','offset','limit','sourceOffset']:['id','offset','limit']).includes(key)))return denied('INVALID_ARGUMENTS');
  if(args.offset!==undefined&&(!Number.isSafeInteger(args.offset)||Number(args.offset)<0)||args.limit!==undefined&&(!Number.isSafeInteger(args.limit)||Number(args.limit)<1))return denied('INVALID_ARGUMENTS');
  const offset=args.offset===undefined?0:Number(args.offset);const limit=args.limit===undefined?(search?20:4096):Number(args.limit);
  if(limit>(search?100:16000))return denied('INVALID_ARGUMENTS');
  try {
    const entries=visibleMemoryEntries(scope,memory?.entries??[]).filter(entry=>hiddenMemoryEntryAllowed(snapshot,entry));
    let result:unknown;
    if(search){
      if(typeof args.query!=='string'||args.query.length>512)return denied('INVALID_ARGUMENTS');
      if(action.name==='story.search'){
        const found=snapshot.hiddenStory?searchHiddenSources(snapshot,args.query,offset,limit):searchMemorySources(scope,{query:args.query,offset,limit});
        result=boundedSearch(found.total,offset,found.results.map(({source:{quote:_quote,...source},...item})=>({...item,source})));
      }
      else {
        const found=searchMemoryEntries(scope,entries,args.query,offset,limit);
        result=boundedSearch(found.total,offset,found.results.map(entry=>{const {entry:metadata,...page}=provenance(entry);return {...metadata,...page,excerpt:entry.text.slice(0,240),totalChars:entry.text.length};}));
      }
    }else{
      if(typeof args.id!=='string'||args.id.length>200)return denied('INVALID_ARGUMENTS');
      if(action.name==='story.read'){
        const page=readMemorySource(scope,{revision:args.id,offset,limit});
        const {quote:_quote,...source}=page.source;
        result=boundedRead(offset,page.source.end,end=>{const filtered=snapshot.hiddenStory?hiddenReadRange(snapshot,args.id as string,offset,end):undefined;return{text:filtered?.text??page.text.slice(0,end-offset),source:{...source,end},...(filtered?{keptRanges:filtered.ranges,excludedRanges:filtered.excluded.map(item=>item.range),rangeSemantics:'source coordinates; text concatenates keptRanges'}:{}),totalChars:page.totalChars,truncated:end<page.totalChars,nextOffset:end<page.totalChars?end:null};});
      }
      else{
        const entry=entries.find(item=>item.id===args.id);
        if(!entry||offset>entry.text.length)return denied('RESOURCE_UNAVAILABLE');
        if(args.sourceOffset!==undefined&&(!Number.isSafeInteger(args.sourceOffset)||Number(args.sourceOffset)<0))return denied('INVALID_ARGUMENTS');
        const metadata=provenance(entry,args.sourceOffset===undefined?0:Number(args.sourceOffset));
        result=boundedRead(offset,Math.min(entry.text.length,offset+limit),end=>({...metadata,text:entry.text.slice(offset,end),range:{start:offset,end},totalChars:entry.text.length,truncated:end<entry.text.length,nextOffset:end<entry.text.length?end:null}));
      }
    }
    return {...action,args:{...args,offset,limit},result,denied:false};
  }catch{return denied('RESOURCE_UNAVAILABLE');}
}
