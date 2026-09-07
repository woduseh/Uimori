import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PROVIDER_PROTOCOLS, validateProviderEndpoint, type Connection, type ContentRef, type ModelPreset } from '../core/product.js';
import { validateSolOptions } from '../core/sol-config.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { REGISTRATION_LIMITS, type RegistrationConnectionDraft, type RegistrationPlan, type RegistrationRun, type RegistrationView } from '../core/provider-registration.js';
import type { ProductStore } from './product-store.js';
import { fields, record, number, text } from './product-store.js';
import { HttpError } from './store.js';

const kind = 'registration-run';
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (value:unknown):ContentRef => {const b=record(value);fields(b,['id','revision']);return {id:text(b.id,'reference',100),revision:number(b.revision,'revision')};};
const connectionFields = ['title','protocol','endpoint','credentialEnv','requestTier','enabled'];
const modelFields = ['title','modelId','maxOutputTokens','temperature','thinkingLevel','timeoutMs','structuredOutput','reasoningEffort','thinkingMode','thinkingBudgetTokens','sol','enabled'];
const pick = (value:Record<string,unknown>,keys:string[]) => Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));

/** No settings write. New-connection previews validate a synthetic reference through the same model validator. */
export function normalizeRegistrationPlan(product:ProductStore,value:unknown,options:{historical?:boolean}={}):RegistrationPlan {
  const b=record(value);fields(b,['connection','model']);const selection=record(b.connection);
  let connection:Connection;let normalized:RegistrationPlan['connection'];
  if(selection.kind==='existing') {
    fields(selection,['kind','id','revision']);const requested=ref({id:selection.id,revision:selection.revision});
    connection=product.get<Connection>('connection',requested.id,options.historical ? requested.revision : undefined);
    if(connection.revision!==requested.revision)throw new HttpError(409,'Connection changed; review a new proposal');
    normalized={kind:'existing',...requested};
  } else if(selection.kind==='new') {
    fields(selection,['kind','draft']);const draft=record(selection.draft);fields(draft,connectionFields);
    if(draft.enabled!==false)throw new HttpError(400,'New proposed connections must start disabled');
    const prepared=product.prepareConnection(draft).value;
    connection={...prepared,id:'pending-connection',revision:1};
    normalized={kind:'new',draft:pick(prepared,connectionFields) as RegistrationConnectionDraft};
  } else throw new HttpError(400,'Unsupported registration connection');
  const model=record(b.model);fields(model,modelFields);
  const prepared=product.prepareModel({...model,connectionId:connection.id,connectionRevision:connection.revision},undefined,connection).value;
  return {connection:normalized,model:pick(prepared,modelFields) as RegistrationPlan['model']};
}

/** Appended immutable versions also form the budget journal. No provider continuation is stored. */
export class RegistrationStore {
  constructor(readonly product:ProductStore) {}
  get db(){return this.product.db;}
  get(id:string):RegistrationRun{return this.product.get<RegistrationRun>(kind,id);}
  byKey(key:string):RegistrationView {if(!/^[A-Za-z0-9-]{8,120}$/u.test(key))throw new HttpError(400,'Invalid request key');return this.view('registration-'+hash(key).slice(0,48));}
  private append(body:RegistrationRun,expected?:number):RegistrationRun {
    const row=this.db.prepare('SELECT revision FROM versions WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1').get(kind,body.id) as {revision:number}|undefined;
    if((row?.revision??0)!==(expected??0))throw new HttpError(409,'Registration revision conflict');
    const next={...body,revision:(row?.revision??0)+1};
    this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(kind,next.id,next.revision,JSON.stringify(next));return next;
  }
  create(value:unknown):{run:RegistrationRun;created:boolean;target:ModelPreset & {connection:Connection}} {
    const b=record(value);fields(b,['key','request','target']);const key=text(b.key,'request key',120);
    if(!/^[A-Za-z0-9-]{8,120}$/u.test(key))throw new HttpError(400,'Invalid request key');
    const request=text(b.request,'registration request',REGISTRATION_LIMITS.requestCharacters);
    if(/\bsk-[A-Za-z0-9_-]{12,}|\bAIza[\w-]{20,}|\bBearer\s+\S{12,}|-----BEGIN [^-]*PRIVATE KEY/u.test(request))throw new HttpError(400,'Do not include credentials in the registration request');
    const targetRef=ref(b.target);const id='registration-'+hash(key).slice(0,48),intentHash=hash({request,target:targetRef});
    const previous=this.db.prepare('SELECT body FROM versions WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1').get(kind,id) as {body:string}|undefined;
    if(previous) {
      const run=JSON.parse(previous.body) as RegistrationRun;
      if(run.intentHash!==intentHash)throw new HttpError(409,'Request key reused with different input');
      const model=this.product.get<ModelPreset>('model',run.target.id,run.target.revision);
      return {run,created:false,target:{...model,connection:this.product.get<Connection>('connection',run.connection.id,run.connection.revision)}};
    }
    const current=this.product.get<ModelPreset>('model',targetRef.id);
    if(current.enabled===false)throw new HttpError(409,'Registration assistant model is disabled');
    const model=this.product.get<ModelPreset>('model',targetRef.id,targetRef.revision);
    const connection=this.product.authorize(this.product.get<Connection>('connection',model.connectionId,model.connectionRevision));
    const secret=connection.credentialEnv?process.env[connection.credentialEnv]:undefined;
    if(secret&&request.includes(secret))throw new HttpError(400,'Do not include credentials in the registration request');
    const run:RegistrationRun={id,revision:0,intentHash,createdAt:new Date().toISOString(),finishedAt:null,status:'running',request,target:targetRef,connection:{id:connection.id,revision:connection.revision},attempts:[],plan:null,planHash:null,error:null,applied:null};
    return {run:this.append(run),created:true,target:{...model,connection}};
  }
  startAttempt(id:string,wire:WireRecord):string {
    const run=this.get(id);if(run.status!=='running'||run.attempts.length>=REGISTRATION_LIMITS.maxCalls)throw new HttpError(409,'Registration request is no longer admitted');
    const safe=structuredClone(wire);
    // The same redacted diagnostic wire as narrative attempts; opaque state is never retained.
    if(safe.body&&typeof safe.body==='object'&&!Array.isArray(safe.body)&&'opaqueState'in safe.body)safe.body.opaqueState='[provider continuation withheld]';
    const attempt={id:randomUUID(),request:safe,status:'running',usage:null,error:null};
    this.append({...run,attempts:[...run.attempts,attempt]},run.revision);return attempt.id;
  }
  finishAttempt(id:string,attemptId:string,result:ProviderResult) {
    const run=this.get(id);const attempt=run.attempts.find(item=>item.id===attemptId);
    if(!attempt||attempt.status!=='running')throw new HttpError(409,'Attempt already finished');
    // Store only usage and safe error codes, never model text, arbitrary fields or opaque results.
    const usage={inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,costUsd:result.usage.costUsd,raw:null,priceRevision:result.usage.priceRevision};
    const attempts=run.attempts.map(item=>item.id===attemptId?{...item,status:result.status,usage,error:result.error?.code??null}:item);
    this.append({...run,attempts},run.revision);
  }
  finish(id:string,status:'ready'|'failed'|'cancelled',proposal?:unknown,error:string|null=null) {
    const run=this.get(id);if(run.status!=='running')return run;
    const plan=status==='ready'?normalizeRegistrationPlan(this.product,proposal):null;
    return this.append({...run,status,plan,planHash:plan?hash(plan):null,error,finishedAt:new Date().toISOString()},run.revision);
  }
  recover() {
    for(const run of this.product.all(kind) as RegistrationRun[])if(run.status==='running')this.append({...run,status:'interrupted',error:'SERVER_INTERRUPTED_NO_AUTOMATIC_REPLAY',finishedAt:new Date().toISOString()},run.revision);
  }
  view(id:string):RegistrationView {
    const {intentHash:_intent,attempts,...run}=this.get(id);return {...run,modelCalls:attempts.length,usage:attempts.at(-1)?.usage??null};
  }
  apply(id:string,value:unknown):RegistrationRun {
    const b=record(value);fields(b,['expectedRevision','planHash']);const expected=number(b.expectedRevision,'registration revision');const planHash=text(b.planHash,'plan hash',64);
    return this.product.store.transaction(()=>{
      const run=this.get(id);
      // Idempotent replay returns the exact original result, never another registration.
      if(run.status==='applied'&&run.planHash===planHash)return run;
      if(run.revision!==expected||run.status!=='ready'||run.planHash!==planHash||!run.plan)throw new HttpError(409,'Registration proposal changed');
      const plan=normalizeRegistrationPlan(this.product,run.plan);
      if(!isDeepStrictEqual(plan,run.plan))throw new HttpError(409,'Registration validation changed; review a new proposal');
      let connection:Connection;
      if(plan.connection.kind==='existing')connection=this.product.get<Connection>('connection',plan.connection.id,plan.connection.revision);
      else {
        const prepared=this.product.prepareConnection(plan.connection.draft).value;connection={...prepared,id:randomUUID(),revision:1};
        this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run('connection',connection.id,connection.revision,JSON.stringify(connection));
      }
      const prepared=this.product.prepareModel({...plan.model,connectionId:connection.id,connectionRevision:connection.revision}).value;
      const model:ModelPreset={...prepared,id:randomUUID(),revision:1};
      this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run('model',model.id,model.revision,JSON.stringify(model));
      return this.append({...run,status:'applied',applied:{connection:{id:connection.id,revision:connection.revision},model:{id:model.id,revision:model.revision}}},run.revision);
    });
  }
}

const validHash = (value:unknown) => typeof value==='string' && /^[a-f0-9]{64}$/u.test(value);
function date(value:unknown) { if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new HttpError(400,'Invalid registration date'); }
function code(value:unknown) { if(value!==null&&(typeof value!=='string'||! /^[A-Z][A-Z0-9_]{0,199}$/u.test(value)))throw new HttpError(400,'Invalid registration error'); }
const attemptStatuses=['running','completed','tool_calls','refused','partial','error','cancelled'];
function validateWire(value:unknown) {
  const wire=record(value);fields(wire,['connectionId','protocol','role','modelId','method','url','headers','body','bodySha256','stablePrefixSha256','budgetReservation','externalBilling']);
  text(wire.connectionId,'wire connection',100);text(wire.modelId,'wire model',300);
  if(!PROVIDER_PROTOCOLS.includes(wire.protocol)||wire.role!=='main'||wire.method!=='POST'||!validHash(wire.bodySha256)||!validHash(wire.stablePrefixSha256))throw new HttpError(400,'Invalid registration wire');
  const url=new URL(text(wire.url,'wire URL',2200));if(url.username||url.password||url.hash)throw new HttpError(400,'Invalid registration URL');
  const headers=record(wire.headers);
  for(const [key,value] of Object.entries(headers)){text(value,'wire header',2000);if(/[\r\n]/u.test(value as string)||(/^(authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/iu.test(key)&&value!=='[REDACTED]'))throw new HttpError(400,'Unsafe registration header');}
  const inspect=(value:unknown,depth=0):void=>{if(depth>100)throw new HttpError(400,'Invalid registration diagnostic');if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;if(Array.isArray(value)){value.forEach(item=>inspect(item,depth+1));return;}const b=record(value);for(const [key,item]of Object.entries(b)){if(/^(opaqueState|opaque_state|encrypted_content|encrypted_data|signature|thoughtSignature|authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/iu.test(key)&&item!==null&&!(typeof item==='string'&&/^\[(?:REDACTED|provider .+ withheld)\]$/u.test(item)))throw new HttpError(400,'Unsafe registration diagnostic');inspect(item,depth+1);}};
  inspect(wire.body);
  if(wire.externalBilling!==undefined&&wire.externalBilling!=='not-estimated')throw new HttpError(400,'Invalid external billing');
  if(wire.budgetReservation!==undefined){const reservation=record(wire.budgetReservation);fields(reservation,['maxCostUsd','priceRevision','basis','source','reservedAt']);if(typeof reservation.maxCostUsd!=='number'||!Number.isFinite(reservation.maxCostUsd)||reservation.maxCostUsd<=0)throw new HttpError(400,'Invalid reservation');text(reservation.priceRevision,'price revision',200);text(reservation.basis,'reservation basis',200);text(reservation.source,'reservation source',2000);date(reservation.reservedAt);}
}

/** Strict local schema; graph validation separately uses the archived pinned connection. */
export function validateRegistrationArchive(value:unknown) {
  const b=record(value);fields(b,['id','revision','intentHash','createdAt','finishedAt','status','request','target','connection','attempts','plan','planHash','error','applied']);
  if(typeof b.id!=='string'||!/^registration-[a-f0-9]{48}$/u.test(b.id))throw new HttpError(400,'Invalid registration ID');number(b.revision,'revision');ref(b.target);ref(b.connection);
  if(!validHash(b.intentHash)||b.intentHash!==hash({request:b.request,target:b.target}))throw new HttpError(400,'Invalid registration hash');
  text(b.request,'registration request',REGISTRATION_LIMITS.requestCharacters);date(b.createdAt);if(b.finishedAt!==null)date(b.finishedAt);
  if(!['running','ready','failed','cancelled','interrupted','applied'].includes(b.status)||(b.status==='running')!==(b.finishedAt===null))throw new HttpError(400,'Invalid registration status');
  code(b.error);
  if(!Array.isArray(b.attempts)||b.attempts.length>REGISTRATION_LIMITS.maxCalls)throw new HttpError(400,'Invalid registration attempts');
  for(const attempt of b.attempts){const a=record(attempt);fields(a,['id','request','status','usage','error']);text(a.id,'attempt ID',100);validateWire(a.request);if(!attemptStatuses.includes(a.status))throw new HttpError(400,'Invalid attempt status');code(a.error);
    if(a.usage!==null){const usage=record(a.usage);fields(usage,['inputTokens','outputTokens','costUsd','raw','priceRevision']);for(const key of ['inputTokens','outputTokens'])if(usage[key]!==null)number(usage[key],'token usage',0,Number.MAX_SAFE_INTEGER);if(usage.costUsd!==null&&(typeof usage.costUsd!=='number'||!Number.isFinite(usage.costUsd)||usage.costUsd<0))throw new HttpError(400,'Invalid registration cost');if(usage.raw!==null)throw new HttpError(400,'Registration raw usage is not retained');if(usage.priceRevision!==null)text(usage.priceRevision,'price revision',200);}
    if((a.status==='running')!==(a.usage===null)||a.status==='running'&&a.error!==null)throw new HttpError(400,'Invalid attempt state');
  }
  if(b.plan===null){if(b.planHash!==null||b.applied!==null||['ready','applied'].includes(b.status))throw new HttpError(400,'Invalid registration plan');}
  else {
    if(!['ready','applied'].includes(b.status))throw new HttpError(400,'Unexpected registration plan');
    const plan=record(b.plan);fields(plan,['connection','model']);const c=record(plan.connection);
    if(c.kind==='existing'){fields(c,['kind','id','revision']);ref({id:c.id,revision:c.revision});}
    else if(c.kind==='new'){fields(c,['kind','draft']);const draft=record(c.draft);fields(draft,connectionFields);if(draft.enabled!==false||!PROVIDER_PROTOCOLS.includes(draft.protocol))throw new HttpError(400,'Invalid proposed authority');text(draft.title,'connection title',200);validateProviderEndpoint(draft.protocol,text(draft.endpoint,'endpoint',2000));if(draft.credentialEnv!==undefined&&(typeof draft.credentialEnv!=='string'||!/^NARRATIVE_PROVIDER_[A-Z0-9_]+$/u.test(draft.credentialEnv)))throw new HttpError(400,'Invalid credential reference');if(draft.requestTier!==undefined&&(draft.protocol!=='vertex-gemini-v1'||!['standard','flex'].includes(draft.requestTier)))throw new HttpError(400,'Invalid request tier');}
    else throw new HttpError(400,'Invalid proposed connection');
    const model=record(plan.model);fields(model,modelFields);text(model.title,'model title',200);text(model.modelId,'model ID',300);number(model.maxOutputTokens,'output limit',1,200000);
    if(model.temperature!==null&&(typeof model.temperature!=='number'||!Number.isFinite(model.temperature)||model.temperature<0||model.temperature>2))throw new HttpError(400,'Invalid temperature');
    if(model.timeoutMs!==undefined)number(model.timeoutMs,'timeout',1,1800000);
    for(const key of ['enabled','structuredOutput'])if(model[key]!==undefined&&typeof model[key]!=='boolean')throw new HttpError(400,'Invalid model boolean');
    for(const [key,choices]of Object.entries({thinkingLevel:['LOW','MEDIUM','HIGH'],reasoningEffort:['none','minimal','low','medium','high','xhigh','max'],thinkingMode:['disabled','enabled','adaptive']}))if(model[key]!==undefined&&!choices.includes(model[key]))throw new HttpError(400,'Invalid model option');
    if(model.thinkingBudgetTokens!==undefined)number(model.thinkingBudgetTokens,'thinking budget',1024,model.maxOutputTokens-1);if(model.sol!==undefined)validateSolOptions(model.sol);
    if(!validHash(b.planHash)||b.planHash!==hash(b.plan))throw new HttpError(400,'Registration plan hash mismatch');
  }
  if(b.applied!==null){const applied=record(b.applied);fields(applied,['connection','model']);ref(applied.connection);ref(applied.model);if(b.status!=='applied')throw new HttpError(400,'Invalid applied registration');}
  else if(b.status==='applied')throw new HttpError(400,'Missing applied registration');
}

/** Validate historical plans against their pinned revision, never against the current connection. */
export function validateRegistrationGraph(product:ProductStore) {
  const rows=product.db.prepare("SELECT body FROM versions WHERE kind='registration-run' ORDER BY id,revision").all() as {body:string}[];
  const previous=new Map<string,RegistrationRun>();
  const applications=new Map<string,string>();
  for(const row of rows){const run=JSON.parse(row.body) as RegistrationRun;validateRegistrationArchive(run);
    const target=product.get<ModelPreset>('model',run.target.id,run.target.revision),connection=product.get<Connection>('connection',run.connection.id,run.connection.revision);
    if(target.connectionId!==connection.id||target.connectionRevision!==connection.revision)throw new HttpError(400,'Registration target mismatch');
    for(const attempt of run.attempts){const wire=attempt.request;const suffix=connection.protocol==='vertex-gemini-v1'?`/${target.modelId}:streamGenerateContent?alt=sse`:connection.protocol==='anthropic-messages-v1'?'/messages':['openai-responses-v1','sol-responses-v1'].includes(connection.protocol)?'/responses':'/chat/completions';const url=connection.protocol==='fixture-sse-v1'?new URL(connection.endpoint).href:connection.endpoint.replace(/\/$/u,'')+suffix;
      if(wire.connectionId!==connection.id||wire.protocol!==connection.protocol||wire.modelId!==target.modelId||wire.url!==url)throw new HttpError(400,'Registration attempt target mismatch');
    }
    if(run.plan){const normalized=normalizeRegistrationPlan(product,run.plan,{historical:true});if(!isDeepStrictEqual(normalized,run.plan))throw new HttpError(400,'Registration plan normalization mismatch');}
    if(run.applied){
      const c=product.get<Connection>('connection',run.applied.connection.id,run.applied.connection.revision),m=product.get<ModelPreset>('model',run.applied.model.id,run.applied.model.revision);
      if(!run.plan||m.connectionId!==c.id||m.connectionRevision!==c.revision||m.revision!==1)throw new HttpError(400,'Registration applied reference mismatch');
      if(run.plan.connection.kind==='existing'){if(c.id!==run.plan.connection.id||c.revision!==run.plan.connection.revision)throw new HttpError(400,'Registration applied connection mismatch');}
      else {const proposed=product.prepareConnection(run.plan.connection.draft).value;const {credentialEnv:_secret,...safe}=proposed;const {id:_id,revision:_revision,credentialEnv:_stored,...actual}=c;if(c.revision!==1||!isDeepStrictEqual({...safe,enabled:false},{...actual,enabled:false}))throw new HttpError(400,'Registration applied connection mismatch');}
      const expected=product.prepareModel({...run.plan.model,connectionId:c.id,connectionRevision:c.revision},undefined,c).value;const {id:_modelId,revision:_modelRevision,...actualModel}=m;if(!isDeepStrictEqual(expected,actualModel))throw new HttpError(400,'Registration applied model mismatch');
      const owner=applications.get(m.id);if(owner&&owner!==run.id)throw new HttpError(400,'Duplicate registration application');applications.set(m.id,run.id);
    }
    const old=previous.get(run.id);
    if(!old){if(run.revision!==1||run.status!=='running'||run.attempts.length!==0)throw new HttpError(400,'Missing initial registration revision');}
    else {
      if(run.revision!==old.revision+1||!isDeepStrictEqual([run.intentHash,run.request,run.target,run.connection,run.createdAt],[old.intentHash,old.request,old.target,old.connection,old.createdAt])||run.attempts.length<old.attempts.length)throw new HttpError(400,'Registration history mismatch');
      for(let i=0;i<old.attempts.length;i++){const a=old.attempts[i],b=run.attempts[i];if(a.id!==b.id||!isDeepStrictEqual(a.request,b.request)||a.status!=='running'&&!isDeepStrictEqual(a,b))throw new HttpError(400,'Registration attempt history mismatch');}
      if(old.status!=='running'&&!(old.status==='ready'&&run.status==='applied')&&(!isDeepStrictEqual([old.status,old.plan,old.planHash,old.applied,old.error,old.finishedAt],[run.status,run.plan,run.planHash,run.applied,run.error,run.finishedAt])))throw new HttpError(400,'Registration terminal history mismatch');
      if(old.status==='ready'&&run.status==='applied'&&!isDeepStrictEqual([old.plan,old.planHash,old.finishedAt],[run.plan,run.planHash,run.finishedAt]))throw new HttpError(400,'Registration review changed');
    }
    previous.set(run.id,run);
  }
}
