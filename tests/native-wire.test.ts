import { describe, expect, test } from 'vitest';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { encodeChat, ChatDecoder } from '../core/openai-chat-protocol.js';
import { encodeAnthropic, AnthropicDecoder } from '../core/anthropic-protocol.js';
import { encodeVertex, VertexDecoder } from '../core/vertex-protocol.js';
import { encodeSolResponses } from '../core/sol-protocol.js';
import { VERTEX_GEMINI_MODEL_ID } from '../core/product.js';
import type { LogicalMessage, ProviderPrompt } from '../core/prompt-program.js';
import type { Json, ProviderRequest, ProviderResult } from '../core/transport.js';
const wire=(value:Json)=>value as Record<string,any>;
const message=(id:string,role:LogicalMessage['role'],text:string):LogicalMessage=>({id,role,content:[{type:'text',text}],completion:'complete',provenance:{blockId:id,origin:id==='current'?'current':id==='history'?'history':'prompt'}});
const prompt=():ProviderPrompt=>({compilerVersion:'uimori-prompt-1',values:{length:'standard'},messages:[message('system','system','NATIVE_SYSTEM'),message('old-user','user','EARLIER_REQUEST'),message('history','assistant','COMPLETED_PROSE'),message('current','user','CURRENT_REQUEST')],cachePlan:[]});
const request=(modelId='gpt-5.6'):ProviderRequest=>({role:'main',modelId,stable:{contract:'HOST_CONTRACT',tools:[{name:'knowledge.read',description:'read synthetic data',inputSchema:{type:'object',properties:{id:{type:'string'}}}}]},input:{task:'DUPLICATE_TASK_SENTINEL',controls:{flag:false},source:null,catalog:[],history:[{text:'DUPLICATE_HISTORY_SENTINEL'}],results:[]},prompt:prompt()});
const next=(original:ProviderRequest,result:ProviderResult):ProviderRequest=>({...structuredClone(original),opaqueState:result.opaqueState,input:{...structuredClone(original.input),results:[...original.input.results as Json[],...result.toolCalls.map(c=>({callId:c.id,name:c.name,args:c.arguments,result:{found:false,count:0},denied:false}))]}});
function responseRound(input:ProviderRequest,id:string) {const encoded=encodeResponses(input);const decoder=new ResponsesDecoder(encoded.context);const signed={type:'reasoning',id:`rs-${id}`,summary:[],encrypted_content:`signed-${id}`};const call={type:'function_call',id:`fc-${id}`,call_id:`Call.${id}`,name:'tool_0_knowledge_read',arguments:'{"id":"synthetic"}',status:'completed'};decoder.accept({type:'response.completed',response:{id:`r-${id}`,status:'completed',output:[signed,call]}});return{result:decoder.finish(),signed,call};}

describe('native provider wire (synthetic, no live calls)',()=>{
  test('preserves roles/order and sends current/history once across four codecs',()=>{
    const r=request();const before=structuredClone(r);const responses=wire(encodeResponses(r).body);expect(responses.input.map((m:any)=>m.role)).toEqual(['system','user','assistant','user']);expect(responses.input[2].content[0].text).toBe('COMPLETED_PROSE');
    const chat=wire(encodeChat(r).body);expect(chat.messages.map((m:any)=>m.role)).toEqual(['system','system','user','assistant','user']);
    const anthropic=wire(encodeAnthropic(request('claude-sonnet-4-6')).body);expect(anthropic.messages.map((m:any)=>m.role)).toEqual(['user','assistant','user']);expect(anthropic.system.at(-1).text).toBe('NATIVE_SYSTEM');
    const vertex=wire(encodeVertex(request(VERTEX_GEMINI_MODEL_ID)).body);expect(vertex.contents.map((m:any)=>m.role)).toEqual(['user','model','user']);expect(vertex.systemInstruction.parts.at(-1).text).toBe('NATIVE_SYSTEM');
    for(const body of [responses,chat,anthropic,vertex]) {const encoded=JSON.stringify(body);expect(encoded).not.toMatch(/DUPLICATE_TASK_SENTINEL|DUPLICATE_HISTORY_SENTINEL|Request data \(JSON\)/);expect(encoded.split('CURRENT_REQUEST')).toHaveLength(2);}
    expect(r).toEqual(before);
  });
  test('native cache is explicit for eligible Responses, Anthropic; compatible chat and Sol remain unsupported',()=>{
    const r=request();r.prompt!.cachePlan=[{blockId:'cache',afterMessageId:'system',policy:'prefer'}];
    const responses=wire(encodeResponses(r).body);expect(responses.prompt_cache_options).toEqual({mode:'explicit'});expect(responses.input[0].content[0].prompt_cache_breakpoint).toEqual({mode:'explicit'});
    const a=wire(encodeAnthropic({...r,modelId:'claude-sonnet-4-6'}).body);expect(a.system.at(-1).cache_control).toEqual({type:'ephemeral'});
    expect(wire(encodeChat(r).body)).not.toHaveProperty('prompt_cache_options');expect(wire(encodeResponses(r,'sol-responses-v1').body)).not.toHaveProperty('prompt_cache_options');
    const sol=wire(encodeSolResponses(r,'https://api.openai.com/v1').body);expect(sol).not.toHaveProperty('prompt_cache_options');
    r.prompt!.cachePlan[0].policy='require';expect(()=>encodeChat(r)).toThrow('PROMPT_CACHE_UNSUPPORTED');expect(()=>encodeResponses(r,'sol-responses-v1')).toThrow('PROMPT_CACHE_UNSUPPORTED');
  });
  test('rejects prefill and unsupported mid-system instead of flattening the prompt',()=>{
    for(const [encoder,model] of [[encodeResponses,'gpt-5.6'],[encodeChat,'gpt-5.6'],[encodeAnthropic,'claude-sonnet-4-6'],[encodeVertex,VERTEX_GEMINI_MODEL_ID]] as const) {const r=request(model);r.prompt!.messages.at(-1)!.completion='prefill';expect(()=>encoder(r)).toThrow('PROMPT_PREFILL_UNSUPPORTED');}
    const r=request('claude-sonnet-4-6');r.prompt!.messages.splice(2,0,message('middle','system','MIDDLE_RULE'));
    expect(()=>encodeAnthropic(r)).toThrow('PROMPT_MID_SYSTEM_MODEL_UNSUPPORTED');expect(()=>encodeVertex({...r,modelId:VERTEX_GEMINI_MODEL_ID})).toThrow('PROMPT_MID_SYSTEM_UNSUPPORTED');
    const supported=wire(encodeAnthropic({...r,modelId:'claude-opus-4-8'}).body);expect(supported.messages.map((m:any)=>m.role)).toEqual(['user','system','assistant','user']);
    r.prompt!.messages.splice(2,1);r.prompt!.messages.splice(3,0,message('bad-placement','system','MIDDLE_RULE'));expect(()=>encodeAnthropic({...r,modelId:'claude-opus-4-8'})).toThrow('PROMPT_MID_SYSTEM_PLACEMENT_UNSUPPORTED');
  });
  test('Responses two tool rounds preserve native prefix, original signed items, cache and call IDs; altered prompt rejected',()=>{
    const r=request();r.prompt!.cachePlan=[{blockId:'cache',afterMessageId:'system',policy:'prefer'}];const first=wire(encodeResponses(r).body);const one=responseRound(r,'one');const secondRequest=next(r,one.result);const second=wire(encodeResponses(secondRequest).body);
    expect(second.input.slice(0,4)).toEqual(first.input);expect(second.input.slice(4,6)).toEqual([one.signed,one.call]);expect(second.input.at(-1)).toEqual({type:'function_call_output',call_id:'Call.one',output:'{"found":false,"count":0}'});
    const two=responseRound(secondRequest,'two');const thirdRequest=next(secondRequest,two.result);const third=wire(encodeResponses(thirdRequest).body);expect(third.input.slice(0,second.input.length)).toEqual(second.input);expect(third.input.at(-1).call_id).toBe('Call.two');expect(third.prompt_cache_options).toEqual(first.prompt_cache_options);
    const changed=structuredClone(thirdRequest);changed.prompt!.values.length='long';expect(()=>encodeResponses(changed)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('Chat native continuation retains provider reasoning and matches exact call IDs',()=>{
    const r=request();const encoded=encodeChat(r);const d=new ChatDecoder(encoded.context);d.accept({id:'chat',choices:[{index:0,delta:{role:'assistant',reasoning_content:'signed-chat',tool_calls:[{index:0,id:'Chat.Call',type:'function',function:{name:'tool_0_knowledge_read',arguments:'{"id":"synthetic"}'}}]},finish_reason:null}]});d.accept({id:'chat',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]});d.accept('[DONE]');const continued=next(r,d.finish());const result=wire(encodeChat(continued).body);expect(result.messages.slice(0,5)).toEqual(wire(encoded.body).messages);expect(result.messages.at(-2).reasoning_content).toBe('signed-chat');expect(result.messages.at(-1).tool_call_id).toBe('Chat.Call');continued.prompt!.messages[0].content[0].text='changed';expect(()=>encodeChat(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('Anthropic signed content and Vertex thought signatures survive native continuation',()=>{
    const r=request('claude-sonnet-4-6');const encoded=encodeAnthropic(r);const d=new AnthropicDecoder(encoded.context);
    d.accept({type:'message_start',message:{id:'m',type:'message',role:'assistant',model:r.modelId,content:[],stop_reason:null}});
    const parts=[{type:'thinking',thinking:'private reasoning',signature:'signed-thinking'},{type:'tool_use',id:'Anthropic.Call',name:'tool_0_knowledge_read',input:{id:'synthetic'}}];for(const [index,part]of parts.entries()){d.accept({type:'content_block_start',index,content_block:part});d.accept({type:'content_block_stop',index});}
    d.accept({type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null}});d.accept({type:'message_stop'});const continued=next(r,d.finish());const a=wire(encodeAnthropic(continued).body);expect(a.messages.at(-2).content).toEqual(parts);expect(a.messages.at(-1).content[0].tool_use_id).toBe('Anthropic.Call');continued.prompt!.values.length='extra';expect(()=>encodeAnthropic(continued)).toThrow('ANTHROPIC_CONTINUATION_MISMATCH');
    const v=request(VERTEX_GEMINI_MODEL_ID);const ve=encodeVertex(v);const vd=new VertexDecoder(ve.context);const signed={functionCall:{id:'Vertex.Call',name:'knowledge.read',args:{id:'synthetic'}},thoughtSignature:'signed-vertex'};vd.accept({candidates:[{index:0,content:{role:'model',parts:[signed]},finishReason:'STOP'}]});const vr=next(v,vd.finish());const vb=wire(encodeVertex(vr).body);expect(vb.contents.at(-2).parts).toEqual([signed]);expect(vb.contents.at(-1).parts[0].functionResponse.id).toBe('Vertex.Call');vr.prompt!.messages[0].content[0].text='changed';expect(()=>encodeVertex(vr)).toThrow('VERTEX_CONTINUATION_MISMATCH');
  });
  test('Anthropic accepts M2 state and memory roles without enabling a model call',()=>{for(const role of ['state','memory'] as const)expect(wire(encodeAnthropic({...request('claude-sonnet-4-6'),role}).body).messages).toHaveLength(3);});
});
