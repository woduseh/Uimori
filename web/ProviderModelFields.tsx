import type { Connection, ModelPreset } from '../core/product.js';
import { VERTEX_GEMINI_MAX_OUTPUT_TOKENS, VERTEX_GEMINI_MODEL_ID } from '../core/product.js';
import { defaultEvaluationToolOptions, type EvaluationToolOptions } from '../core/evaluation-tool-config.js';

export type ModelDraft = {
  title:string; connectionRef:string; modelId:string; maxOutputTokens:number; temperature:string;
  thinkingLevel:NonNullable<ModelPreset['thinkingLevel']> | ''; timeoutSeconds:string;
  structuredOutput:'default'|'on'|'off'; reasoningEffort:string; thinkingMode:string; thinkingBudgetTokens:number;
  enabled:boolean; evaluationToolsEnabled:boolean; evaluationTools:EvaluationToolOptions;
  userOverrides?:{tools:boolean|null;structuredOutput:boolean|null;note:string};
};
export const initialModel=():ModelDraft=>({title:'',connectionRef:'',modelId:'',maxOutputTokens:8192,temperature:'',thinkingLevel:'',timeoutSeconds:'300',structuredOutput:'default',reasoningEffort:'',thinkingMode:'',thinkingBudgetTokens:2048,enabled:true,evaluationToolsEnabled:false,evaluationTools:defaultEvaluationToolOptions()});
export function modelDraft(value:ModelPreset):ModelDraft{
  return{title:value.title,connectionRef:`${value.connectionId}@${value.connectionRevision}`,modelId:value.modelId,maxOutputTokens:value.maxOutputTokens,temperature:value.temperature===null?'':String(value.temperature),thinkingLevel:value.thinkingLevel??'',timeoutSeconds:value.timeoutMs===undefined?'':String(value.timeoutMs/1000),structuredOutput:value.structuredOutput===undefined?'default':value.structuredOutput?'on':'off',reasoningEffort:value.reasoningEffort??'',thinkingMode:value.thinkingMode??'',thinkingBudgetTokens:value.thinkingBudgetTokens??2048,enabled:value.enabled!==false,evaluationToolsEnabled:value.evaluationTools!==undefined,evaluationTools:structuredClone(value.evaluationTools??defaultEvaluationToolOptions()),...(value.userOverrides?{userOverrides:structuredClone(value.userOverrides)}:{})};
}
export function selectModelConnection(draft:ModelDraft,connection:Connection):ModelDraft{
  const vertex=connection.protocol==='vertex-gemini-v1';
  return{...draft,connectionRef:`${connection.id}@${connection.revision}`,modelId:vertex?VERTEX_GEMINI_MODEL_ID:'',maxOutputTokens:vertex?Math.min(draft.maxOutputTokens,VERTEX_GEMINI_MAX_OUTPUT_TOKENS):draft.maxOutputTokens,temperature:'',thinkingLevel:vertex?'MEDIUM':'',timeoutSeconds:connection.protocol==='fixture-sse-v1'?'':draft.timeoutSeconds||'300',structuredOutput:'default',reasoningEffort:'',thinkingMode:'',thinkingBudgetTokens:2048,userOverrides:undefined};
}
export function modelPayload(draft:ModelDraft,connection:Connection){
  const vertex=connection.protocol==='vertex-gemini-v1',fixture=connection.protocol==='fixture-sse-v1',anthropic=connection.protocol==='anthropic-messages-v1',codex=connection.protocol==='codex-app-server-v1';
  return{title:draft.title,connectionId:connection.id,connectionRevision:connection.revision,modelId:draft.modelId,maxOutputTokens:draft.maxOutputTokens,temperature:vertex||codex||draft.temperature===''?null:Number(draft.temperature),enabled:draft.enabled,
    ...((vertex||fixture)&&draft.thinkingLevel?{thinkingLevel:draft.thinkingLevel}:{}),
    ...(draft.timeoutSeconds!==''?{timeoutMs:Math.round(Number(draft.timeoutSeconds)*1000)}:{}),
    ...(!vertex&&!fixture?{...(!codex&&draft.structuredOutput!=='default'?{structuredOutput:draft.structuredOutput==='on'}:{}),...(draft.reasoningEffort?{reasoningEffort:draft.reasoningEffort}:{}),...(anthropic&&draft.thinkingMode?{thinkingMode:draft.thinkingMode,...(draft.thinkingMode==='enabled'?{thinkingBudgetTokens:draft.thinkingBudgetTokens}:{})}:{})}:{}),
    ...(draft.evaluationToolsEnabled?{evaluationTools:draft.evaluationTools}:{}),...(draft.userOverrides?{userOverrides:draft.userOverrides}:{})};
}

export function ProviderModelFields({value,onChange,connection,section}:{section:'basic'|'generation'|'advanced';value:ModelDraft;onChange:(value:ModelDraft)=>void;connection:Connection|undefined}){
  const vertex=connection?.protocol==='vertex-gemini-v1',fixture=connection?.protocol==='fixture-sse-v1',anthropic=connection?.protocol==='anthropic-messages-v1',codex=connection?.protocol==='codex-app-server-v1';
  const update=(next:Partial<ModelDraft>)=>onChange({...value,...next});const evaluation=value.evaluationTools;
  const setEvaluation=(next:EvaluationToolOptions)=>update({evaluationTools:next});
  const override=(key:'tools'|'structuredOutput'|'note',next:boolean|null|string)=>update({userOverrides:{tools:null,structuredOutput:null,note:'',...value.userOverrides,[key]:next}});
  return<>
    <div className="provider-model-section full" data-model-section="basic" hidden={section!=='basic'}>
      <label className="full">모델 ID<input aria-label="모델 ID" list="available-models" required readOnly={vertex} value={value.modelId} onChange={event=>update({modelId:event.target.value})}/><datalist id="available-models">{connection?.catalog.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</datalist><small>목록에서 고르거나 모델 ID를 직접 입력해요. ID 입력만으로 공급자 지원 여부가 확인되지는 않아요.</small></label>
    </div>
    <div className="provider-model-section full" data-model-section="generation" hidden={section!=='generation'}>
      <label>{codex?'출력 목표 토큰':'최대 출력 토큰'}<input aria-label={codex?'출력 목표 토큰':'최대 출력 토큰'} type="number" min={1} max={vertex?VERTEX_GEMINI_MAX_OUTPUT_TOKENS:200000} required value={value.maxOutputTokens} onChange={event=>update({maxOutputTokens:Number(event.target.value)})}/></label>
      {vertex?<label>생각 수준<select aria-label="생각 수준" value={value.thinkingLevel||'MEDIUM'} onChange={event=>update({thinkingLevel:event.target.value as ModelDraft['thinkingLevel']})}>{['LOW','MEDIUM','HIGH'].map(item=><option key={item}>{item}</option>)}</select></label>:!codex&&<label>Temperature<input aria-label="Temperature" type="number" step={0.1} min={0} max={anthropic?1:2} placeholder="공급자 기본값" value={value.temperature} onChange={event=>update({temperature:event.target.value})}/></label>}
      {!fixture&&<label>응답 제한 시간 (초)<input aria-label="응답 제한 시간 (초)" type="number" step="any" min={0.001} max={1800} placeholder="앱 기본값" value={value.timeoutSeconds} onChange={event=>update({timeoutSeconds:event.target.value})}/></label>}
      <label className="check"><input type="checkbox" checked={value.enabled} onChange={event=>update({enabled:event.target.checked})}/>새 모델 선택에 표시</label>
      {codex?<small className="full">출력 목표 토큰은 Uimori의 출력 목표이며 Codex 내부 hard budget을 보장하지 않아요.</small>:vertex?<small className="full">Gemini 3.8 Flash는 Temperature를 사용하지 않아요. Flex는 응답이 늦을 수 있어 제한 시간을 최대 1800초까지 늘릴 수 있어요.</small>:<small className="full">모델의 옵션 지원 여부를 확인해 저장하세요. 미지원 옵션 때문에 실패해도 앱이 옵션을 바꿔 자동 재요청하지 않아요.</small>}
    </div>
    <div className="provider-model-section full" data-model-section="advanced" hidden={section!=='advanced'}>
      {connection&&!vertex&&!fixture&&<details className="full"><summary>선택 옵션 · 모델이 지원할 때 사용</summary><div className="editor-grid">
        {codex?<p className="full">Codex 번역은 고정된 구조화 출력 계약을 사용해요.</p>:<label>번역 구조화 출력<select aria-label="번역 구조화 출력" value={value.structuredOutput} onChange={event=>update({structuredOutput:event.target.value as ModelDraft['structuredOutput']})}><option value="default">연결 기본값</option><option value="on">JSON Schema 사용</option><option value="off">지침과 결과 검증만 사용</option></select></label>}
        <label>Reasoning effort<select aria-label="Reasoning effort" value={value.reasoningEffort} onChange={event=>update({reasoningEffort:event.target.value})}><option value="">공급자 기본값</option>{(anthropic?['low','medium','high','xhigh','max']:codex?['none','minimal','low','medium','high','xhigh','max']:['none','minimal','low','medium','high','xhigh']).map(item=><option key={item}>{item}</option>)}</select></label>
        {anthropic&&<><label>Thinking<select aria-label="Thinking" value={value.thinkingMode} onChange={event=>update({thinkingMode:event.target.value})}><option value="">공급자 기본값</option><option value="disabled">disabled</option><option value="adaptive">adaptive</option><option value="enabled">enabled · 토큰 예산 지정</option></select></label>{value.thinkingMode==='enabled'&&<label>Thinking 토큰 예산<input aria-label="Thinking 토큰 예산" type="number" min={1024} max={value.maxOutputTokens-1} value={value.thinkingBudgetTokens} onChange={event=>update({thinkingBudgetTokens:Number(event.target.value),temperature:''})}/></label>}</>}
        <small className="full">OpenAI Responses·Anthropic은 번역에 JSON Schema를 기본 사용해요. Vercel·별도 호환 공급자는 기본 미사용이며 결과 검증은 항상 적용해요.</small>
      </div></details>}
      <fieldset className="editor-fields full"><legend>선택형 평가 도구</legend>
        <label className="check full"><input type="checkbox" checked={value.evaluationToolsEnabled} onChange={event=>update({evaluationToolsEnabled:event.target.checked})}/>이 모델 프리셋에 평가 도구 4개 사용</label>
        {value.evaluationToolsEnabled&&value.userOverrides?.tools===false&&<p className="error full" role="alert">도구 호출을 미지원으로 설정했어요. 평가 도구를 끄거나 지원 판단을 수정한 뒤 저장하세요.</p>}
        {value.evaluationToolsEnabled&&<>
          <label className="full">평가 문맥 제공<select aria-label="평가 문맥 제공" value={evaluation.contextMode} onChange={event=>setEvaluation({...evaluation,contextMode:event.target.value as EvaluationToolOptions['contextMode']})}><option value="model-selected">모델이 네 도구 중 선택</option><option value="preloaded">문맥·검토자 결과를 먼저 제공</option></select></label>
          {evaluation.contextMode==='preloaded'&&<label className="full">첫 case 라운드 추론<select aria-label="첫 case 라운드 추론" value={evaluation.approvalReasoningMode} onChange={event=>setEvaluation({...evaluation,approvalReasoningMode:event.target.value as EvaluationToolOptions['approvalReasoningMode']})}><option value="configured">프리셋 설정 유지</option><option value="economized">8,000 토큰·low로 절약</option></select></label>}
          <label>최대 평가 도구 라운드<input aria-label="최대 평가 도구 라운드" type="number" min={0} max={32} required value={evaluation.maximumToolRounds} onChange={event=>setEvaluation({...evaluation,maximumToolRounds:Number(event.target.value)})}/></label>
          <label className="check"><input type="checkbox" checked={evaluation.terminalLateCorrections} onChange={event=>setEvaluation({...evaluation,terminalLateCorrections:event.target.checked})}/>제출 원고의 정확한 문자열 교정 허용</label>
          <label className="check"><input type="checkbox" checked={evaluation.outputRecovery} onChange={event=>setEvaluation({...evaluation,outputRecovery:event.target.checked})}/>명확한 거절 제출은 한 번 재요청</label>
        </>}
        <small className="full">선택한 프리셋에서만 eval_get_context, eval_get_reviewer, eval_create_case, eval_submit_artifact를 사용해요. preloaded는 앞의 두 결과를 호출 이력으로 제공하고 case·submit만 노출해요. 절약 모드는 첫 case 라운드에서만 출력 상한과 설정된 reasoning effort를 낮춰요. 별도 안내문은 원문에 합치지 않아요.</small>
      </fieldset>
      <details className="full"><summary>기능 확인과 사용자 판단</summary><div className="editor-grid">
        <p className="full">공급자의 모델별 기능과 가격은 미확인이에요. 아래 값은 사용자가 직접 확인한 판단으로 따로 기록하며 인증·권한을 추가하지 않아요.</p>
        {(['tools','structuredOutput'] as const).map((key,index)=><label key={key}>{index===0?'도구 호출 지원 판단':'구조화 출력 지원 판단'}<select aria-label={index===0?'도구 호출 지원 판단':'구조화 출력 지원 판단'} value={value.userOverrides?.[key]===true?'yes':value.userOverrides?.[key]===false?'no':'unknown'} onChange={event=>override(key,event.target.value==='unknown'?null:event.target.value==='yes')}><option value="unknown">미확인</option><option value="yes">사용자 확인 · 지원</option><option value="no">사용자 확인 · 미지원</option></select></label>)}
        <label className="full">기능 판단 메모<textarea aria-label="기능 판단 메모" maxLength={2000} value={value.userOverrides?.note??''} onChange={event=>override('note',event.target.value)}/></label>
        {value.userOverrides&&<button type="button" className="secondary" onClick={()=>update({userOverrides:undefined})}>사용자 판단 지우기</button>}
      </div></details>
    </div>
  </>;
}
