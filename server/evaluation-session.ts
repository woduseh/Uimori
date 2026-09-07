import type { ModelGeneration, ModelPreset } from '../core/product.js';
import { defaultEvaluationToolOptions, validateEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import { EVALUATION_TOOL_NAMES, createEvaluationSession, evaluationBootstrap, evaluationToolDefinitions, executeEvaluationTool, extractEvaluationArtifact, retryableEvaluationRefusal } from '../core/evaluation-tools.js';
import type { ProviderToolCall } from '../core/transport.js';
import type { ProviderResult } from '../core/transport.js';

export function createEvaluationToolSession(target:(ModelPreset&{connection:unknown})|undefined,timeoutMs?:number){
  if(!target?.evaluationTools)return undefined;
  const options=validateEvaluationToolOptions(target.evaluationTools??defaultEvaluationToolOptions());const session=createEvaluationSession();
  const duration=timeoutMs??target.timeoutMs??600_000;if(!Number.isSafeInteger(duration)||duration<1||duration>1_800_000)throw new Error('INVALID_TIMEOUT');const deadline=Date.now()+duration;
  let refusalRetryUsed=false;
  return{
    options,session,definitions:evaluationToolDefinitions(options),allNames:[...EVALUATION_TOOL_NAMES],bootstrap:options.contextMode==='preloaded'?evaluationBootstrap(session):[],maxCalls:options.maximumToolRounds+1,
    toolChoice:(completedToolResults:number)=>options.contextMode==='preloaded'?(completedToolResults===0?'eval_create_case':'auto'):undefined,
    generation:(base:ModelGeneration,completedToolResults:number):ModelGeneration=>{
      if(options.contextMode!=='preloaded'||completedToolResults!==0||options.approvalReasoningMode==='configured')return structuredClone(base);
      return{...structuredClone(base),maxOutputTokens:Math.min(base.maxOutputTokens,8000),...(base.reasoningEffort!==undefined?{reasoningEffort:base.reasoningEffort==='none'?'none':'low'}:{})};
    },
    generationBinding:(base:ModelGeneration,completedToolResults:number):ModelGeneration|undefined=>options.contextMode==='preloaded'&&completedToolResults===0&&options.approvalReasoningMode==='economized'?structuredClone(base):undefined,
    diagnosticResult:(result:ProviderResult):ProviderResult=>({...structuredClone(result),toolCalls:result.toolCalls.map(call=>call.name==='eval_submit_artifact'?{...call,arguments:{}}:call)}),
    remainingMs:()=>Math.max(0,deadline-Date.now()),
    execute:(call:ProviderToolCall)=>executeEvaluationTool(call,options,session),
    submit:(call:ProviderToolCall,recoveredFromTruncation=false)=>{
      try{const artifact=extractEvaluationArtifact(call.arguments,options,recoveredFromTruncation);if(options.outputRecovery&&retryableEvaluationRefusal(artifact.text)&&!refusalRetryUsed){refusalRetryUsed=true;return{ok:false as const,event:{callId:call.id,name:call.name,args:{},denied:false,result:{error:{code:'OUTPUT_VALIDATION_FAILED',requiredAction:'submit-completed-artifact'}}}};}return{ok:true as const,artifact};}
      catch{return{ok:false as const,event:{callId:call.id,name:call.name,args:{},denied:false,result:{error:{code:'INVALID_EVALUATION_TOOL_ARGUMENTS'}}}};}
    },
  };
}
