import { describe, expect, it } from 'vitest';
import { compilePromptProgram, evaluatePromptExpression, evaluatePromptExpressions, renderPromptTemplate, validatePromptExpression, validatePromptProgram, type PromptExpression, type PromptOperation, type PromptTemplate, type RuntimeValue } from '../core/prompt-program.js';
import { parsePromptTemplate, printPromptTemplate } from '../core/prompt-language.js';
import { definePrompt, each, expr, history, letValue, option, system, text } from '../core/prompt-authoring.js';
import { validateRuntimeValue } from '../core/prompt-values.js';

const op=(name:PromptOperation,...args:PromptExpression[]):PromptExpression=>({op:name,args});
const literal=(value:RuntimeValue):PromptExpression=>({literal:value});
const context=(...path:string[]):PromptExpression=>({context:path});
const evaluate=(value:PromptExpression,runtime:Record<string,RuntimeValue>={})=>evaluatePromptExpression(value,{}, {runtime});

describe('bounded data-only runtime expressions',()=>{
  it('builds immutable lists and shallow records through AST, optional syntax and TS',()=>{
    const runtime={items:[1,2],record:{a:1,nested:{old:true}}};
    expect(evaluate(op('append',context('items'),3),runtime)).toEqual([1,2,3]);
    expect(evaluate(op('concatArrays',context('items'),literal([3,4])),runtime)).toEqual([1,2,3,4]);
    expect(evaluate(op('concatArrays'))).toEqual([]);
    expect(evaluate(op('setAt',context('items'),1,9),runtime)).toEqual([1,9]);
    expect(evaluate(op('merge',context('record'),literal({b:2,nested:{next:true}})),runtime)).toEqual({a:1,b:2,nested:{next:true}});
    expect(runtime).toEqual({items:[1,2],record:{a:1,nested:{old:true}}});
    const expressions=[expr.append([1],2),expr.concatArrays([1],[2]),expr.setAt([1,2],1,3),expr.merge({a:1},{a:2,b:3})];
    expect(evaluatePromptExpressions(expressions.map(value=>value.ast))).toEqual([[1,2],[1,2],[1,3],{a:2,b:3}]);
    const nodes=parsePromptTemplate('{{ append([1],2) }}{{ concatArrays([1],[2]) }}{{ setAt([1,2],1,3) }}{{ merge({"a":1},{"b":2}) }}',[]);
    expect(parsePromptTemplate(printPromptTemplate(nodes),[])).toEqual(nodes);
    expect(renderPromptTemplate(nodes)).toBe('[1,2][1,2][1,3]{"a":1,"b":2}');
  });
  it('rejects list and record type, index and size violations',()=>{
    for(const value of [op('append','x',1),op('concatArrays',literal([]),'x'),op('setAt',literal([1]),0.5,2),op('setAt',literal([1]),-1,2),op('setAt',literal([1]),1,2),op('merge',literal([]),literal({})),op('merge',null,literal({}))])expect(()=>evaluate(value)).toThrow();
    for(const value of [op('append',literal([1,2]),3),op('concatArrays',literal([1,2]),literal([3])),op('merge',literal({a:1,b:2}),literal({c:3}))])expect(()=>evaluatePromptExpression(value,{},{limits:{maxCollectionLength:2}})).toThrow('PROMPT_COLLECTION_LIMIT');
    expect(()=>evaluatePromptExpression(op('concatArrays',literal(['abcdefgh']),literal(['abcdefgh'])),{},{limits:{maxValueChars:20}})).toThrow('PROMPT_VALUE_LIMIT');
  });
  it('shares cumulative work and aggregate result limits across a batch',()=>{
    const value=op('range',20),options={limits:{maxSteps:75}};
    expect(evaluatePromptExpression(value,{},options)).toHaveLength(20);
    expect(()=>evaluatePromptExpressions([value,value],{},options)).toThrow('PROMPT_STEP_LIMIT');
    expect(evaluatePromptExpression('abcdefgh',{},{limits:{maxValueChars:20}})).toBe('abcdefgh');
    expect(()=>evaluatePromptExpressions(['abcdefgh','abcdefgh'],{},{limits:{maxValueChars:20}})).toThrow('PROMPT_VALUE_LIMIT');
    expect(evaluatePromptExpressions([])).toEqual([]);
  });
  it('retains legacy scalar formatting, comparisons and null control behavior',()=>{
    expect(evaluatePromptExpression({control:'missing'},{})).toBe(null);
    expect(evaluate(op('equal',true,1))).toBe(true);expect(evaluate(op('greater',null,0))).toBe(false);
    expect(evaluate(op('all','2',true))).toBe(true);expect(evaluate(op('not','false'))).toBe(true);
    expect(renderPromptTemplate([{kind:'value',expression:true},{kind:'value',expression:false},{kind:'value',expression:null}])).toBe('10null');
    for(const replacement of ['$$','$&',"$'",'$`','$1','x$&y'])expect(evaluate(op('replace','ababa','a',replacement))).toBe('ababa'.replaceAll('a',replacement));
    expect(evaluate(op('replace','x'.repeat(200000),'x','y'))).toBe('y'.repeat(200000));
  });
  it.each([
    ['add',[2,3],5],['subtract',[7,2],5],['multiply',[3,4],12],['divide',[8,2],4],['mod',[7,3],1],['pow',[2,4],16],['clamp',[9,1,4],4],['round',[1.236,2],1.24],['floor',[1.9],1],['ceil',[1.1],2],['abs',[-3],3],['gt',[3,2],true],['lte',[2,2],true],
  ] as [PromptOperation,PromptExpression[],RuntimeValue][])('evaluates strict numeric %s',(name,args,result)=>{expect(evaluate(op(name,...args))).toEqual(result);});
  it('rejects coercion, nonfinite output and invalid arithmetic',()=>{
    for(const expression of [op('add','2',1),op('add',false,1),op('divide',1,0),op('mod',1,0),op('pow',10,10000),op('clamp',1,5,2),op('round',1,30)])expect(()=>evaluate(expression)).toThrow();
  });
  it('uses null-only coalescing and lazy typed/logical branches',()=>{
    for(const value of [0,false,'']){expect(evaluate(op('coalesce',value,op('divide',1,0)))).toBe(value);expect(evaluate(op('exists',value))).toBe(true);}
    expect(evaluate(op('exists',context('missing')))).toBe(false);
    expect(evaluate(op('typedIf',false,op('divide',1,0),7))).toBe(7);
    expect(evaluate(op('all',false,op('divide',1,0)))).toBe(false);
    expect(()=>evaluate(op('typedIf','true',1,2))).toThrow('PROMPT_BOOLEAN_REQUIRED');
  });
  it('reads structured paths and returns detached values without prototype access',()=>{
    const runtime={state:{hp:0,npcs:[{name:'Mira'}]}};
    expect(evaluate(context('state','hp'),runtime)).toBe(0);expect(evaluate(context('state','npcs','0','name'),runtime)).toBe('Mira');
    expect(evaluate(context('state','missing','nested'),runtime)).toBe(null);
    const copy=evaluate(context('state'),runtime) as {hp:number};copy.hp=999;expect(runtime.state.hp).toBe(0);
    expect(()=>evaluate(context('state','__proto__'),runtime)).toThrow('PROMPT_UNSAFE_PATH');
    expect(()=>evaluate(op('get',context('state'),'constructor'),runtime)).toThrow('PROMPT_UNSAFE_PATH');
    let calls=0;const getter=Object.defineProperty({},'secret',{enumerable:true,get(){calls++;return 1;}});
    expect(()=>evaluate(1,{unsafe:getter})).toThrow('PROMPT_INVALID_RUNTIME_VALUE');expect(calls).toBe(0);
    const cyclic:Record<string,RuntimeValue>={};cyclic.self=cyclic;expect(()=>validateRuntimeValue(cyclic)).toThrow('PROMPT_CYCLIC_VALUE');
  });
  it('maps and filters with lexical values and explicit indices',()=>{
    const source=literal([{hp:0},{hp:3},{hp:5}]);
    const filtered:PromptExpression={op:'filter',args:[source,op('gt',{local:'npc',path:['hp']},0)],as:'npc'};
    const mapped:PromptExpression={op:'map',args:[filtered,op('object','value',op('add',{local:'npc',path:['hp']},{local:'i'}))],as:'npc',index:'i'};
    expect(evaluate(mapped)).toEqual([{value:3},{value:6}]);
    expect(()=>validatePromptExpression({local:'npc'})).toThrow('PROMPT_UNKNOWN_LOCAL');
    expect(()=>validatePromptExpression({op:'map',args:[literal([]),1],as:'npc',index:'npc'})).toThrow('PROMPT_DUPLICATE_LOCAL');
  });
  it('provides bounded aggregate, collection and string operations',()=>{
    expect(evaluate(op('range',5,0,-2))).toEqual([5,3,1]);expect(evaluate(op('sum',literal([1,2,3])))).toBe(6);
    expect(evaluate(op('average',literal([])))).toBe(null);expect(evaluate(op('min',literal([3,1,2])))).toBe(1);
    expect(evaluate(op('unique',literal([{a:1,b:2},{b:2,a:1},false,0])))).toEqual([{a:1,b:2},false,0]);
    expect(evaluate(op('typedEqual',true,1))).toBe(false);
    expect(evaluate(op('join',op('split','a,b,c',','),'/'))).toBe('a/b/c');
    expect(evaluate(op('slice',literal([1,2,3]),-2))).toEqual([2,3]);expect(evaluate(op('size',literal({a:1,b:2})))).toBe(2);
    expect(evaluate(op('contains',op('lower',op('trim',' MIRA ')),'ira'))).toBe(true);
    expect(evaluate(op('startsWith','Mira','Mi'))).toBe(true);expect(evaluate(op('endsWith','Mira','ra'))).toBe(true);
    expect(evaluate(op('upper','Ὀδυσσεύς'))).toBe('Ὀδυσσεύς'.toUpperCase());
  });
  it('formats and advances only explicitly supplied strict UTC dates',()=>{
    const iso='2026-09-07T12:34:56.000Z';
    expect(evaluate(op('datePart',iso,'weekday'))).toBe(1);expect(evaluate(op('dateFormat',iso,'date'))).toBe('2026-09-07');
    expect(evaluate(op('dateAddDays','2024-02-28T12:00:00Z',1))).toBe('2024-02-29T12:00:00.000Z');
    for(const bad of ['2026-02-30T12:00:00Z','2026-09-07','2026-09-07T12:00:00+09:00'])expect(()=>evaluate(op('datePart',bad,'day'))).toThrow();
  });
  it('stops oversized ranges, JSON expansion, replacement expansion and repeated work',()=>{
    expect(()=>evaluate(op('range',1e12))).toThrow('PROMPT_COLLECTION_LIMIT');
    expect(()=>evaluate(op('range',0,3,0))).toThrow('PROMPT_INVALID_RANGE');
    expect(()=>evaluate(op('split','x'.repeat(2001),''))).toThrow('PROMPT_COLLECTION_LIMIT');
    expect(()=>evaluate(op('replace','a'.repeat(2000),'a','$`'))).toThrow('PROMPT_VALUE_LIMIT');
    expect(()=>validateRuntimeValue('\u0000'.repeat(200000))).toThrow('PROMPT_VALUE_LIMIT');
    expect(()=>evaluatePromptExpression(op('range',100),{},{limits:{maxSteps:10}})).toThrow('PROMPT_STEP_LIMIT');
    const nodes:PromptTemplate=[{kind:'each',source:op('range',2000),as:'item',body:[{kind:'text',text:'x'.repeat(1000)}]}];
    expect(()=>renderPromptTemplate(nodes)).toThrow('PROMPT_OUTPUT_LIMIT');
    expect(()=>evaluatePromptExpression(op('upper','ß'.repeat(1000)),{},{limits:{maxValueChars:1500}})).toThrow('PROMPT_VALUE_LIMIT');
  });
});

describe('runtime template and authoring integration',()=>{
  it('uses each/let lexical scope and preserves data that looks like source',()=>{
    const template=parsePromptTemplate('{% let prefix = "<" %}{% each item, i in context.items %}{{ local.prefix }}{{ local.i }}:{{ local.item.name }}{% else %}empty{% endeach %}{% endlet %}',[]);
    expect(renderPromptTemplate(template,{}, {},{runtime:{items:[{name:'{{ unknown }}'},{name:'Mira'}]}})).toBe('<0:{{ unknown }}<1:Mira');
    expect(renderPromptTemplate(template,{}, {},{runtime:{items:[]}})).toBe('empty');
    expect(()=>parsePromptTemplate('{% each item in context.items %}x{% endeach %}{{ local.item }}',[])).toThrow('PROMPT_UNKNOWN_LOCAL');
    expect(()=>parsePromptTemplate('{% let x = 1 %}{% endif %}',[])).toThrow('PROMPT_MISSING_ENDLET');
  });
  it('roundtrips dynamic literal, scoped template and expression iteration syntax',()=>{
    const source='{% let total = sum([1,2,3]) %}{{ local.total + 2*3 }}{% each item,i in mapIndexed(context.items,"npc","n",object("value",local.npc.hp + local.n)) %}{{ local.item.value }}{% else %}none{% endeach %}{% endlet %}{{ literal({"text":"}}", "nested":{"a":1}}) }}';
    const nodes=parsePromptTemplate(source,[]);expect(parsePromptTemplate(printPromptTemplate(nodes),[])).toEqual(nodes);
    expect(renderPromptTemplate(nodes,{}, {},{runtime:{items:[{hp:4}]}})).toBe('124{"text":"}}","nested":{"a":1}}');
  });
  it('builds dynamic structures with TS without running author callbacks per request',()=>{
    let authored=0;
    const program=definePrompt({controls:{extra:option.number({label:'Extra',default:1})},compose:({options})=>{
      authored++;
      return [system('npc-list',letValue('total',expr.sum(expr.map(expr.context<number[]>('scores'),'score',score=>expr.add(score,options.extra))),total=>text`Total ${total};${each(expr.context<string[]>('names'),'name',(name,index)=>text`${index}:${name};`)}`)),history()];
    }});
    const contextValue={scores:[1,2],names:['Mira','{{ data }}']};
    const compiled=compilePromptProgram(program,{runtime:contextValue,slots:{},history:[{id:'current',role:'user',text:'{% data %}',current:true}]});
    expect(compiled.messages[0].content[0].text).toBe('Total 5;0:Mira;1:{{ data }};');expect(authored).toBe(1);expect(compiled.messages[1].content[0].text).toBe('{% data %}');
    expect(validatePromptProgram(program)).toEqual(program);
  });
  it('shares final output bounds across message blocks',()=>{
    const program=definePrompt({controls:{},compose:()=>[system('a','x'.repeat(15)),system('b','y'.repeat(15)),history()]});
    expect(()=>compilePromptProgram(program,{slots:{},history:[{id:'c',role:'user',text:'',current:true}],limits:{maxOutputChars:20}})).toThrow('PROMPT_OUTPUT_LIMIT');
  });
});
