import type { ContentRef } from './product.js';
import { HiddenStoryError, HIDDEN_CONTROL_MAP, validateHiddenStoryConfig, type HiddenStoryConfig } from './hidden-story.js';
import { wireHiddenStoryInstructions, type HiddenConversion } from './hidden-story-converter.js';
import { compilePromptProgram, validatePromptProgram, type LogicalMessage } from './prompt-program.js';

export type HiddenStoryNativePackage = HiddenConversion & { id: string; revision: number; title: string; packageHash: string };
export type HiddenStorySelection = { module: ContentRef | null; config: HiddenStoryConfig; insertion?: 'before-current' | 'before-history' };
export type HiddenStoryRunSnapshot = { module: HiddenStoryNativePackage; config: HiddenStoryConfig; seed: string; choices: Record<string,string>; messages: LogicalMessage[]; insertion: 'before-current' | 'before-history'; issues: string[] };
const fail = (): never => { throw new HiddenStoryError('HIDDEN_NATIVE_PACKAGE_INVALID'); };
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,any> : fail();
const string = (v: unknown, max = 200): string => typeof v === 'string' && v.length <= max ? v : fail();
const list = (v: unknown, max: number): any[] => Array.isArray(v) && v.length <= max ? v : fail();

/** Closed declarative import: the runtime never executes Risu HTML, regex, Lua or CBS. */
export function validateHiddenConversion(value: unknown): HiddenConversion {
  if (JSON.stringify(value)?.length > 1_000_000) fail();
  const b = object(value), source = object(b.source);
  if (b.format !== 'uimori-hidden-story-v1' || b.status !== 'partial' || !/^[a-f0-9]{64}$/u.test(string(source.hash,64))) fail();
  const program = validatePromptProgram(b.program), nonsexualProgram = validatePromptProgram(b.nonsexualProgram);
  for (const p of [program,nonsexualProgram]) {
    if (p.controls.length !== 35 || p.controls.some(c => !HIDDEN_CONTROL_MAP.some(([,name,kind]) => c.id === `hidden.${name}` && c.type === kind))) fail();
    if (p.blocks.some(block => block.kind !== 'message' || block.role !== 'system' || !/^hidden\.lore\.\d+$/u.test(block.id))) fail();
  }
  const controlMap = list(b.controlMap,35).map(raw => { const r=object(raw); if(!HIDDEN_CONTROL_MAP.some(([key,name,kind])=>r.sourceKey===key&&r.nativeId===`hidden.${name}`&&r.sourceType===kind))fail(); return {sourceKey:r.sourceKey,nativeId:r.nativeId,sourceType:r.sourceType}; });
  if(controlMap.length!==35 || new Set(controlMap.map(c=>c.nativeId)).size!==35)fail();
  const picks = list(b.picks,100).map(raw=>{const r=object(raw);const slot=string(r.slot); if(!/^hidden\.pick\.\d+\.\d+$/u.test(slot))fail(); const choices=list(r.choices,20).map(v=>string(v,20));if(!choices.length||choices.some(v=>!['zero','one','two','three','four','five'].includes(v)))fail();return{slot,choices};});
  if(new Set(picks.map(p=>p.slot)).size!==picks.length)fail();
  const requiredSlots=list(b.requiredSlots,101).map(v=>string(v)); if(JSON.stringify(requiredSlots)!==JSON.stringify(['hidden.user',...picks.map(p=>p.slot)]))fail();
  const loreMapping=list(b.loreMapping,100).map(raw=>{const r=object(raw);if(!Number.isSafeInteger(r.sourceIndex)||r.sourceIndex<0||!Number.isFinite(r.insertOrder)||(r.depth!==null&&(!Number.isSafeInteger(r.depth)||r.depth<0))||typeof r.enabled!=='boolean'||r.blockId!==`hidden.lore.${r.sourceIndex}`)fail();return{sourceIndex:r.sourceIndex,blockId:r.blockId,insertOrder:r.insertOrder,depth:r.depth,enabled:r.enabled};});
  if(program.blocks.some(block=>!loreMapping.some(m=>m.blockId===block.id))||nonsexualProgram.blocks.some(block=>!loreMapping.some(m=>m.blockId===block.id)))fail();
  const issues=list(b.issues,500).map(raw=>{const r=object(raw);if(!['unsupported','changed','source-conflict'].includes(r.disposition)||(r.sourceIndex!==undefined&&!Number.isSafeInteger(r.sourceIndex)))fail();return{code:string(r.code),disposition:r.disposition,detail:string(r.detail,4000),...(r.sourceIndex!==undefined?{sourceIndex:r.sourceIndex}:{})};});
  return {format:'uimori-hidden-story-v1',status:'partial',source:{hash:source.hash,moduleId:string(source.moduleId),name:string(source.name)},program,nonsexualProgram,controlMap,picks,requiredSlots,loreMapping,issues};
}

export function freezeHiddenStory(module: HiddenStoryNativePackage, selection: HiddenStorySelection, context: {seed:string;userLabel:string}): HiddenStoryRunSnapshot {
  const config=validateHiddenStoryConfig(selection.config), wired=wireHiddenStoryInstructions(module,config,context);
  const compilation=compilePromptProgram({...wired.program,blocks:[...wired.program.blocks,{kind:'current',id:'hidden.compile-current',title:'Compile boundary'}]}, {values:wired.values,slots:wired.slots,history:[{id:'hidden.compile-current',role:'user',text:'',current:true}]});
  const messages=compilation.messages.filter(m=>m.provenance.origin!=='current').map(m=>({...m,provenance:{...m.provenance,sourceRevision:`${module.id}@${module.revision}`,sourceHash:module.packageHash}}));
  return structuredClone({module,config,seed:context.seed,choices:wired.choices,messages,insertion:selection.insertion??'before-current',issues:[...wired.issues,'HIDDEN_NATIVE_EXPLICIT_INSERTION']});
}
