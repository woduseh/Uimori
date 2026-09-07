import { describe, expect, it, vi } from 'vitest';
import { behaviorActionTriggers, evaluateBehaviorAction, validatePackageBehavior, type BehaviorAction, type PackageBehavior } from '../core/package-behavior.js';
import { evaluatePromptExpression, type PromptExpression, type RuntimeValue } from '../core/prompt-program.js';

function definition(action:Partial<BehaviorAction>={}):PackageBehavior {
  return {
    revision:1,schemaVersion:1,
    stateSchema:{type:'record',properties:{energy:{type:'number',min:0,max:100},lastRoll:{type:'number',min:0,max:6}}},
    initialState:{energy:10,lastRoll:0},
    actions:[{
      id:'check',inputSchema:{type:'record',properties:{cost:{type:'number',min:0,max:10}}},
      when:{op:'gte',args:[{context:['state','energy']},{context:['input','cost']}]},
      draws:[{id:'die',type:'integer',min:1,max:6}],
      effects:[{path:['energy'],value:{op:'subtract',args:[{context:['state','energy']},{context:['input','cost']}]}},{path:['lastRoll'],value:{context:['draws','die']}}],
      ...action,
    }],outputParsers:[],
  };
}
function evaluate(b:PackageBehavior,input:RuntimeValue={cost:3},draws:Record<string,RuntimeValue>={die:4},runtime:Record<string,RuntimeValue>={}) {
  return evaluateBehaviorAction(b,b.actions[0],b.initialState,input,draws,runtime);
}

describe('shared package behavior action calculation',()=>{
  it('keeps omitted triggers as user actions and preserves explicitly disabled actions',()=>{
    const b=validatePackageBehavior(definition());
    expect(behaviorActionTriggers(b.actions[0])).toEqual(['user']);
    const triggers=behaviorActionTriggers(b.actions[0]);triggers.push('model');
    expect(behaviorActionTriggers(b.actions[0])).toEqual(['user']);
    expect(behaviorActionTriggers(validatePackageBehavior(definition({triggers:[]})).actions[0])).toEqual([]);
    expect(behaviorActionTriggers(validatePackageBehavior(definition({triggers:['user','before-turn','model'],automaticInput:{cost:1}})).actions[0])).toEqual(['user','before-turn','model']);
  });

  it.each([['model','model'],['turn'],[false],null])('rejects invalid trigger declarations %j',triggers=>{
    expect(()=>validatePackageBehavior(definition({triggers:triggers as BehaviorAction['triggers']}))).toThrow('BEHAVIOR_ACTION_TRIGGERS');
  });

  it('validates automatic input at registration and allows the empty-record default only for its matching schema',()=>{
    expect(()=>validatePackageBehavior(definition({triggers:['before-turn']}))).toThrow('BEHAVIOR_RECORD_FIELDS');
    expect(()=>validatePackageBehavior(definition({triggers:['before-turn'],automaticInput:{cost:11}}))).toThrow('BEHAVIOR_NUMBER_VALUE');
    expect(()=>validatePackageBehavior(definition({automaticInput:{cost:1}}))).toThrow('BEHAVIOR_AUTOMATIC_INPUT_TRIGGER');
    expect(()=>validatePackageBehavior(definition({triggers:['before-turn'],inputSchema:{type:'record',properties:{}}}))).not.toThrow();
    expect(()=>validatePackageBehavior(definition({triggers:['before-turn'],inputSchema:{type:'boolean'},automaticInput:false}))).not.toThrow();
  });

  it('requires record inputs for model tools while retaining typed direct-user inputs',()=>{
    expect(()=>validatePackageBehavior(definition({triggers:['model'],inputSchema:{type:'boolean'}}))).toThrow('BEHAVIOR_MODEL_INPUT_ROOT');
    expect(()=>validatePackageBehavior(definition({inputSchema:{type:'boolean'}}))).not.toThrow();
  });

  it('produces the same state and compact result from the same supplied draw without ambient randomness',()=>{
    const b=validatePackageBehavior(definition());
    const random=vi.spyOn(Math,'random').mockImplementation(()=>{throw new Error('ambient randomness');});
    try {
      const first=evaluate(b);
      expect(first).toEqual({state:{energy:7,lastRoll:4},result:{applied:true,draws:{die:4}}});
      expect(evaluate(b)).toEqual(first);
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });

  it('projects an explicit result from before state, input, draws, host context and validated next state',()=>{
    const b=validatePackageBehavior(definition({result:{op:'object',args:[
      'spent',{op:'subtract',args:[{context:['state','energy']},{context:['nextState','energy']}]},
      'cost',{context:['input','cost']},'roll',{context:['draws','die']},'place',{context:['location']},
    ]}}));
    const input={cost:3},draws={die:4},runtime={state:{energy:99},input:{cost:99},draws:{die:99},nextState:{energy:99},location:'library'};
    const original=structuredClone({b,input,draws,runtime});
    const result=evaluate(b,input,draws,runtime);
    expect(result).toEqual({state:{energy:7,lastRoll:4},result:{spent:3,cost:3,roll:4,place:'library'}});
    expect({b,input,draws,runtime}).toEqual(original);
    (result.state as Record<string,RuntimeValue>).energy=90;
    (result.result as Record<string,RuntimeValue>).place='outside';
    expect({b,input,draws,runtime}).toEqual(original);
  });

  it('evaluates every effect against the before state and hides nextState until result projection',()=>{
    const b=validatePackageBehavior(definition({effects:[
      {path:['energy'],value:0},
      {path:['lastRoll'],value:{op:'typedIf',args:[{op:'typedEqual',args:[{context:['state','energy']},10]},6,1]}},
    ],result:{context:['nextState']}}));
    expect(evaluate(b)).toEqual({state:{energy:0,lastRoll:6},result:{energy:0,lastRoll:6}});
    const unavailable=definition({when:{op:'typedEqual',args:[{context:['nextState']},null]}});
    expect(evaluate(unavailable,{cost:3},{die:4},{nextState:{energy:999}}).state).toEqual({energy:7,lastRoll:4});
  });

  it('checks eligibility before effects and result, and requires a boolean condition',()=>{
    const effect={path:['energy'],value:{op:'divide',args:[1,0]} as PromptExpression};
    const disabled=definition({when:false,effects:[effect],result:{op:'divide',args:[1,0]}});
    expect(()=>evaluate(disabled)).toThrow('BEHAVIOR_ACTION_DISABLED');
    expect(disabled.initialState).toEqual({energy:10,lastRoll:0});
    expect(()=>evaluate(definition({when:1}))).toThrow('BEHAVIOR_CONDITION_NOT_BOOLEAN');
    expect(()=>evaluate(definition(),{cost:11})).toThrow('BEHAVIOR_NUMBER_VALUE');
  });

  it('rejects a bad whole next state or result without mutating any supplied state',()=>{
    const invalid=definition({effects:[{path:['energy'],value:101}]});
    expect(()=>evaluate(invalid)).toThrow('BEHAVIOR_NUMBER_VALUE');
    expect(invalid.initialState).toEqual({energy:10,lastRoll:0});
    const resultFailure=definition({result:{op:'divide',args:[1,0]}});
    expect(()=>evaluate(resultFailure)).toThrow('PROMPT_DIVISION_BY_ZERO');
    expect(resultFailure.initialState).toEqual({energy:10,lastRoll:0});
  });

  it('enforces the exact serialized 8000-character result bound, including JSON escaping',()=>{
    expect((evaluate(definition({result:'x'.repeat(7998)})).result as string).length).toBe(7998);
    const tooLong=definition({result:'x'.repeat(7999)});
    expect(()=>evaluate(tooLong)).toThrow('BEHAVIOR_RESULT_SIZE');
    expect(tooLong.initialState).toEqual({energy:10,lastRoll:0});
    expect(()=>evaluate(definition({result:'\n'.repeat(4000)}))).toThrow('BEHAVIOR_RESULT_SIZE');
    expect(()=>evaluate(definition(),{cost:3},{die:4,large:'x'.repeat(8000)})).toThrow('BEHAVIOR_RESULT_SIZE');
  });

  it('shares one execution budget across condition, effects and result',()=>{
    const sum:PromptExpression={op:'sum',args:[{op:'range',args:[0,1000]}]};
    const expensive:PromptExpression={op:'sum',args:Array.from({length:20},()=>sum)};
    const b=definition({when:{op:'gte',args:[expensive,0]},effects:[{path:['energy'],value:{op:'mod',args:[expensive,100]}}],result:expensive});
    expect(evaluatePromptExpression(expensive)).toBe(9990000);
    expect(()=>evaluate(b)).toThrow('PROMPT_STEP_LIMIT');
    expect(b.initialState).toEqual({energy:10,lastRoll:0});
  });

  it('rejects getter-bearing host data before reading or copying it',()=>{
    let reads=0;
    const host=Object.defineProperty({},'location',{enumerable:true,get(){reads++;return 'secret';}});
    expect(()=>evaluate(definition(),{cost:3},{die:4},host)).toThrow('BEHAVIOR_ACCESSOR');
    expect(reads).toBe(0);
  });

  it('rejects unsupported ambient operations in result expressions at registration',()=>{
    expect(()=>validatePackageBehavior(definition({result:{op:'random',args:[]} as unknown as PromptExpression}))).toThrow('PROMPT_INVALID_EXPRESSION');
  });
});
