import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { createHash } from 'node:crypto';
import { attachMainHostContext } from './main-request.js';
import { buildMainInput } from '../core/provider.js';
import { compilePromptProgram, type PromptHistoryMessage, type PromptProgram, type PromptValue, type PromptTemplate } from '../core/prompt-program.js';
import { hiddenLogicalHistoryForRequest } from '../core/hidden-context.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import { nativeInstructions } from '../core/native-context.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { packageSlots, compiledPackages } from '../core/package-context.js';
import { executionContext } from '../core/execution-context.js';

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
    references:JSON.stringify(input.pinnedSources?.length ? {pinnedSources:input.pinnedSources} : {facts:input.facts}),controls:JSON.stringify(input.controls??{}),catalog:JSON.stringify(input.catalog),source:'',
  };
  const packages = packageSlots(snapshot, 'main');
  if (packages.char) slots.char = packages.char;
  for (const key of ['bot','persona','lore'] as const) if (packages[key]) slots[key] = [slots[key],packages[key]].filter(Boolean).join('\n\n');
  slots.description = slots.bot;
  slots.lorebook=slots.lore;slots.authornote=slots.authorNote;
  for (const instruction of compiledPackages(snapshot,'main').flatMap(p=>p.instructions)) if (instruction.position) slots[instruction.position] = [slots[instruction.position],instruction.text].filter(Boolean).join('\n\n');
  const history=[...hiddenLogicalHistoryForRequest(snapshot,snapshot.logicalHistory??input.history.map(entry=>({id:`source:${entry.revision}`,role:'assistant' as const,text:entry.text,sourceRevision:entry.revision,...(entry.contentHash?{sourceHash:entry.contentHash}:{})}))),{id:'current-input',role:'user' as const,text:snapshot.request,current:true}];
  const preset=snapshot.profile?.promptPresets?.main;
  return {slots,history,runtime:executionContext(snapshot),values:preset?snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values:undefined};
}
export function compileSnapshotPrompt(snapshot:RunSnapshot,program?:PromptProgram,values?:Record<string,PromptValue>):RunSnapshot{
  if(snapshot.story?.waiting)return snapshot;
  const selected=program??snapshot.profile?.promptPresets?.main?.program??createDefaultPromptProgram(DEFAULT_MAIN_PROMPT);
  const positioned=compiledPackages(snapshot,'main').flatMap(p=>p.instructions).filter(n=>n.position);
  if(positioned.length){
    const declared=new Set<string>();
    const walk=(nodes:PromptTemplate)=>{for(const node of nodes){if(node.kind==='slot')declared.add(node.name);else if(node.kind==='if'){walk(node.then);walk(node.else??[]);}else if(node.kind==='each'){walk(node.body);walk(node.else??[]);}else if(node.kind==='let')walk(node.body);}};
    for(const block of selected?.blocks??[]){if(block.kind==='slot')declared.add(block.slot);if((block.kind==='slot'||block.kind==='message')&&block.template)walk(block.template);}
    for(const instruction of positioned)if(!declared.has(instruction.position!))throw new Error(`PACKAGE_INSERTION_SLOT_MISSING (${instruction.position})`);
  }
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
