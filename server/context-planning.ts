import { createHash } from 'node:crypto';
import type { ContextPlan } from '../core/context-plan.js';
import type { RunSnapshot } from '../core/types.js';
import { contextBudgetForModel, estimateContextTokens, validateContextBudget } from '../core/context-budget.js';
import { buildMainProviderRequest, encodeMainPreview } from './main-request.js';
import type { Store } from './store.js';
import { hiddenSourceRequestView } from '../core/hidden-context.js';
import type { ModelSnapshot } from '../core/product.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const contextSourceRefs=(snapshot:RunSnapshot)=>snapshot.history.map(source=>({revision:source.revision,hash:source.contentHash??createHash('sha256').update(source.text).digest('hex'),...(snapshot.hiddenStory?{viewHash:hash(hiddenSourceRequestView(snapshot,source.revision).keptRanges)}:{})}));
/** Stable semantic dependencies. Per-run random draws and evolving derived state are not canon. */
export function contextDependencyKey(snapshot:RunSnapshot):string {
  return hash({contents:snapshot.profile?.contents??[],packages:snapshot.profile?.packages??[],prompt:snapshot.profile?.promptPresets?.main??null,promptControls:snapshot.profile?.promptControls??null,hidden:snapshot.hiddenStory?{module:snapshot.hiddenStory.module,config:snapshot.hiddenStory.config}:null,native:snapshot.nativeBot?.package??null,canon:snapshot.story?.canonHash??null,resources:snapshot.resources});
}
export function seedContextPlan(snapshot:RunSnapshot,target:ModelSnapshot|undefined=snapshot.profile?.models.main):RunSnapshot {
  if(!target)return snapshot;
  return {...snapshot,contextPlan:{version:1,status:'pending',budget:contextBudgetForModel(target),dependencyKey:contextDependencyKey(snapshot),estimatedInputTokens:null,compacted:[],recentSourceRevisions:snapshot.history.map(source=>source.revision),summary:null,summaryCalls:0,usage:{modelCalls:0,inputTokens:0,outputTokens:0,costUsd:0},error:null}};
}
export function withContextProjection(snapshot:RunSnapshot,compacted:ContextPlan['compacted'],summary:string|null):RunSnapshot {
  if(!snapshot.contextPlan)throw new Error('CONTEXT_PLAN_REQUIRED');
  const {promptCompilation:_compiled,...base}=snapshot;
  return {...base,contextPlan:{...snapshot.contextPlan,status:'ready',compacted:structuredClone(compacted),summary,recentSourceRevisions:snapshot.history.slice(compacted.length).map(source=>source.revision)}};
}
export function measureMainContext(snapshot:RunSnapshot):{snapshot:RunSnapshot;estimatedInputTokens:number} {
  try {
    const built=buildMainProviderRequest(snapshot);
    const body=encodeMainPreview(built.request,built.snapshot.profile!.models.main!).body;
    return {snapshot:built.snapshot,estimatedInputTokens:estimateContextTokens(body)};
  }catch(error){
    const code=error instanceof Error?error.message:'';
    if(['PROMPT_PROGRAM_LIMIT','PROMPT_COMPILED_LIMIT','PROMPT_OUTPUT_LIMIT','REQUEST_TOO_LARGE','PROMPT_INVALID_STRING'].includes(code))return{snapshot,estimatedInputTokens:Infinity};
    throw error;
  }
}
/** Called on a history-free feasibility projection. Remove only retained reads,
 * so long raw conversations alone cannot evict otherwise affordable references. */
export function fitFixedLoreContext(snapshot:RunSnapshot):RunSnapshot {
  const context=snapshot.loreContext,limit=snapshot.contextPlan?.budget.inputTokenLimit;
  if(!context?.entries.length||!limit||measureMainContext(snapshot).estimatedInputTokens<=limit*.85)return snapshot;
  let fitted=structuredClone(snapshot);
  delete fitted.promptCompilation;
  const lore=fitted.loreContext!,ancestry=fitted.history.map(source=>source.revision);
  do {
    let oldest=0;
    for(let index=1;index<lore.entries.length;index++)if(ancestry.indexOf(lore.entries[index]!.lastUsed)<ancestry.indexOf(lore.entries[oldest]!.lastUsed))oldest=index;
    lore.entries.splice(oldest,1);
    lore.stats.droppedEntries++;
    lore.stats.retainedEntries=lore.entries.length;
    lore.stats.retainedChars=lore.entries.reduce((sum,entry)=>sum+entry.text.length,0);
    if(!lore.stats.reasons.includes('overall-context-budget'))lore.stats.reasons.push('overall-context-budget');
  } while(lore.entries.length&&measureMainContext(fitted).estimatedInputTokens>limit*.75);
  return fitted;
}
export function validateContextPlan(snapshot:RunSnapshot):void {
  const plan=snapshot.contextPlan;if(!plan)return;
  const keys=['version','status','budget','dependencyKey','estimatedInputTokens','compacted','recentSourceRevisions','summary','summaryCalls','usage','error'];
  if(Object.keys(plan).some(key=>!keys.includes(key))||plan.version!==1||!['pending','ready','failed'].includes(plan.status)||plan.dependencyKey!==contextDependencyKey(snapshot))throw new Error('INVALID_CONTEXT_PLAN');
  validateContextBudget(plan.budget);
  if(JSON.stringify(plan.budget)!==JSON.stringify(contextBudgetForModel(snapshot.profile!.models.main!)))throw new Error('CONTEXT_BUDGET_MISMATCH');
  if(!Array.isArray(plan.compacted)||!Array.isArray(plan.recentSourceRevisions)||plan.compacted.length>snapshot.history.length||JSON.stringify(plan.compacted)!==JSON.stringify(contextSourceRefs(snapshot).slice(0,plan.compacted.length))||JSON.stringify(plan.recentSourceRevisions)!==JSON.stringify(snapshot.history.slice(plan.compacted.length).map(source=>source.revision)))throw new Error('CONTEXT_SOURCE_MISMATCH');
  if(plan.summary!==null&&(typeof plan.summary!=='string'||!plan.summary.trim()||plan.summary.length>200000)||plan.compacted.length>0&&!plan.summary||!Number.isSafeInteger(plan.summaryCalls)||plan.summaryCalls<0||plan.summaryCalls>=snapshot.settings.maxCalls)throw new Error('INVALID_CONTEXT_SUMMARY');
  if(plan.estimatedInputTokens!==null&&(!Number.isSafeInteger(plan.estimatedInputTokens)||plan.estimatedInputTokens<0)||plan.status==='ready'&&(plan.estimatedInputTokens===null||plan.estimatedInputTokens>plan.budget.inputTokenLimit)||plan.error!==null&&typeof plan.error!=='string')throw new Error('INVALID_CONTEXT_ESTIMATE');
  if(!plan.usage||plan.usage.modelCalls!==plan.summaryCalls||['inputTokens','outputTokens','costUsd'].some(key=>{const n=plan.usage[key as 'inputTokens'];return n!==null&&(typeof n!=='number'||!Number.isFinite(n)||n<0);}))throw new Error('INVALID_CONTEXT_USAGE');
}
/** Completed ancestor checkpoints only, checked against today's exact source hashes and canon. */
export function previousContextPlan(store:Store,snapshot:RunSnapshot):ContextPlan|undefined {
  for(const source of [...snapshot.history].reverse()){
    const prior=store.run(store.sourceOriginal(source.revision).runId).snapshot;
    const plan=prior.contextPlan;
    if(plan?.status!=='ready'||!plan.compacted.length||plan.dependencyKey!==snapshot.contextPlan?.dependencyKey)continue;
    try{validateContextPlan(prior);}catch{continue;}
    if(JSON.stringify(plan.compacted)===JSON.stringify(contextSourceRefs(snapshot).slice(0,plan.compacted.length)))return structuredClone(plan);
  }
  return undefined;
}
