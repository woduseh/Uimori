import { afterEach, describe, expect, test } from 'vitest';
import Fastify from 'fastify';
import { buildMainProviderRequest, encodeMainPreview, attachMainHostContext, nativeStorySubmissionEnabled, STORY_SUBMIT_MAX_CHARS } from '../server/main-request.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { promptRoutes } from '../server/prompt-routes.js';
import { runMain, type MainHooks } from '../server/model-runner.js';
import { defaultProfile, type ProviderProtocol } from '../core/product.js';
import { defaultStoryConfig } from '../core/story.js';
import { planMemoryContext } from '../core/memory.js';
import type { PromptProgram } from '../core/prompt-program.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import type { Store } from '../server/store.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
function program(variant='normal'):PromptProgram{return{version:1,controls:[{id:'pheme_session_mode',label:'Mode',type:'select',default:'1',options:[{label:'Fiction',value:'1'},{label:'OOC',value:'2'}]}],blocks:[{id:'static',title:'Static',kind:'message',role:'system',template:[{kind:'text',text:'SYNTHETIC_STATIC_PROMPT'}]},{id:'static-cache',title:'Static cache',kind:'cache',depth:1,role:'all',policy:'prefer'},{id:'memory',title:'Memory',kind:'slot',role:'user',slot:'memory'},{id:'conversation',title:'Conversation',kind:'history',from:0,to:'end'}],provenance:{sourceHash:'a'.repeat(64),variant,conversionVersion:'synthetic',notes:[]}};}
function snapshot(endpoint='http://127.0.0.1:19099/v1/responses',variant='normal',mode='1'):RunSnapshot{
  const p=program(variant),profile={...defaultProfile('synthetic-chat'),contents:[],models:{main:{id:'model',revision:1,title:'Synthetic',connectionId:'connection',connectionRevision:1,modelId:'gpt-5.6',maxOutputTokens:1024,temperature:null,connection:{id:'connection',revision:1,title:'Synthetic',protocol:'openai-chat-v1' as ProviderProtocol,endpoint,enabled:true,catalog:[],catalogError:null}}},promptPresets:{main:{id:'prompt',revision:1,title:'Synthetic',role:'main' as const,text:'',program:p}},promptControls:{'prompt@1':{values:{pheme_session_mode:mode},combinations:[]}}};
  return{chatId:profile.chatId,parentRevision:null,settingsRevision:1,settings:{preset:'calm',mode:'direct',translation:false,status:false,maxCalls:3},request:'SYNTHETIC_CURRENT_ONCE',history:[],resources:[],logicalHistory:[],profile};
}
function hooks(origin:string){const events:ToolEvent[]=[],attempts:WireRecord[]=[],finished:ProviderResult[]=[];const value:MainHooks={signal:new AbortController().signal,approvedOrigins:[origin],authorize:connection=>connection,onInput:()=>{},onToolEvent:event=>{events.push(event);},onAttemptStart:wire=>{attempts.push(wire);return`attempt-${attempts.length}`;},onAttemptFinish:(_id,result)=>{finished.push(result);}};return{value,events,attempts,finished};}
const complete=(text:string):Json=>({id:'response-synthetic',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}});
const toolOutput=(body:Record<string,any>,name:string,content:unknown,id='Call.Submit')=>({index:id==='Call.Read'?1:0,type:'function',id,function:{name:body.tools.find((tool:{function:{name:string}})=>tool.function.name.endsWith(name.replaceAll('.','_')))?.function.name??name,arguments:JSON.stringify(typeof content==='string'?{content}:content)}});
const toolTurn=(output:Json[]):Json=>({id:'tool-synthetic',choices:[{index:0,delta:{role:'assistant',tool_calls:output},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}});

describe('Exact native main preview and terminal submission (synthetic loopback only)',()=>{
  test('NMR01 preview route and runner use byte-equivalent encoder bodies, current once, no call during preview',async()=>{
    const server=await loopbackProvider(async(_request,response)=>writeSse(response,[complete('Synthetic final prose.'),'[DONE]']));closes.push(server.close);
    const work=snapshot(`${server.origin}/v1/responses`),frozen=compileSnapshotPrompt(work),built=buildMainProviderRequest(frozen),expected=encodeMainPreview(built.request,work.profile!.models.main!);
    const app=Fastify();closes.push(()=>app.close());
    const fake={chat:()=>({id:work.chatId,settingsRevision:work.settingsRevision,settings:work.settings}),history:()=>[],product:{snapshot:()=>structuredClone(work.profile),branch:()=>({id:'branch-1',headRevision:null}),resources:()=>[]},native:{snapshot:()=>undefined},story:{prepareRunInTransaction:(value:RunSnapshot)=>value}} as unknown as Store;
    promptRoutes(app,fake);
    const response=await app.inject({method:'POST',url:`/api/chats/${work.chatId}/prompt-preview`,payload:{program:work.profile!.promptPresets!.main!.program,request:work.request,role:'main',values:{pheme_session_mode:'1'}}});expect(response.statusCode).toBe(200);expect(response.json().provider.body).toEqual(expected.body);expect(server.requests).toHaveLength(0);
    const log=hooks(server.origin),result=await runMain(frozen,log.value);expect(result.status).toBe('completed');expect(log.attempts).toHaveLength(1);expect(log.attempts[0].body).toEqual(expected.body);expect(JSON.parse(server.requests[0].body)).toEqual(expected.body);
    expect(server.requests[0].body.split(work.request).length-1).toBe(1);expect(response.json().compilation.messages.some((m:{id:string})=>m.id==='native.host-context')).toBe(true);
  });

  test('NMR02 memory remains at its chosen user slot and dynamic host data is after the static cache prefix',()=>{
    const work=snapshot(),entry={id:'author',chatId:work.chatId,atRevision:null,atHash:null,kind:'author-canon' as const,text:'SYNTHETIC_MEMORY_SENTINEL',declaration:{author:'Synthetic author',text:'SYNTHETIC_MEMORY_SENTINEL'}},plan=planMemoryContext({scope:{chatId:work.chatId,history:[]},entries:[entry]});
    work.story={config:{...defaultStoryConfig(),revision:1},state:null,waiting:false,lineageHash:'synthetic',canonHash:'synthetic',memory:{entries:[entry],checkpoint:{chatId:work.chatId,indexed:[]},plan},models:{}};
    work.profile!.models.main!.connection.protocol='openai-responses-v1';
    const built=buildMainProviderRequest(compileSnapshotPrompt(work)),body=encodeMainPreview(built.request,work.profile!.models.main!).body as Record<string,any>;
    const compiled=built.request.prompt!;const memory=compiled.messages.find(m=>m.id==='memory')!,host=compiled.messages.find(m=>m.id==='native.host-context')!;
    expect(memory.role).toBe('user');expect(memory.content[0].text).toContain(entry.text);expect(host.content[0].text).not.toContain(entry.text);expect((built.request.input.source as Record<string,Json>).memory).toBeUndefined();expect(body.instructions).not.toContain('parentRevision');expect(body.instructions).not.toContain(entry.text);
    expect(compiled.messages[0].id).toBe('static');expect(compiled.cachePlan[0].afterMessageId).toBe('static');expect(body.input[0].content[0].prompt_cache_breakpoint).toEqual({mode:'explicit'});expect(compiled.messages.indexOf(host)).toBeGreaterThan(compiled.messages.indexOf(memory));
    expect(attachMainHostContext(built.snapshot)).toEqual(built.snapshot);expect(work).not.toHaveProperty('promptCompilation');
  });

  test('NMR03 tool variant terminal body completes once with host provenance and no tool-result round',async()=>{
    const prose='Synthetic submitted fiction.';const server=await loopbackProvider(async(request,response)=>{const body=JSON.parse(request.body);await writeSse(response,[toolTurn([toolOutput(body,'story.submit',prose)]),'[DONE]']);});closes.push(server.close);
    const work=compileSnapshotPrompt(snapshot(`${server.origin}/v1/responses`,'tool-call')),before=structuredClone(work),log=hooks(server.origin),result=await runMain(work,log.value);
    expect(result).toMatchObject({status:'completed',text:prose,error:null});expect(server.requests).toHaveLength(1);expect(log.events).toHaveLength(1);expect(log.events[0]).toMatchObject({name:'story.submit',args:{content:prose},denied:false,result:{accepted:true,host:{chatId:work.chatId,parentRevision:null,settingsRevision:1,promptPreset:{id:'prompt',revision:1}}}});expect(work).toEqual(before);
  });

  test('NMR04 mixed terminal/read, foreign source identity and empty/oversized terminal contents fail without executing tools',async()=>{
    for(const invalid of ['mixed','foreign','empty','oversized'] as const){
      const server=await loopbackProvider(async(request,response)=>{const body=JSON.parse(request.body);const content=invalid==='foreign'?{content:'Synthetic prose',sourceId:'another-source'}:invalid==='empty'?'   ':invalid==='oversized'?'x'.repeat(STORY_SUBMIT_MAX_CHARS+1):'Synthetic prose';const output=[toolOutput(body,'story.submit',content)];if(invalid==='mixed')output.push(toolOutput(body,'knowledge.read',{id:'synthetic'},'Call.Read'));await writeSse(response,[toolTurn(output),'[DONE]']);});closes.push(server.close);
      const log=hooks(server.origin),result=await runMain(compileSnapshotPrompt(snapshot(`${server.origin}/v1/responses`,'tool-call')),log.value);expect(result.status).toBe('error');expect(result.text).toBe('');expect(log.events).toHaveLength(0);expect(server.requests).toHaveLength(1);
    }
  });

  test('NMR05 OOC/normal omit native terminal, plain text fallback remains supported, evaluation tools own their terminal',async()=>{
    for(const [variant,mode]of[['normal','1'],['tool-call','2']] as const){const work=compileSnapshotPrompt(snapshot(undefined,variant,mode));expect(nativeStorySubmissionEnabled(work)).toBe(false);expect(buildMainProviderRequest(work).request.stable.tools.some(t=>t.name==='story.submit')).toBe(false);}
    const server=await loopbackProvider(async(_request,response)=>writeSse(response,[complete('Normal text fallback.'),'[DONE]']));closes.push(server.close);const work=compileSnapshotPrompt(snapshot(`${server.origin}/v1/responses`,'tool-call')),log=hooks(server.origin);expect((await runMain(work,log.value)).text).toBe('Normal text fallback.');expect(log.events).toHaveLength(0);
    const evaluated=compileSnapshotPrompt(snapshot('https://api.openai.com/v1','tool-call'));evaluated.profile!.models.main!.evaluationTools={contextMode:'model-selected',approvalReasoningMode:'configured',maximumToolRounds:8,terminalLateCorrections:false,outputRecovery:true};expect(nativeStorySubmissionEnabled(evaluated)).toBe(false);expect(buildMainProviderRequest(evaluated).request.stable.tools.some(t=>t.name==='story.submit')).toBe(false);
  });

  test('NMR06 exact encoders report explicit unsupported placement instead of reordering user blocks',()=>{
    for(const protocol of ['openai-responses-v1','openai-chat-v1','vercel-chat-v1','anthropic-messages-v1','vertex-gemini-v1'] as ProviderProtocol[]){const work=compileSnapshotPrompt(snapshot());const target=work.profile!.models.main!;target.connection.protocol=protocol;target.modelId=protocol==='vertex-gemini-v1'?'gemini-3.8-flash':protocol==='anthropic-messages-v1'?'claude-sonnet-4-6':'gpt-5.6';const built=buildMainProviderRequest(work);expect(encodeMainPreview(built.request,target)).toHaveProperty('body');}
  });

  test('NMR07 tool continuation keeps the frozen host message and original cache bindings stable',async()=>{
    let count=0;const server=await loopbackProvider(async(request,response)=>{count++;const body=JSON.parse(request.body);await writeSse(response,count===1?[toolTurn([toolOutput(body,'knowledge.search',{query:''},'Call.Lookup')]),'[DONE]']:[toolTurn([toolOutput(body,'story.submit','Synthetic second-round fiction.')]),'[DONE]']);});closes.push(server.close);
    const work=compileSnapshotPrompt(snapshot(`${server.origin}/v1`,'tool-call')),before=structuredClone(work.promptCompilation),log=hooks(server.origin),result=await runMain(work,log.value);
    expect(result).toMatchObject({status:'completed',text:'Synthetic second-round fiction.'});expect(server.requests).toHaveLength(2);expect(log.events.map(e=>e.name)).toEqual(['knowledge.search','story.submit']);
    const first=JSON.parse(server.requests[0].body),second=JSON.parse(server.requests[1].body);expect(second.messages.slice(0,first.messages.length)).toEqual(first.messages);expect(second.messages.filter((m:{content:unknown})=>JSON.stringify(m.content).includes('Host context (JSON reference data')).length).toBe(1);expect(work.promptCompilation).toEqual(before);
  });

  test('NMR08 unreviewed model aliases do not inherit explicit cache or mid-system capabilities',()=>{
    const work=compileSnapshotPrompt(snapshot()),target=work.profile!.models.main!;target.connection.protocol='openai-responses-v1';target.modelId='gpt-5.9';const built=buildMainProviderRequest(work),preview=encodeMainPreview(built.request,target);expect(preview.diagnostics.some(d=>d.code==='PROMPT_CACHE_NOT_APPLIED')).toBe(true);expect((preview.body as Record<string,Json>).prompt_cache_options).toBeUndefined();
    target.modelId='gpt-6-astra';const supported=encodeMainPreview(buildMainProviderRequest(work).request,target);expect(supported.diagnostics.some(d=>d.code==='CACHE_BREAKPOINT_ENCODED_HIT_UNVERIFIED')).toBe(true);
  });

  test('NMR09 explicit state and pinned context slots have no duplicate host-envelope bodies',()=>{
    const work=snapshot();work.profile!.contents=[{id:'bot',revision:1,kind:'bot',title:'Bot',description:'',text:'SYNTHETIC_PINNED_BOT',loading:'pinned',relatedIds:[]},{id:'canon',revision:1,kind:'canon',title:'Canon',description:'',text:'SYNTHETIC_CANON_ALWAYS_PINNED',loading:'discoverable',relatedIds:[]}];
    work.profile!.promptPresets!.main!.program!.blocks.splice(1,0,{id:'description',title:'Description',kind:'slot',role:'system',slot:'description'},{id:'lore',title:'Lore',kind:'slot',role:'system',slot:'lore'},{id:'state',title:'State',kind:'slot',role:'user',slot:'state'});
    work.story={config:{...defaultStoryConfig(),revision:1,module:{id:'coins',revision:1,name:'Coins',mode:'authoritative',fields:{coins:{type:'number',initial:0,min:0,max:100,description:'Synthetic coins'}},rules:{}}},state:{id:'state',sourceRevision:null,sourceHash:null,moduleRevision:1,values:{coins:7},canonical:true},waiting:false,lineageHash:'synthetic',canonHash:'synthetic',memory:null,models:{}};
    const built=buildMainProviderRequest(compileSnapshotPrompt(work)),source=built.request.input.source as Record<string,Json>;expect(source.pinnedSources).toEqual([]);expect(source.facts).toEqual([]);expect(source.state).toBeUndefined();
    const messages=built.request.prompt!.messages;expect(messages.find(m=>m.id==='state')?.content[0].text).toContain('"coins":7');expect(messages.find(m=>m.id==='native.host-context')?.content[0].text).not.toContain('"coins":7');
    const wire=JSON.stringify(encodeMainPreview(built.request,work.profile!.models.main!).body);for(const marker of ['SYNTHETIC_PINNED_BOT','SYNTHETIC_CANON_ALWAYS_PINNED'])expect(wire.split(marker).length-1).toBe(1);
  });
});
