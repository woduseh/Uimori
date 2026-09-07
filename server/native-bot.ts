import { createHash, randomUUID } from 'node:crypto';
import { HttpError, type Store } from './store.js';
import { fields, record, text, number } from './product-store.js';
import { applyNativeBotCommand, initialNativeBotState, validateNativeBotPackage, validateNativeBotState, type NativeBotPackage, type NativeBotSnapshot } from '../core/native-bot.js';
import { saveNativeStateConfigInTransaction } from './native-state.js';

export const nativeBotTables=['native_chat_settings','native_actions','native_state_config_owners'];
type Row=Record<string,any>;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class NativeBotStore {
  constructor(readonly store:Store) {}
  init() { this.store.db.exec(`CREATE TABLE IF NOT EXISTS native_chat_settings(chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id)); CREATE TABLE IF NOT EXISTS native_actions(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,UNIQUE(chat_id,request_key)); CREATE TABLE IF NOT EXISTS native_state_config_owners(chat_id TEXT NOT NULL,config_revision INTEGER NOT NULL,branch_id TEXT NOT NULL REFERENCES branches(id),PRIMARY KEY(chat_id,config_revision),FOREIGN KEY(chat_id,config_revision) REFERENCES story_configs(chat_id,revision));`); }
  list():NativeBotPackage[] { return this.store.product.all('native-bot'); }
  get(id:string,revision?:number):NativeBotPackage { return this.store.product.get('native-bot',id,revision); }
  importPackage(value:unknown,id?:string,expectedRevision?:number):NativeBotPackage {
    let p:NativeBotPackage; try { p=validateNativeBotPackage(value); } catch(error) { throw new HttpError(400,(error as Error).message); }
    // Database-owned identities make duplicate source package IDs harmless.
    return this.store.product.save('native-bot',p,id,expectedRevision) as NativeBotPackage;
  }
  detail(chatId:string,branchId?:string):NativeBotSnapshot|null { const branch=this.store.product.branch(chatId,branchId); const row=this.store.db.prepare('SELECT body FROM native_chat_settings WHERE chat_id=? AND branch_id=?').get(chatId,branch.id) as Row|undefined; return row?JSON.parse(row.body):null; }
  snapshot(chatId:string,branchId?:string):NativeBotSnapshot|null {
    const saved=this.detail(chatId,branchId); if(!saved) return null;
    const branch=this.store.product.branch(chatId,branchId); const source=branch.headRevision?this.store.source(branch.headRevision):null;
    // A request proposal belongs to its original source; never silently replay it after an edit or advance.
    if(saved.sourceRevision!==branch.headRevision || saved.sourceHash!==(source?.hash??null)) saved.pending=null;
    if(saved.stateConfigRevision!==undefined) {
      const config=this.store.story.config(chatId,saved.stateConfigRevision);
      const axes=['affection','trust','independence'] as const;
      const nativeModule=config.module&&Object.keys(config.module.fields).length===3&&axes.every(axis=>config.module!.fields[axis]?.type==='number');
      // Stored UI snapshots may contain a previous derived overlay. Reconstruct the explicit baseline
      // before looking up the current source so an edit cannot retain an old hash's model result.
      if(nativeModule && config.module) {
        const baseline=Object.fromEntries(Object.entries(config.module.fields).map(([key,field])=>[key,field.initial]));
        try { saved.state=validateNativeBotState(saved.package,{...saved.state,...baseline}); } catch { /* Foreign modules are not native state. */ }
      }
      const state=this.store.story.stateAt(chatId,branch.headRevision,config);
      if(nativeModule && state?.canonical && state.moduleRevision===config.module?.revision && state.sourceRevision===branch.headRevision && state.sourceHash===(source?.hash??null) && Object.keys(state.values).length===3 && axes.every(axis=>Object.hasOwn(state.values,axis))) {
        try { saved.state=validateNativeBotState(saved.package,{...saved.state,...state.values}); } catch { /* Foreign or invalid state must never overwrite explicit controls. */ }
      }
    }
    return {...saved,sourceRevision:branch.headRevision,sourceHash:source?.hash??null};
  }
  /** Candidate/branch creation owns the surrounding transaction. Preserve state rule identity. */
  cloneToBranchInTransaction(snapshot:NativeBotSnapshot,newBranchId:string):NativeBotSnapshot {
    const original=this.store.db.prepare('SELECT chat_id FROM branches WHERE id=?').get(snapshot.branchId) as {chat_id:string}|undefined;
    if(!original)throw new HttpError(404,'Native source branch not found');
    const branch=this.store.product.branch(original.chat_id,newBranchId);
    if(this.detail(original.chat_id,newBranchId))throw new HttpError(409,'Native target branch already configured');
    if(snapshot.sourceRevision!==null&&!this.store.history(branch.headRevision).some(item=>item.revision===snapshot.sourceRevision))throw new HttpError(409,'Native source is outside target ancestry');
    const pkg=validateNativeBotPackage(snapshot.package);const state=validateNativeBotState(pkg,snapshot.state);
    const source=branch.headRevision?this.store.source(branch.headRevision):null;
    let stateConfigRevision:number;
    if(snapshot.stateConfigRevision===undefined)stateConfigRevision=saveNativeStateConfigInTransaction(this.store,original.chat_id,newBranchId,pkg,state);
    else {
      const previous=this.store.story.config(original.chat_id,snapshot.stateConfigRevision);
      stateConfigRevision=Number((this.store.db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM story_configs WHERE chat_id=?').get(original.chat_id) as {revision:number}).revision)+1;
      const config={...structuredClone(previous),revision:stateConfigRevision};
      this.store.db.prepare('INSERT INTO story_configs VALUES(?,?,?)').run(original.chat_id,stateConfigRevision,JSON.stringify(config));
      this.store.db.prepare('INSERT INTO native_state_config_owners VALUES(?,?,?)').run(original.chat_id,stateConfigRevision,newBranchId);
    }
    const result:NativeBotSnapshot={...structuredClone(snapshot),package:pkg,state,revision:1,branchId:newBranchId,sourceRevision:source?.id??null,sourceHash:source?.hash??null,pending:null,stateConfigRevision};
    this.store.db.prepare('INSERT INTO native_chat_settings VALUES(?,?,?,?)').run(original.chat_id,newBranchId,1,JSON.stringify(result));
    this.store.event(original.chat_id,'native.branch.cloned',newBranchId);return result;
  }
  private mutate(chatId:string,input:unknown,attach:boolean):NativeBotSnapshot {
    const b=record(input); fields(b,['branchId','expectedRevision','expectedSourceRevision','expectedSourceHash','idempotencyKey',...(attach?['packageId','packageRevision']:['command'])]);
    const branchId=text(b.branchId,'branch',100); const key=text(b.idempotencyKey,'idempotency key',120); const expected=number(b.expectedRevision,'native revision',0);
    const sourceId=b.expectedSourceRevision===null?null:text(b.expectedSourceRevision,'source',100); const sourceHash=b.expectedSourceHash===null?null:text(b.expectedSourceHash,'source hash',64);
    const inputHash=digest({attach,body:b});
    return this.store.transaction(()=>{
      const branch=this.store.product.branch(chatId,branchId);
      const oldAction=this.store.db.prepare('SELECT * FROM native_actions WHERE chat_id=? AND request_key=?').get(chatId,key) as Row|undefined;
      if(oldAction) { if(oldAction.input_hash!==inputHash) throw new HttpError(409,'Idempotency key reused'); return JSON.parse(oldAction.result); }
      const current=this.snapshot(chatId,branchId); if((current?.revision??0)!==expected) throw new HttpError(409,'Native settings revision conflict');
      const source=branch.headRevision?this.store.source(branch.headRevision):null;
      if(branch.headRevision!==sourceId || (source?.hash??null)!==sourceHash) throw new HttpError(409,'Native source revision or hash conflict');
      const commandId=randomUUID(); let result:NativeBotSnapshot;
      if(attach) { const p=this.get(text(b.packageId,'package',100),number(b.packageRevision,'package revision')); result={package:p,revision:expected+1,state:initialNativeBotState(),pending:null,branchId,sourceRevision:sourceId,sourceHash}; }
      else {
        if(!current) throw new HttpError(409,'Attach a native package first');
        let update; try { update=applyNativeBotCommand(current.package,current.state,current.sourceRevision===sourceId&&current.sourceHash===sourceHash?current.pending:null,b.command,commandId); } catch(error) { throw new HttpError(400,(error as Error).message); }
        result={...current,...update,revision:expected+1,sourceRevision:sourceId,sourceHash};
      }
      if(attach || ['set-stat','volume'].includes(record(b.command).kind)) result.stateConfigRevision=saveNativeStateConfigInTransaction(this.store,chatId,branchId,result.package,result.state,current?.stateConfigRevision);
      this.store.db.prepare('INSERT INTO native_chat_settings VALUES(?,?,?,?) ON CONFLICT(chat_id,branch_id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(chatId,branchId,result.revision,JSON.stringify(result));
      this.store.db.prepare('INSERT INTO native_actions VALUES(?,?,?,?,?,?)').run(commandId,chatId,branchId,key,inputHash,JSON.stringify(result));
      this.store.event(chatId,'native.command',commandId); return result;
    });
  }
  attach(chatId:string,value:unknown):NativeBotSnapshot { return this.mutate(chatId,value,true); }
  command(chatId:string,value:unknown):NativeBotSnapshot { return this.mutate(chatId,value,false); }
}
