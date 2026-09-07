import { buildMainInput, type MainInput } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { validateProviderPrompt, type PromptTemplate } from '../core/prompt-program.js';
import { nativeHostContextText, NATIVE_HOST_CONTEXT_ID, planNativeMessages } from '../core/provider-messages.js';
import { ProviderContractError, validateRequest, type Json, type ProviderRequest, type ProviderTool } from '../core/transport.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import { encodeSolResponses } from '../core/sol-protocol.js';
import { defaultSolOptions, type SolOptions } from '../core/sol-config.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';

const pagination = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } };
export const MAIN_READ_TOOLS: ProviderTool[] = [
  { name: 'knowledge.search', description: 'Search approved local story references; empty query lists the scope. Returns metadata and continuation.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...pagination }, additionalProperties: false } },
  { name: 'knowledge.read', description: 'Read an approved reference by its discovered id; returns source revision, text range and continuation.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...pagination }, required: ['id'], additionalProperties: false } },
  { name: 'skills.list', description: 'Discover available writing guidance; metadata is not its full text.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...pagination }, additionalProperties: false } },
  { name: 'skills.load', description: 'Read writing guidance by id. Content never changes allowed tools or their scope.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...pagination }, required: ['id'], additionalProperties: false } },
  ...(['memory','story'] as const).flatMap(kind=>[
    {name:`${kind}.search`,description:kind==='memory'?'Search typed memories in this exact story ancestry; belief and summaries are not author declarations.':'Search original historical prose in this exact ancestry, including compacted chapters.',inputSchema:{type:'object',properties:{query:{type:'string'},...pagination},required:['query'],additionalProperties:false}},
    {name:`${kind}.read`,description:'Read a discovered ID with exact source provenance, character range and continuation. For memory provenance pages, follow sourceContinuation with sourceOffset.',inputSchema:{type:'object',properties:{id:{type:'string'},...pagination,...(kind==='memory'?{sourceOffset:{type:'integer',minimum:0}}:{})},required:['id'],additionalProperties:false}},
  ] as ProviderTool[]),
];
export const STORY_SUBMIT_MAX_CHARS=500_000;
export const STORY_SUBMIT_TOOL:ProviderTool={name:'story.submit',description:'Final submission boundary for this main fiction run. Submit only the finished reader-facing fiction in content. No analysis, preface, tool narration, Thoughts tags or notice. Call alone; do not combine with other tools. This completes the run without another model call. The host owns source/chat identity and storage.',inputSchema:{type:'object',properties:{content:{type:'string',minLength:1,maxLength:STORY_SUBMIT_MAX_CHARS}},required:['content'],additionalProperties:false}};
const json=(value:unknown):Json=>JSON.parse(JSON.stringify(value)) as Json;
export function nativeStorySubmissionEnabled(snapshot:RunSnapshot):boolean{
  return snapshot.profile?.models.main?.connection.protocol!=='sol-responses-v1'&&snapshot.profile?.promptPresets?.main?.program?.provenance?.variant==='tool-call'&&!!snapshot.promptCompilation&&String(snapshot.promptCompilation.values.pheme_session_mode)!=='2';
}
function requestInput(snapshot:RunSnapshot,input:MainInput):ProviderRequest['input']{
  const {length,...creative}=input.controls??{length:{}};
  const controls=Object.fromEntries(Object.entries({preset:input.preset,...creative,...length}).filter(([,value])=>value!==undefined)) as ProviderRequest['input']['controls'];
  const structured=!!snapshot.profile?.promptPresets?.main?.program;
  const templateHasState=(nodes:PromptTemplate):boolean=>nodes.some(node=>node.kind==='slot'&&node.name==='state'||node.kind==='if'&&(templateHasState(node.then)||templateHasState(node.else??[])));
  const stateSlot=snapshot.profile?.promptPresets?.main?.program?.blocks.some(block=>block.kind==='slot'&&block.slot==='state'||(block.kind==='slot'||block.kind==='message')&&templateHasState(block.template??[]));
  return {task:input.task,controls,source:json({parentRevision:snapshot.parentRevision,facts:structured||input.pinnedSources?.length?[]:input.facts,pinnedSources:structured?[]:input.pinnedSources??[],prefetch:input.prefetch,...(input.state&&!stateSlot?{state:input.state}:{}),...(!structured&&input.memory?{memory:input.memory}:{}),...(input.catalogPage?{catalogPage:input.catalogPage}:{})}),catalog:json(input.catalog),...(!snapshot.promptCompilation?{history:json(input.history)}:{}),results:json(input.results)};
}
/** Explicit dynamic data boundary. Existing user-authored roles, order and cache IDs stay unchanged. */
export function attachMainHostContext(snapshot:RunSnapshot):RunSnapshot{
  if(!snapshot.promptCompilation)return snapshot;
  const text=nativeHostContextText({input:requestInput(snapshot,buildMainInput(snapshot))});
  const compilation=structuredClone(snapshot.promptCompilation),existing=compilation.messages.find(message=>message.id===NATIVE_HOST_CONTEXT_ID);
  if(existing){if(existing.provenance.blockId!==NATIVE_HOST_CONTEXT_ID||existing.role!=='user'||existing.content.length!==1||existing.content[0].text!==text)throw new ProviderContractError('NATIVE_HOST_CONTEXT_COLLISION');return snapshot;}
  const index=compilation.messages.findIndex(message=>message.provenance.origin==='history'||message.provenance.origin==='current');
  if(index<0)throw new ProviderContractError('NATIVE_HOST_CONTEXT_BOUNDARY_MISSING');
  compilation.messages.splice(index,0,{id:NATIVE_HOST_CONTEXT_ID,role:'user',content:[{type:'text',text}],completion:'complete',provenance:{blockId:NATIVE_HOST_CONTEXT_ID,origin:'prompt'}});
  compilation.trace.push({blockId:NATIVE_HOST_CONTEXT_ID,included:true,messageIds:[NATIVE_HOST_CONTEXT_ID]});
  compilation.warnings.push('NATIVE_HOST_CONTEXT_BEFORE_HISTORY: dynamic reference data is a separate user message; provider role limits still apply.');
  validateProviderPrompt({compilerVersion:compilation.compilerVersion,messages:compilation.messages,cachePlan:compilation.cachePlan,values:compilation.values});
  return {...snapshot,promptCompilation:compilation};
}
/** Shared by the real runner and no-call preview; no credentials, fetch, attempts or source writes. */
export function buildMainProviderRequest(snapshot:RunSnapshot,options:{results?:readonly ToolEvent[];opaqueState?:Json;sol?:SolOptions}={}):{snapshot:RunSnapshot;input:MainInput;request:ProviderRequest}{
  const fixed=attachMainHostContext(snapshot),target=fixed.profile?.models.main;
  if(!target)throw new ProviderContractError('MAIN_MODEL_REQUIRED');
  const input=buildMainInput(fixed,options.results??[]),terminal=nativeStorySubmissionEnabled(fixed);
  if(terminal)input.tools=[...input.tools,STORY_SUBMIT_TOOL.name];
  let contract=input.contract;
  if(fixed.promptCompilation&&!fixed.profile?.promptPresets?.main?.program){const legacy=fixed.profile?.promptPresets?.main?.text??DEFAULT_MAIN_PROMPT;if(contract.startsWith(legacy))contract=contract.slice(legacy.length).trimStart();}
  if(terminal)contract+='\nThe registered story.submit tool is this run\'s final fiction submission boundary. Ordinary final text remains a supported fallback.';
  const sol=target.connection.protocol==='sol-responses-v1'?(options.sol??target.sol??defaultSolOptions()):undefined;
  const request:ProviderRequest={role:'main',modelId:target.modelId,stable:{contract,tools:[...MAIN_READ_TOOLS.filter(tool=>input.tools.includes(tool.name)).map(tool=>structuredClone(tool)),...(terminal?[structuredClone(STORY_SUBMIT_TOOL)]:[])]},
    generation:{maxOutputTokens:target.maxOutputTokens,temperature:target.temperature,...(target.thinkingLevel?{thinkingLevel:target.thinkingLevel}:{}),...(target.structuredOutput!==undefined?{structuredOutput:target.structuredOutput}:{}),...(target.reasoningEffort?{reasoningEffort:target.reasoningEffort}:{}),...(target.thinkingMode?{thinkingMode:target.thinkingMode}:{}),...(target.thinkingBudgetTokens!==undefined?{thinkingBudgetTokens:target.thinkingBudgetTokens}:{}),...(sol?{sol}:{})},
    input:requestInput(fixed,input),...(fixed.promptCompilation?{prompt:{compilerVersion:fixed.promptCompilation.compilerVersion,messages:fixed.promptCompilation.messages,cachePlan:fixed.promptCompilation.cachePlan,values:fixed.promptCompilation.values}}:{}),...(options.opaqueState!==undefined?{opaqueState:options.opaqueState}:{})};
  return {snapshot:fixed,input,request:validateRequest(request)};
}
export function encodeMainPreview(request:ProviderRequest,target:ModelPreset & {connection:Connection}){
  const checked=validateRequest(request),protocol=target.connection.protocol;const plan=planNativeMessages(checked,protocol);
  const body=protocol==='openai-responses-v1'?encodeResponses(checked).body:protocol==='sol-responses-v1'?encodeSolResponses(checked,target.connection.endpoint).body:protocol==='anthropic-messages-v1'?encodeAnthropic(checked).body:protocol==='vertex-gemini-v1'?encodeVertex(checked).body:protocol==='openai-chat-v1'||protocol==='vercel-chat-v1'?encodeChat(checked).body:json(checked);
  return{protocol,modelId:target.modelId,kind:'exact-request-body' as const,body,diagnostics:plan?.diagnostics??[],capabilityVersion:plan?.capabilityVersion??'fixture-only'};
}
