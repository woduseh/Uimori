import { createHash } from 'node:crypto';
import { attachMainHostContext } from './main-request.js';
import { buildMainInput } from '../core/provider.js';
import { compilePromptProgram, type PromptHistoryMessage, type PromptProgram, type PromptValue } from '../core/prompt-program.js';
import { hiddenLogicalHistoryForRequest } from '../core/hidden-context.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import { nativeInstructions } from '../core/native-context.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';

/** Pair each exact source version with its actual user request; never infer roles from prose. */
export function captureLogicalHistory(store:Store,snapshot:RunSnapshot):PromptHistoryMessage[]{
  const entries=snapshot.story?.memory?.plan.recentHistory??snapshot.history;
  return entries.flatMap(entry=>{
    const source=entry.contentHash?store.sourceAtHash(entry.revision,entry.contentHash):store.sourceOriginal(entry.revision);
    const row=store.db.prepare('SELECT request FROM runs WHERE id=?').get(source.runId) as {request:string}|undefined;
    if(!row)throw new Error('PROMPT_HISTORY_REQUEST_MISSING');
    const provenance={sourceRevision:entry.revision,sourceHash:entry.contentHash??source.hash,runId:source.runId};
    return [{id:`request:${entry.revision}`,role:'user' as const,text:row.request,...provenance},{id:`source:${entry.revision}`,role:'assistant' as const,text:entry.text,...provenance}];
  });
}
export function promptContext(snapshot:RunSnapshot){
  const input=buildMainInput(snapshot);const contents=snapshot.profile?.contents??[];
  const content=(kind:string)=>contents.filter(c=>c.kind===kind&&(kind!=='persona'||snapshot.profile?.creative.personaReference!==false)).map(c=>c.text).join('\n\n');
  const slots:Record<string,string>={
    char:snapshot.nativeBot?.package.title??contents.find(c=>c.kind==='bot')?.title??'Character',bot:[content('bot'),nativeInstructions(snapshot.nativeBot)].filter(Boolean).join('\n\n'),description:[content('bot'),nativeInstructions(snapshot.nativeBot)].filter(Boolean).join('\n\n'),persona:content('persona'),
    lore:[...contents.filter(c=>['lore','canon','skill'].includes(c.kind)&&(c.loading==='pinned'||c.kind==='canon')).map(c=>c.text),...snapshot.resources.filter(r=>r.id.startsWith('native:')&&r.loading==='pinned').map(r=>r.text)].join('\n\n'),
    memory:input.memory?JSON.stringify(input.memory):'',state:input.state?JSON.stringify(input.state):'',globalNote:'',authorNote:'',postEverything:'',slot:'',
    controls:JSON.stringify(input.controls??{}),catalog:JSON.stringify(input.catalog),source:'',
  };
  slots.lorebook=slots.lore;slots.authornote=slots.authorNote;
  const history=[...hiddenLogicalHistoryForRequest(snapshot,snapshot.logicalHistory??[]),{id:'current-input',role:'user' as const,text:snapshot.request,current:true}];
  const preset=snapshot.profile?.promptPresets?.main;
  return {slots,history,values:preset?snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values:undefined};
}
export function compileSnapshotPrompt(snapshot:RunSnapshot,program?:PromptProgram,values?:Record<string,PromptValue>):RunSnapshot{
  const selected=program??snapshot.profile?.promptPresets?.main?.program??(snapshot.hiddenStory?{version:1 as const,controls:[],blocks:[{id:'legacy-instructions',title:'Role instructions',kind:'message' as const,role:'system' as const,template:[{kind:'text' as const,text:snapshot.profile?.promptPresets?.main?.text??DEFAULT_MAIN_PROMPT}]},{id:'history',title:'Conversation',kind:'history' as const,from:0,to:'end' as const}]}:undefined);
  if(!selected)return snapshot;
  if(snapshot.story?.waiting)return snapshot;
  const context=promptContext(snapshot);const promptCompilation=compilePromptProgram(selected,{...context,...(values?{values}:{})});
  if(snapshot.hiddenStory){
    const hidden=snapshot.hiddenStory;let index=promptCompilation.messages.findIndex(m=>hidden.insertion==='before-history'?m.provenance.origin!=='prompt':m.provenance.origin==='current');
    if(index<0)throw new Error('HIDDEN_INSERTION_POINT_MISSING');
    promptCompilation.messages.splice(index,0,...structuredClone(hidden.messages));
    promptCompilation.trace.push(...hidden.messages.map(m=>({blockId:m.provenance.blockId,included:true,messageIds:[m.id]})));
    promptCompilation.warnings.push(...hidden.issues);
  }
  return attachMainHostContext({...snapshot,promptCompilation});
}
export const promptSnapshotHash=(snapshot:RunSnapshot)=>createHash('sha256').update(JSON.stringify(snapshot.promptCompilation??null)).digest('hex');
