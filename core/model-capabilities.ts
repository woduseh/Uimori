import type { ModelGeneration, ModelPreset, ProviderProtocol } from './product.js';
import { ProviderContractError } from './provider-errors.js';

export const MODEL_SUPPORT_POLICY = { supportWindowMonths: 6, checkedAt: '2026-09-07', exceptions: [{ id: 'gemini-3.1-pro-preview', reason: 'User-selected baseline model', releasedAt: '2026-02-19' }] } as const;
export const GENERATION_KEYS = ['maxOutputTokens','temperature','thinkingLevel','structuredOutput','reasoningEffort','outputEffort','thinkingMode','thinkingBudgetTokens','verbosity','reasoningMode','reasoningContext','topP','stopSequences','serviceTier','cacheMode','cacheTtl'] as const;
export type ModelCapability = Readonly<{
  id: string; name: string; revision: string; protocol: ProviderProtocol; preview?: boolean; releasedAt?: string; forcedTools?: boolean;
  maxOutputTokens: number; temperature: boolean; topP: boolean; stopSequences: boolean;
  thinkingLevels?: readonly NonNullable<ModelGeneration['thinkingLevel']>[];
  reasoningEfforts?: readonly NonNullable<ModelGeneration['reasoningEffort']>[];
  outputEfforts?: readonly NonNullable<ModelGeneration['outputEffort']>[];
  thinkingModes?: readonly NonNullable<ModelGeneration['thinkingMode']>[];
  verbosities?: readonly NonNullable<ModelGeneration['verbosity']>[];
  reasoningModes?: readonly NonNullable<ModelGeneration['reasoningMode']>[];
  reasoningContexts?: readonly NonNullable<ModelGeneration['reasoningContext']>[];
  serviceTiers?: readonly string[]; cacheModes?: readonly NonNullable<ModelGeneration['cacheMode']>[]; cacheTtls?: readonly NonNullable<ModelGeneration['cacheTtl']>[];
  defaultThinkingLevel?: string; defaultReasoningEffort?: string; defaultOutputEffort?: string;
  midSystem?: boolean; sources: readonly string[];
}>;
const revision = '2026-09-07.1';
const openai = (id: string, name: string, astra = false): ModelCapability => ({ id, name, revision, protocol: 'openai-responses-v1', maxOutputTokens: 128_000, temperature: false, topP: false, stopSequences: false, reasoningEfforts: astra ? ['low','medium','high','xhigh','max'] : ['none','low','medium','high','xhigh','max'], defaultReasoningEffort: 'medium', verbosities: ['low','medium','high'], reasoningModes: ['standard','pro'], reasoningContexts: ['auto','all_turns','current_turn'], serviceTiers: ['auto','default','flex','priority'], cacheModes:['disabled','explicit','automatic'], cacheTtls:['30m'], sources: [`https://developers.openai.com/api/docs/models/${id}`, 'https://developers.openai.com/api/docs/guides/reasoning'] });
const capabilities: readonly ModelCapability[] = [
  { id:'gemini-3.8-flash', name:'Gemini 3.8 Flash', revision, protocol:'vertex-gemini-v1', maxOutputTokens:65_536, temperature:false, topP:false, stopSequences:true, thinkingLevels:['LOW','MEDIUM','HIGH'], defaultThinkingLevel:'MEDIUM', serviceTiers:['standard','flex'], sources:['https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash'] },
  { id:'gemini-3.1-pro-preview', name:'Gemini 3.1 Pro (Preview)', preview:true, revision, protocol:'vertex-gemini-v1', maxOutputTokens:65_536, temperature:true, topP:true, stopSequences:true, thinkingLevels:['LOW','MEDIUM','HIGH'], defaultThinkingLevel:'HIGH', serviceTiers:['standard','flex'], sources:['https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro'] },
  ...[openai('gpt-5.6-sol','GPT-5.6 Sol'),openai('gpt-5.6-terra','GPT-5.6 Terra'),openai('gpt-5.6-luna','GPT-5.6 Luna'),openai('gpt-5.6','GPT-5.6 (Sol alias)'),openai('gpt-6-astra','GPT-6 Astra',true)],
  { id:'claude-fable-5-1', name:'Claude Fable 5.1', releasedAt:'2026-09-01', revision, protocol:'anthropic-messages-v1', maxOutputTokens:128_000, temperature:false, topP:false, stopSequences:true, outputEfforts:['low','medium','high','xhigh','max'], defaultOutputEffort:'high', thinkingModes:['adaptive'], serviceTiers:['auto','standard_only'], cacheModes:['disabled','explicit','automatic'], cacheTtls:['5m','1h'], midSystem:true, forcedTools:false, sources:['https://platform.claude.com/docs/en/models/fable-5-1/overview','https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1'] },
  { id:'claude-opus-5', name:'Claude Opus 5', revision, protocol:'anthropic-messages-v1', maxOutputTokens:128_000, temperature:false, topP:false, stopSequences:true, outputEfforts:['low','medium','high','xhigh','max'], defaultOutputEffort:'high', thinkingModes:['adaptive','disabled'], serviceTiers:['auto','standard_only'], cacheModes:['disabled','explicit','automatic'], cacheTtls:['5m','1h'], midSystem:true, sources:['https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5','https://platform.claude.com/docs/en/api/http/messages/create'] },
];
export function supportedModels(protocol: ProviderProtocol): readonly ModelCapability[] {
  if (protocol === 'openai-chat-v1') return capabilities.filter(item=>item.protocol==='openai-responses-v1').map(item=>({...item,protocol,reasoningModes:undefined,reasoningContexts:undefined,verbosities:undefined,cacheModes:undefined,cacheTtls:undefined}));
  return capabilities.filter(item=>item.protocol===protocol);
}
export function modelCapability(protocol: ProviderProtocol, modelId: string): ModelCapability | undefined { return supportedModels(protocol).find(item=>item.id===modelId); }
export function generationFromModel(model: ModelGeneration & {modelId?:string;capabilityRevision?:string}, protocol?: ProviderProtocol): ModelGeneration { if(protocol&&model.modelId)validateCapabilityRevision({modelId:model.modelId,capabilityRevision:model.capabilityRevision},protocol); return structuredClone(Object.fromEntries(GENERATION_KEYS.filter(key=>model[key]!==undefined).map(key=>[key,model[key]]))) as ModelGeneration; }
const reject = (code = 'UNSUPPORTED_GENERATION_OPTIONS'): never => { throw new ProviderContractError(code); };

export function validateGenerationShape(value: unknown): asserts value is ModelGeneration {
  if (!value || typeof value!=='object' || Array.isArray(value)) reject();
  const g = value as ModelGeneration;
  if(Object.keys(g).some(key=>!GENERATION_KEYS.includes(key as typeof GENERATION_KEYS[number])))reject();
  if(!Number.isSafeInteger(g.maxOutputTokens)||g.maxOutputTokens<1||g.maxOutputTokens>200_000)reject();
  if(g.temperature!==null&&(typeof g.temperature!=='number'||!Number.isFinite(g.temperature)||g.temperature<0||g.temperature>2))reject();
  if(g.structuredOutput!==undefined&&typeof g.structuredOutput!=='boolean')reject();
  const enums = {thinkingLevel:['LOW','MEDIUM','HIGH'],reasoningEffort:['none','minimal','low','medium','high','xhigh','max'],outputEffort:['low','medium','high','xhigh','max'],thinkingMode:['disabled','enabled','adaptive'],verbosity:['low','medium','high'],reasoningMode:['standard','pro'],reasoningContext:['auto','all_turns','current_turn'],cacheMode:['disabled','explicit','automatic'],cacheTtl:['5m','30m','1h']} as const;
  for(const [key,values] of Object.entries(enums))if(g[key as keyof ModelGeneration]!==undefined&&!(values as readonly unknown[]).includes(g[key as keyof ModelGeneration]))reject();
  if(g.thinkingBudgetTokens!==undefined&&(!Number.isSafeInteger(g.thinkingBudgetTokens)||g.thinkingBudgetTokens<1024||g.thinkingBudgetTokens>=g.maxOutputTokens))reject();
  if(g.topP!==undefined&&(typeof g.topP!=='number'||!Number.isFinite(g.topP)||g.topP<0||g.topP>1))reject();
  if(g.stopSequences!==undefined&&(!Array.isArray(g.stopSequences)||g.stopSequences.length>4||g.stopSequences.some(item=>typeof item!=='string'||!item.length||item.length>1000)))reject();
  if(g.serviceTier!==undefined&&(typeof g.serviceTier!=='string'||!g.serviceTier.length||g.serviceTier.length>40))reject();
}
/** Storage may retain unreviewed model IDs. Official execution additionally requires a registered ID. */
export function validateModelOptions(g: ModelGeneration, protocol: ProviderProtocol, modelId: string): void {
  validateGenerationShape(g);
  if(g.cacheTtl!==undefined&&!['explicit','automatic'].includes(g.cacheMode??''))reject('CACHE_TTL_REQUIRES_CACHE_MODE');
  const cap=modelCapability(protocol,modelId);
  if(cap){
    if(g.maxOutputTokens>cap.maxOutputTokens || (g.temperature!==null&&!cap.temperature) || (g.topP!==undefined&&!cap.topP) || (g.stopSequences!==undefined&&!cap.stopSequences) || g.thinkingBudgetTokens!==undefined)reject();
    const fields = {thinkingLevel:cap.thinkingLevels,reasoningEffort:cap.reasoningEfforts,outputEffort:cap.outputEfforts,thinkingMode:cap.thinkingModes,verbosity:cap.verbosities,reasoningMode:cap.reasoningModes,reasoningContext:cap.reasoningContexts,serviceTier:cap.serviceTiers,cacheMode:cap.cacheModes,cacheTtl:cap.cacheTtls};
    for(const [key,values] of Object.entries(fields))if(g[key as keyof ModelGeneration]!==undefined&&!(values as readonly unknown[]|undefined)?.includes(g[key as keyof ModelGeneration]))reject();
    if(protocol==='anthropic-messages-v1'&&g.thinkingMode==='disabled'&&['xhigh','max'].includes(g.outputEffort??cap.defaultOutputEffort!))reject('INCOMPATIBLE_THINKING_EFFORT');
    if(protocol==='vertex-gemini-v1'&&g.structuredOutput!==undefined)reject();
    return;
  }
  const allowed = protocol==='fixture-sse-v1' ? ['thinkingLevel'] : protocol==='codex-app-server-v1' ? ['reasoningEffort'] : ['openai-responses-v1','openai-chat-v1','vercel-chat-v1'].includes(protocol) ? ['structuredOutput','reasoningEffort'] : [];
  if(['codex-app-server-v1','vertex-gemini-v1','anthropic-messages-v1'].includes(protocol)&&g.temperature!==null)reject();
  if(Object.keys(g).some(key=>!['maxOutputTokens','temperature',...allowed].includes(key)))reject();
}
export function isOfficialModelConnection(connection: {protocol: ProviderProtocol; endpoint: string}): boolean {
  return ['vertex-gemini-v1','anthropic-messages-v1'].includes(connection.protocol)||(['openai-responses-v1','openai-chat-v1'].includes(connection.protocol)&&connection.endpoint.replace(/\/$/u,'')==='https://api.openai.com/v1');
}
export function requireSupportedModel(connection: {protocol: ProviderProtocol; endpoint: string}, modelId: string): void {
  if(isOfficialModelConnection(connection)&&!modelCapability(connection.protocol,modelId))reject('UNVERIFIED_MODEL_CAPABILITY');
}
export function validateCapabilityRevision(model: Pick<ModelPreset,'modelId'|'capabilityRevision'>, protocol: ProviderProtocol): void {
  if(model.capabilityRevision!==modelCapability(protocol,model.modelId)?.revision)reject('MODEL_CAPABILITY_REVISION_MISMATCH');
}
