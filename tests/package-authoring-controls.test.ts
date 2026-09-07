import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { compilePromptProgram, resolvePromptValues, validatePromptProgram, visiblePromptControls, type PromptControl, type PromptProgram } from '../core/prompt-program.js';
import { applyPackageControlDrafts, packageControlDrafts } from '../web/PackageControlsEditor.js';
import { applyPackageInstructionDrafts, packageInstructionDrafts } from '../web/PackageInstructionsEditor.js';
import { PackageControlValues } from '../web/PackageControlValues.js';
import { connectPackageHiddenStory } from '../web/PackageFeaturesEditor.js';
import { retainResolvedPackageValues } from '../web/PackageAttachments.js';
import { hiddenControlDefinitions } from '../core/hidden-story.js';
import type { HiddenStoryNativePackage } from '../core/hidden-story-package.js';

function fixture():ContentPackage{return{version:1,id:'authoring',revision:1,title:'공통 자료',description:'',lore:[],instructions:[{id:'guide',target:'main',text:'원래 본문'}],controls:[{id:'enabled',label:'사용',type:'boolean',default:true}],transforms:[]};}
const controls:PromptControl[]=[
  {id:'detail',label:'상세 설명',type:'text',default:'기본 설명',group:'마법',visibleWhen:{control:'enabled'}},
  {id:'enabled',label:'상세 옵션 보기',type:'boolean',default:false},
  {id:'count',label:'횟수',type:'number',default:2,min:0,max:8,group:'마법'},
  {id:'style',label:'선택',type:'select',default:1,options:[{label:'숫자 1',value:1},{label:'문자 1',value:'1'}],group:'이미지'},
];

describe('package authoring controls and UI visibility',()=>{
  it('accepts forward references and group metadata through the existing package validator',()=>{
    const value={...fixture(),controls};expect(validateContentPackage(value).controls).toEqual(controls);
    expect(visiblePromptControls(controls).map(control=>control.id)).toEqual(['enabled','count','style']);
    expect(visiblePromptControls(controls,{enabled:true}).map(control=>control.id)).toEqual(['detail','enabled','count','style']);
  });
  it('rejects unknown references and unsupported or oversized metadata before save',()=>{
    expect(()=>validateContentPackage({...fixture(),controls:[{...controls[0],visibleWhen:{control:'missing'}}]})).toThrow('PROMPT_UNKNOWN_CONTROL');
    expect(()=>validatePromptProgram({version:1,controls:[{...controls[1],group:'x'.repeat(201)}],blocks:[]})).toThrow('PROMPT_INVALID_STRING');
    expect(()=>validatePromptProgram({version:1,controls:[{...controls[1],visibleWhen:{script:'run'}}],blocks:[]})).toThrow('PROMPT_INVALID_FIELDS');
  });
  it('hides UI controls without changing values or prompt execution',()=>{
    const program:PromptProgram={version:1,controls,blocks:[{id:'main',title:'본문',kind:'message',role:'system',template:[{kind:'value',expression:{control:'detail'}}]},{id:'input',title:'입력',kind:'current'}]};
    const values={enabled:false,detail:'숨겨도 유지한 선택'};const before=structuredClone(values);
    expect(visiblePromptControls(program.controls,values).some(control=>control.id==='detail')).toBe(false);
    expect(values).toEqual(before);expect(resolvePromptValues(program,values).detail).toBe(before.detail);
    expect(compilePromptProgram(program,{values,history:[{id:'current',role:'user',text:'계속',current:true}],slots:{}}).messages[0].content[0].text).toBe(before.detail);
  });
  it('uses prompt truth rules including null and evaluates conditions within a shared budget',()=>{
    for(const condition of [null,false,0,'','0','false','null'])expect(visiblePromptControls([{...controls[1],visibleWhen:condition}])).toEqual([]);
    expect(visiblePromptControls([{...controls[1],visibleWhen:{op:'equal',args:[1,1]}}])).toHaveLength(1);
    expect(()=>visiblePromptControls([{...controls[1],visibleWhen:{op:'divide',args:[1,0]}}])).toThrow();
  });
  it('keeps every scalar option type and validates ranges and dangling instruction references',()=>{
    const value={...fixture(),controls};const drafts=packageControlDrafts(value.controls);
    expect(applyPackageControlDrafts(value,drafts)).toEqual(controls);
    drafts[2].min='3';expect(()=>applyPackageControlDrafts(value,drafts)).toThrow('PROMPT_INVALID_CONTROL_VALUE');
    drafts[2].min='';drafts[2].defaultValue.text='';expect(()=>applyPackageControlDrafts(value,drafts)).toThrow('숫자');
    const referenced={...fixture(),instructions:[{...fixture().instructions[0],when:{control:'enabled'}}]};
    expect(()=>applyPackageControlDrafts(referenced,[])).toThrow('PROMPT_UNKNOWN_CONTROL');
  });
  it('retains malformed display condition drafts and original data on failed validation',()=>{
    const value=fixture(),drafts=packageControlDrafts(value.controls);drafts[0].condition='{"control":';
    expect(()=>applyPackageControlDrafts(value,drafts)).toThrow();expect(drafts[0].condition).toBe('{"control":');expect(value).toEqual(fixture());
  });
  it('renders groups, hides controls, and separates numeric and string select values',()=>{
    const markup=renderToStaticMarkup(createElement(PackageControlValues,{controls,values:{enabled:false,detail:'보존',style:'1'},labelPrefix:'자료',onChange:()=>{throw new Error('Rendering must not change values');}}));
    expect(markup).toContain('<legend>마법</legend>');expect(markup).toContain('<legend>이미지</legend>');expect(markup).not.toContain('aria-label="자료 상세 설명"');
    expect(markup).toContain('value="1" selected=""');expect(markup).toContain('문자 1');
    const nullMarkup=renderToStaticMarkup(createElement(PackageControlValues,{controls:[controls[3]],values:{style:null},onChange:()=>{}}));
    expect(nullMarkup).toContain('value="unset" selected=""');
  });
});

describe('package instruction authoring',()=>{
  it('preserves templates while ordinary text changes and removes them only in explicit text mode',()=>{
    const value=fixture();value.instructions[0].template=[{kind:'value',expression:{control:'enabled'}}];
    const drafts=packageInstructionDrafts(value.instructions);drafts[0].instruction.text='새 보관 본문';
    const preserved=applyPackageInstructionDrafts(value,drafts)[0];expect(preserved.text).toBe('새 보관 본문');expect(preserved.template).toEqual(value.instructions[0].template);
    drafts[0].mode='text';const plain=applyPackageInstructionDrafts(value,drafts)[0];expect(plain.template).toBeUndefined();expect(plain.text).toBe('새 보관 본문');
    expect(value.instructions[0].text).toBe('원래 본문');expect(value.instructions[0].template).toBeDefined();
  });
  it('uses existing syntax parser and validates template, condition and attachment-role references',()=>{
    const value=fixture(),drafts=packageInstructionDrafts(value.instructions);
    Object.assign(drafts[0],{mode:'template',templateFormat:'language',template:'{% if options.enabled %}켜짐{% endif %}',condition:'{"control":"enabled"}'});
    drafts[0].instruction.attachmentRoles=['persona','module'];drafts[0].instruction.position='character';
    const next=applyPackageInstructionDrafts(value,drafts)[0];expect(next.attachmentRoles).toEqual(['persona','module']);expect(next.position).toBe('character');expect(next.template?.[0].kind).toBe('if');
    drafts[0].condition='{"control":"missing"}';expect(()=>applyPackageInstructionDrafts(value,drafts)).toThrow('PROMPT_UNKNOWN_CONTROL');
    drafts[0].condition='';drafts[0].instruction.attachmentRoles=[];expect(()=>applyPackageInstructionDrafts(value,drafts)).toThrow('PACKAGE_INSTRUCTION_ROLE');
  });
  it('keeps exact template JSON when parsing or semantic validation fails',()=>{
    const value=fixture(),drafts=packageInstructionDrafts(value.instructions);drafts[0].mode='template';drafts[0].template='[{"kind":"value","expression":{"control":"missing"}}]';
    const before=structuredClone(drafts);expect(()=>applyPackageInstructionDrafts(value,drafts)).toThrow('PROMPT_UNKNOWN_CONTROL');expect(drafts).toEqual(before);expect(value).toEqual(fixture());
    drafts[0].template='[';expect(()=>applyPackageInstructionDrafts(value,drafts)).toThrow();expect(drafts[0].template).toBe('[');
  });
});

describe('required modules and reusable native features',()=>{
  const native=():HiddenStoryNativePackage=>({id:'hidden-native',revision:1,title:'히든 스토리',packageHash:'a'.repeat(64),format:'uimori-hidden-story-v1',status:'partial',source:{hash:'a'.repeat(64),moduleId:'synthetic',name:'Synthetic'},program:{version:1,controls:hiddenControlDefinitions(),blocks:[]},nonsexualProgram:{version:1,controls:hiddenControlDefinitions(),blocks:[]},controlMap:[],picks:[],requiredSlots:[],loreMapping:[],issues:[]});
  it('adds native controls once and explicitly reuses authored defaults after feature removal',()=>{
    const first=connectPackageHiddenStory(fixture(),native(),'general-fiction');
    expect(first.controls).toHaveLength(36);expect(first.controls.filter(control=>control.group==='히든 스토리')).toHaveLength(35);
    const custom=first.controls.find(control=>control.id==='hidden.open')!;Object.assign(custom,{label:'직접 이름',group:'내 표시',description:'보존',default:1,visibleWhen:{control:'enabled'}});
    const removed={...first,hiddenStory:undefined},before=structuredClone(removed.controls);
    expect(()=>connectPackageHiddenStory(removed,native(),'general-fiction')).toThrow('이미 있는 옵션');
    const restored=connectPackageHiddenStory(removed,native(),'general-fiction',true);
    expect(restored.controls).toEqual(before);expect(restored.hiddenStory?.config.values['hidden.open']).toBe(1);
    expect(restored.hiddenStory?.config.values['hidden.excludeHidden']).toBe(false);
    expect(removed.hiddenStory).toBeUndefined();
  });
  it('rejects incompatible option type, select values and invalid native defaults without overwriting them',()=>{
    const value=connectPackageHiddenStory(fixture(),native(),'general-fiction');
    const changed=structuredClone(value);changed.controls.find(control=>control.id==='hidden.open')!.type='text';
    expect(()=>connectPackageHiddenStory(changed,native(),'general-fiction',true)).toThrow('호환되지');
    const selected=value.controls.find(control=>control.id==='hidden.open')!;selected.options!.push({label:'추가',value:999});
    expect(()=>connectPackageHiddenStory(value,native(),'general-fiction',true)).toThrow('호환되지');
    selected.options!.pop();selected.default=null;
    expect(()=>connectPackageHiddenStory(value,native(),'general-fiction',true)).toThrow('HIDDEN_CONTROL_INVALID');expect(selected.default).toBeNull();
  });
  it('keeps required-module values and explicit null while filtering removed scopes and controls',()=>{
    const root={id:'root',revision:1,role:'bot' as const},required={id:'required',revision:2,role:'module' as const};
    const resolved={attachments:[root,required],packages:[fixture(),{...fixture(),id:'required'}],required:[required]};
    const values={'root@1:bot':{enabled:true,old:'removed'},'required@2:module':{enabled:null},'removed@1:module':{enabled:false}};
    expect(retainResolvedPackageValues(values,resolved)).toEqual({'root@1:bot':{enabled:true},'required@2:module':{enabled:null}});
    expect(values['required@2:module'].enabled).toBeNull();expect(values['root@1:bot'].old).toBe('removed');
  });
});
