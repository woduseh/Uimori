import { expect, test } from 'vitest';
import { crc32, deflateRawSync } from 'node:zlib';
import { convertRisuJson } from '../core/risu-import.js';
import { inspectRisuImport, RISU_IMPORT_LIMITS } from '../server/risu-import.js';
import { Store } from '../server/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const card={spec:'chara_card_v3',spec_version:'3.0',data:{name:'Synthetic keeper',description:'Keeps a brass compass.',personality:'Quiet',scenario:'At the harbor',first_mes:'Welcome.',character_book:{entries:[{name:'Compass',content:'The compass is brass.',keys:['keeper'],constant:false,enabled:true},{name:'World',content:'Synthetic harbor.',constant:true,enabled:true}]},extensions:{risuai:{customScripts:[{in:'harbor',out:'port',type:'editdisplay',flag:'i',ableFlag:true}],triggerscript:[{type:'manual',effect:'DO_NOT_EXECUTE'}]}}}};
function zip(files:{name:string;data:Buffer;deflate?:boolean;claimedSize?:number}[]){const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;for(const file of files){const name=Buffer.from(file.name),bytes=file.deflate?deflateRawSync(file.data):file.data,method=file.deflate?8:0,size=file.claimedSize??file.data.length;const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(method,8);local.writeUInt32LE(crc32(file.data),14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(size,22);local.writeUInt16LE(name.length,26);locals.push(local,name,bytes);const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(method,10);record.writeUInt32LE(crc32(file.data),16);record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(size,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);central.push(record,name);offset+=local.length+name.length+bytes.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);}

test('card conversion retains lore, reports unsupported triggers and greetings and converts display-only regex',()=>{
  const result=convertRisuJson(card);const draft=result.draft as any;expect(draft.kind).toBe('bot');expect(draft.package.lore.map((entry:any)=>entry.loading)).toEqual(['discoverable','pinned']);expect(draft.package.transforms).toEqual([{id:'regex-0',target:'source',pattern:'harbor',flags:'i',replacement:'port'}]);
  expect(result.issues.some(issue=>issue.path.includes('triggerscript')&&issue.severity==='blocking')).toBe(true);expect(result.issues.some(issue=>issue.path.includes('first_mes'))).toBe(true);expect((result.extracted as any).data.first_mes).toBe('Welcome.');
});
test('unknown instructions and CBS remain in extracted report without execution or silently claiming support',()=>{
  const input={...card,data:{...card.data,system_prompt:'{{getvar::secret}}',extensions:{custom:{instruction:'Do something unknown'},risuai:{lua:'throw Error("EXECUTED")'}}}};
  const result=convertRisuJson(input);expect(result.issues.filter(issue=>issue.severity==='blocking').length).toBeGreaterThan(0);expect((result.extracted as any).data.system_prompt).toBe('{{getvar::secret}}');expect(result.issues.some(issue=>issue.path==='$.extensions.custom')).toBe(true);
});
test('preset plain blocks map literal roles while custom/template/provider behavior is reported',()=>{
  const result=convertRisuJson({name:'Synthetic preset',promptTemplate:[{type:'plain',role:'bot',type2:'normal',text:'Literal assistant text'},{type:'plain',role:'system',text:'{{if::flag}}conditional{{/if}}'},{type:'chatML',text:'special semantics'}],temperature:0.5,openAIKey:'SYNTHETIC_SECRET'});
  expect(result.kind).toBe('prompt');expect((result.draft as any).program.blocks[0].role).toBe('assistant');expect(result.issues.some(issue=>issue.path==='$.temperature')).toBe(true);expect(result.issues.some(issue=>issue.severity==='blocking')).toBe(true);expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
});
test.each([false,true])('charx reads stored/deflated card.json and reports opaque module plus asset omissions (%s)',async deflate=>{
  const bytes=zip([{name:'card.json',data:Buffer.from(JSON.stringify(card)),deflate},{name:'module.risum',data:Buffer.from([111,0,0])},{name:'assets/portrait.png',data:Buffer.from([1,2,3])}]);const result=await inspectRisuImport({fileName:'synthetic.charx',bytes});expect(result.draft).toBeDefined();expect(result.original?.entries).toHaveLength(3);expect(result.original?.sha256).toHaveLength(64);expect(result.issues.some(issue=>issue.path==='archive/module.risum'&&issue.severity==='blocking')).toBe(true);
});
test('ZIP rejects traversal, duplicate card, resource overflow and CRC corruption',async()=>{
  const data=Buffer.from(JSON.stringify(card));const fixtures=[zip([{name:'../card.json',data}]),zip([{name:'card.json',data},{name:'card.json',data}]),zip([{name:'card.json',data,claimedSize:RISU_IMPORT_LIMITS.entryBytes+1}])];const corrupt=zip([{name:'card.json',data}]);corrupt[40]^=1;fixtures.push(corrupt);
  for(const bytes of fixtures){const result=await inspectRisuImport({fileName:'bad.charx',bytes});expect(result.draft).toBeUndefined();expect(result.issues[0].severity).toBe('blocking');}
});
test.each(['risup','risupreset','risum'])('unsupported binary %s produces actionable blocking result',async extension=>{const result=await inspectRisuImport({fileName:`synthetic.${extension}`,bytes:new Uint8Array([1,2,3])});expect(result.draft).toBeUndefined();expect(result.issues[0].message).toContain('JSON');expect(result.original?.byteLength).toBe(3);});
test('native package and prompt AST preserve controls and validate schema; malformed inputs fail boundedly',async()=>{
  const p={version:1,id:'synthetic',revision:1,title:'Native',description:'',lore:[],instructions:[],controls:[{id:'tone',label:'Tone',type:'boolean',default:false}],transforms:[]};expect((convertRisuJson(p).draft as any).package).toEqual(p);
  const program={version:1,controls:[],blocks:[{id:'current',title:'Request',kind:'current'}]};expect((convertRisuJson(program).draft as any).program).toEqual(program);
  const result=await inspectRisuImport({fileName:'bad.json',bytes:Buffer.from('{broken')});expect(result.issues[0].severity).toBe('blocking');
});
test('long native package body and wrapper remain identical through actual store save',async()=>{
  const p={version:1,id:'synthetic-long',revision:1,title:'Long',description:'d'.repeat(3000),body:'x'.repeat(150000),lore:[],instructions:[],controls:[],transforms:[]};
  const result=convertRisuJson(p);expect((result.draft as any).package.body).toHaveLength(150000);expect(result.draft?.text).toBe(p.body);expect(result.draft?.description).toBe(p.description);
  const directory=await mkdtemp(join(tmpdir(),'Uimori import synthetic '));const store=new Store(join(directory,'test.sqlite'));
  try{const saved=store.product.content(result.draft) as any;expect(saved.text).toBe(p.body);expect(saved.package.body).toBe(p.body);expect(saved.description).toBe(p.description);expect(saved.package.description).toBe(p.description);}
  finally{store.close();const target=resolve(directory),inside=relative(resolve(tmpdir()),target);if(isAbsolute(inside)||inside.startsWith('..')||!basename(target).startsWith('Uimori import synthetic '))throw new Error('Unsafe synthetic cleanup path');await rm(target,{recursive:true,force:true});}
});
