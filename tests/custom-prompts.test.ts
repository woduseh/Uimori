import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { compileTranslationPrompt } from '../core/auxiliary.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTranslationPlan, translationInput, validateTranslationPlan } from '../core/auxiliary.js';
import { defaultProfile, type PromptPreset, type ProviderProtocol } from '../core/product.js';
import { DEFAULT_MAIN_PROMPT, DEFAULT_TRANSLATION_PROMPT } from '../core/prompts.js';
import { buildMainInput } from '../core/provider.js';
import { executeProvider, validateRequest, type Json, type ProviderRequest, type WireRecord } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';
import { sourceTimeContext } from '../server/product-auxiliary.js';
import { loopbackProvider } from './fixtures/loopback-provider.js';

const literal = '  CUSTOM 日本語\r\n{{char}} {{#if mode}} \n`literal` \nDo not trim or execute these tokens.  ';
const preset = (role: PromptPreset['role'], text=literal): PromptPreset => ({id:'prompt-'+role,revision:3,title:'Custom '+role,role,program:createDefaultPromptProgram(text,role)});
function snapshot():RunSnapshot {
  return {chatId:'prompt-chat',parentRevision:null,settingsRevision:1,settings:{preset:'calm',mode:'direct',translation:true,status:false,maxCalls:4},request:'Continue the scene.',history:[],resources:[],profile:{...defaultProfile('prompt-chat'),contents:[],models:{}}};
}
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.unstubAllGlobals(); for(const close of cleanups.splice(0)) await close();});

describe('full editable prompt boundaries',()=>{
  test('defaults stay compatible, exact empty and whitespace prompts replace defaults, and snapshots remain independent',()=>{
    const original=snapshot(); const context=sourceTimeContext(original,'translation');
    const source={id:'source-prompt',chatId:original.chatId,text:'The harbor waited.',hash:createHash('sha256').update('The harbor waited.').digest('hex')};
    const legacy=createTranslationPlan(source,context);
    expect(compileSnapshotPrompt(original).promptCompilation!.messages[0].content[0].text).toBe(DEFAULT_MAIN_PROMPT);
    expect(compileTranslationPrompt(translationInput(legacy,legacy.chunks[0].id,original),original,'task')!.messages[0].content[0].text).toBe(DEFAULT_TRANSLATION_PROMPT);
    expect(context.instructionRevision).toBe('hermeneia-native-1');
    expect(validateTranslationPlan(source,sourceTimeContext(structuredClone(original),'translation'),legacy)).toEqual(legacy);
    for(const text of ['', '  \r\n  ',literal]) {
      const selected=structuredClone(original); selected.profile!.promptPresets={main:preset('main',text),translation:preset('translation',text)};
      const frozen=structuredClone(selected); selected.profile!.promptPresets.main!.program=createDefaultPromptProgram('FUTURE REVISION');
      expect(frozen.profile!.promptPresets!.main!.program).toEqual(createDefaultPromptProgram(text)); expect(buildMainInput(frozen).contract).toBe('');
      const selectedContext=sourceTimeContext(frozen,'translation');
      const plan=createTranslationPlan(source,selectedContext); const input=translationInput(plan,plan.chunks[0].id,frozen);
      expect(input.contract).toBe(''); expect(compileTranslationPrompt(input,frozen,'task')).toBeDefined(); expect(input.customPrompt).toBe(true);
      expect(input.context.instructionRevision).toBe('prompt:prompt-translation@3');
      expect(JSON.stringify(input.outputSchema)).not.toContain('Korean');
      expect(()=>validateTranslationPlan(source,context,plan)).toThrow('SOURCE_TRANSLATION_PLAN_INVALID');
    }
    const legacySnapshot=snapshot(); delete legacySnapshot.profile;
    expect(compileSnapshotPrompt(legacySnapshot).promptCompilation!.messages[0].content[0].text).toBe(DEFAULT_MAIN_PROMPT);
  });

  test('transport permits explicit empty text without weakening non-prompt string validation',()=>{
    const value=request('main',''); expect(validateRequest(value).stable.contract).toBe('');
    expect(validateRequest({...value,stable:{...value.stable,contract:'x'.repeat(200000)}}).stable.contract).toHaveLength(200000);
    expect(()=>validateRequest({...value,stable:{...value.stable,contract:3}})).toThrow('INVALID_STRING');
    expect(()=>validateRequest({...value,stable:{...value.stable,contract:'x'.repeat(200001)}})).toThrow('INVALID_STRING');
    expect(()=>validateRequest({...value,modelId:''})).toThrow('INVALID_STRING');
  });
});

const variants:{protocol:ProviderProtocol;endpoint:string}[]=[
  {protocol:'vertex-gemini-v1',endpoint:'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models'},
  {protocol:'openai-responses-v1',endpoint:'https://api.openai.com/v1'},
  {protocol:'anthropic-messages-v1',endpoint:'https://api.anthropic.com/v1'},
  {protocol:'vercel-chat-v1',endpoint:'https://ai-gateway.vercel.sh/v1'},
  {protocol:'openai-chat-v1',endpoint:'https://synthetic.invalid/v1'},
];
function request(role:'main'|'translation',contract:string,protocol:ProviderProtocol='vertex-gemini-v1'):ProviderRequest {
  const modelId=protocol==='anthropic-messages-v1'?'claude-opus-5':protocol==='openai-responses-v1'?'gpt-5.6':'gemini-3.8-flash';
  return {role,modelId,generation:{maxOutputTokens:512,temperature:null},stable:{contract,tools:[]},input:{task:'Return the requested output.',controls:role==='translation'?{customPrompt:true,instructionRevision:'prompt:translation@3'}:{},source:{sourceRevision:'source-prompt',sourceHash:'hash-prompt',chunkId:'chunk-prompt',blocks:[{anchor:'anchor-prompt',text:'Forty quiet years.'}]},results:[]}};
}
function events(protocol:ProviderProtocol,text:string):(Json|'[DONE]')[] {
  if(protocol==='vertex-gemini-v1') return [{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2,totalTokenCount:5}}];
  if(protocol==='openai-responses-v1') {const message:Json={type:'message',id:'msg-custom',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};return [{type:'response.completed',response:{id:'response-custom',status:'completed',output:[message]}}];}
  if(protocol==='anthropic-messages-v1') return [
    {type:'message_start',message:{id:'msg-custom',type:'message',role:'assistant',model:'claude-opus-5',content:[],stop_reason:null,usage:{input_tokens:3,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},{type:'message_stop'},
  ];
  return [{id:'chat-custom',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:'stop'}]},'[DONE]'];
}
function systemText(protocol:ProviderProtocol,body:Record<string,any>):string[] {
  if(protocol==='vertex-gemini-v1') return body.systemInstruction.parts.map((part:{text:string})=>part.text);
  if(protocol==='anthropic-messages-v1') return body.system.map((part:{text:string})=>part.text);
  return [protocol==='openai-responses-v1'?body.instructions:body.messages[0].content];
}

describe('custom prompt native request/response through actual loopback HTTP, no paid calls',()=>{
  test.each(variants)('$protocol preserves custom literals and empty selection at its native wire boundary',async variant=>{
    const text=JSON.stringify({sourceRevision:'source-prompt',sourceHash:'hash-prompt',chunkId:'chunk-prompt',segments:[{anchors:['anchor-prompt'],text:'Le port attendait.'}]});
    const local=await loopbackProvider(async(_request,response)=>{response.writeHead(200,{'content-type':'text/event-stream'});response.end(events(variant.protocol,text).map(event=>'data: '+(event==='[DONE]'?event:JSON.stringify(event))+'\n\n').join(''));});cleanups.push(local.close);
    const nativeFetch=globalThis.fetch;
    vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{if(!String(input).startsWith(variant.endpoint+'/'))throw Error('Unexpected external request');return nativeFetch(local.endpoint,init);}));
    const wires:WireRecord[]=[];
    for(const [role,contract] of [['translation',literal],['translation',''],['main',literal],['main','x'.repeat(100001)]] as const){
      const value=request(role,contract,variant.protocol);
      const result=await executeProvider({id:'custom-native',...variant,credentialEnv:'NARRATIVE_PROVIDER_CUSTOM_TEST'},value,{signal:new AbortController().signal,approvedOrigins:[new URL(variant.endpoint).origin],resolveCredential:()=> 'synthetic-custom-prompt-token',onWire:wire=>{wires.push(wire);}});
      expect(result).toMatchObject({status:'completed',text});
      const captured=local.requests.at(-1)!;const body=JSON.parse(captured.body);const instructions=systemText(variant.protocol,body);
      if(contract) expect(instructions[0].startsWith(contract)).toBe(true);
      const combined=instructions.join('\n');
      expect(combined).not.toContain(DEFAULT_MAIN_PROMPT);expect(combined).not.toContain(DEFAULT_TRANSLATION_PROMPT);
      if(role==='translation'){expect(combined).not.toMatch(/Korean|사십 년/);expect(combined).toContain('[[p_...]]');expect(combined).toContain('sourceRevision');}
      expect(wires.at(-1)!.bodySha256).toBe(createHash('sha256').update(captured.body).digest('hex'));
    }
    expect(local.requests).toHaveLength(4);expect(wires).toHaveLength(4);
  });
});

