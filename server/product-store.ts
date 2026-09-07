import { randomUUID, createHash } from 'node:crypto';
import { isVertexFileReference, validVertexFileReference } from '../core/credential-reference.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Store } from './store.js';
import { HttpError } from './store.js';
import { defaultProfile, validateProviderEndpoint, PROVIDER_PROTOCOLS, VERTEX_GEMINI_MODEL_ID, VERTEX_GEMINI_MAX_OUTPUT_TOKENS, VERTEX_GEMINI_DEFAULT_THINKING_LEVEL, VERTEX_GEMINI_DEFAULT_TIMEOUT_MS, type Content, type ContentRef, type PromptPreset, type PromptRole, type CreativeControls, type ChatProfile, type ProfileSnapshot, type Connection, type ModelPreset, type Library, type Branch, type Asset, type Attempt } from '../core/product.js';
import type { RunSnapshot, Resource } from '../core/types.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { aggregateTranslation, BUILTIN_ASSETS, validateDisplayAnnotation, validatePresentation, validateTranslationChunk, validateTranslationPlan, type TranslationPlan, type TranslationResult } from '../core/auxiliary.js';
import { validateTranslationArtifact } from './source-editing.js';
import { sourceTimeContext } from './product-auxiliary.js';
import { storyTables } from './story-store.js';
import { normalizeStoryArchiveRow, validateStoryArchive } from './story-archive.js';

import { validateSolOptions } from '../core/sol-config.js';
import { validatePromptProgram, validateChatPromptControls, resolvePromptValues } from '../core/prompt-program.js';
import { validateHiddenStorySelection } from './hidden-story.js';
import { nativeBotTables } from './native-bot.js';
import { validateNativeArchive, validateNativeVersion, validateNativeRunSnapshot } from './native-archive.js';
import { nativeResources } from '../core/native-context.js';
import { validateRegistrationArchive, validateRegistrationGraph } from './provider-registration-store.js';
import { assertModelSelection } from './provider-selection.js';
import { organizationTables } from './chat-organization.js';
import { validateContentPackage, validatePackageAttachment, type ContentPackage, type PackageAttachment } from '../core/content-package.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import { packageBehaviorTables, validatePackageBehaviorArchive, validatePackageBehaviorRunSnapshot } from './package-behavior-archive.js';
import { branchPackageStates } from './package-behavior-host.js';

type Row = Record<string, any>;
const json = JSON.stringify;
const parse = (s: any) => s == null ? null : JSON.parse(String(s));
export const record = (v: unknown): Row => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Expected an object'); return v as Row; };
export const fields = (b: Row, keys: string[]) => { if (Object.keys(b).some(k => !keys.includes(k))) throw new HttpError(400, 'Unknown request field'); };
export const text = (v: unknown, name: string, max = 4000, empty = false): string => { if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) throw new HttpError(400, `Invalid ${name}`); return v; };
export const number = (v: unknown, name: string, min = 1, max = 1e9): number => { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) throw new HttpError(400, `Invalid ${name}`); return Number(v); };
const choice = <T extends string>(v: unknown, values: T[], name: string): T => { if (!values.includes(v as T)) throw new HttpError(400, `Invalid ${name}`); return v as T; };
const boolean = (v: unknown): boolean => { if (typeof v !== 'boolean') throw new HttpError(400, 'Invalid boolean'); return v; };
const ref = (v: unknown): ContentRef => { const b = record(v); fields(b, ['id','revision']); return { id: text(b.id, 'reference', 100), revision: number(b.revision, 'revision') }; };
export function creative(v: unknown): CreativeControls {
  const b = record(v); fields(b, ['mode','language','personaReference','worldFocus','coNarration','declarationFinal','pov','style','lengthMode','minWords','maxWords','customWords']);
  const result: CreativeControls = { mode: choice(b.mode,['novel','rp'],'mode'), language: choice(b.language,['en','ko'],'language'), personaReference: boolean(b.personaReference), worldFocus: boolean(b.worldFocus), coNarration: boolean(b.coNarration), declarationFinal: boolean(b.declarationFinal), pov: choice(b.pov,['auto','first','third'],'pov'), style: choice(b.style,['auto','calm','vivid'],'style'), lengthMode: choice(b.lengthMode,['auto','range','custom'],'length'), minWords: number(b.minWords,'minWords',1,100000), maxWords: number(b.maxWords,'maxWords',1,100000), customWords: number(b.customWords,'customWords',1,100000) };
  if (result.minWords > result.maxWords) throw new HttpError(400, 'Invalid length range'); return result;
}

function connectionEndpoint(value: unknown, protocol: Connection['protocol']) {
  const endpoint = text(value,'endpoint',2000);
  try { return validateProviderEndpoint(protocol,endpoint); } catch { throw new HttpError(400,'Invalid provider endpoint'); }
}
function requestTier(value: unknown, protocol: Connection['protocol']) {
  if (value === undefined) return undefined;
  if (protocol !== 'vertex-gemini-v1') throw new HttpError(400,'Request tier requires Vertex');
  return choice(value,['standard','flex'],'request tier');
}
const modelOptionKeys = ['thinkingLevel','timeoutMs','structuredOutput','reasoningEffort','thinkingMode','thinkingBudgetTokens','sol'];
function catalogTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new HttpError(400,'Invalid catalog timestamp');
  return value;
}
function userOverrides(value: unknown): NonNullable<ModelPreset['userOverrides']> {
  const b = record(value); fields(b,['tools','structuredOutput','note']);
  return {tools:b.tools === null ? null : boolean(b.tools),structuredOutput:b.structuredOutput === null ? null : boolean(b.structuredOutput),note:text(b.note,'override note',2000,true)};
}
function validateModelMetadata(value: Row) {
  if (value.enabled !== undefined) boolean(value.enabled);
  if (value.userOverrides !== undefined) userOverrides(value.userOverrides);
  if (value.source !== undefined) {
    const source = record(value.source); fields(source,['kind','connectionRevision','catalogUpdatedAt']);
    choice(source.kind,['catalog','manual'],'model source'); number(source.connectionRevision,'source connection revision'); catalogTimestamp(source.catalogUpdatedAt);
    if (source.connectionRevision !== value.connectionRevision) throw new HttpError(400,'Model source revision mismatch');
  }
}
function validateModelGeneration(value: Row, protocol?: Connection['protocol']) {
  if (value.sol !== undefined) {
    if (protocol && protocol !== 'sol-responses-v1') throw new HttpError(400,'Sol options require Sol Responses');
    try { validateSolOptions(value.sol); } catch { throw new HttpError(400,'Invalid Sol options'); }
  }
  number(value.maxOutputTokens,'output limit',1,200000);
  if (value.temperature !== null && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) throw new HttpError(400,'Invalid temperature');
  if (value.thinkingLevel !== undefined) choice(value.thinkingLevel,['LOW','MEDIUM','HIGH'],'thinking level');
  if (value.timeoutMs !== undefined) number(value.timeoutMs,'timeout',1,protocol === 'fixture-sse-v1' ? 600000 : 1800000);
  if (value.structuredOutput !== undefined) boolean(value.structuredOutput);
  if (value.reasoningEffort !== undefined) choice(value.reasoningEffort,['none','minimal','low','medium','high','xhigh','max'],'reasoning effort');
  if (value.thinkingMode !== undefined) choice(value.thinkingMode,['disabled','enabled','adaptive'],'thinking mode');
  if (value.thinkingBudgetTokens !== undefined) number(value.thinkingBudgetTokens,'thinking budget',1024,value.maxOutputTokens-1);
  if (!protocol) return; // Archive graph validation checks the referenced connection after every version is restored.
  const forbidden = protocol === 'vertex-gemini-v1' || protocol === 'fixture-sse-v1' ? ['structuredOutput','reasoningEffort','thinkingMode','thinkingBudgetTokens'] :
    protocol === 'anthropic-messages-v1' ? ['thinkingLevel'] : ['thinkingLevel','thinkingMode','thinkingBudgetTokens'];
  if (forbidden.some(key => value[key] !== undefined)) throw new HttpError(400,'Unsupported provider model option');
  if (protocol === 'vertex-gemini-v1') {
    if (value.modelId !== VERTEX_GEMINI_MODEL_ID) throw new HttpError(400,'Unsupported Vertex model');
    if (value.temperature !== null) throw new HttpError(400,'Vertex Gemini does not accept temperature');
    number(value.maxOutputTokens,'Vertex output limit',1,VERTEX_GEMINI_MAX_OUTPUT_TOKENS);
  }
  if (protocol === 'anthropic-messages-v1') {
    if (value.temperature !== null && value.temperature > 1) throw new HttpError(400,'Invalid Anthropic temperature');
    if (value.reasoningEffort !== undefined) choice(value.reasoningEffort,['low','medium','high','xhigh','max'],'Anthropic effort');
    if (value.thinkingMode === 'enabled') number(value.thinkingBudgetTokens,'thinking budget',1024,value.maxOutputTokens-1);
    else if (value.thinkingBudgetTokens !== undefined) throw new HttpError(400,'Thinking budget requires enabled thinking');
    if (['enabled','adaptive'].includes(value.thinkingMode) && value.temperature !== null) throw new HttpError(400,'Thinking does not accept temperature');
  }
}

export class ProductStore {
  constructor(readonly store: Store) {}
  get db() { return this.store.db; }
  /** Joins Store's single transaction for a new, empty schema-8 database. */
  initFresh() {
      this.db.exec(`
        CREATE TABLE versions (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id,revision));
        CREATE TABLE profiles (chat_id TEXT PRIMARY KEY REFERENCES chats(id),body TEXT NOT NULL);
        CREATE TABLE branches (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),title TEXT NOT NULL,head_revision TEXT REFERENCES sources(id),revision INTEGER NOT NULL,is_default INTEGER NOT NULL);
        CREATE UNIQUE INDEX default_branch ON branches(chat_id) WHERE is_default=1;
        CREATE TABLE job_chunks (job_id TEXT NOT NULL REFERENCES jobs(id),id TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,input TEXT,result TEXT,error TEXT,PRIMARY KEY(job_id,id));
        CREATE TABLE attempts (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),run_id TEXT REFERENCES runs(id),job_id TEXT REFERENCES jobs(id),role TEXT NOT NULL,connection_id TEXT NOT NULL,model_id TEXT NOT NULL,status TEXT NOT NULL,request TEXT NOT NULL,response TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL,raw_usage TEXT,price_revision TEXT,error TEXT,story_job_id TEXT REFERENCES story_jobs(id));
        CREATE TABLE assets (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),body TEXT NOT NULL,bytes BLOB NOT NULL);
        CREATE TABLE source_edits(source_id TEXT NOT NULL REFERENCES sources(id),revision INTEGER NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,revision));
      `);
  }
  all(kind: string): any[] { return (this.db.prepare('SELECT v.body FROM versions v WHERE kind=? AND revision=(SELECT MAX(revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id) ORDER BY id').all(kind) as Row[]).map(r => parse(r.body)); }
  get<T>(kind: string, id: string, revision?: number): T {
    const r = (revision === undefined ? this.db.prepare('SELECT body FROM versions WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1').get(kind,id) : this.db.prepare('SELECT body FROM versions WHERE kind=? AND id=? AND revision=?').get(kind,id,revision)) as Row | undefined;
    if (!r) throw new HttpError(404, `${kind} revision not found`); return parse(r.body);
  }
  save(kind: string, value: Row, id?: string, expected?: number) {
    return this.store.transaction(() => {
      const prior = id ? this.get<ContentRef>(kind,id) : null;
      if (prior && prior.revision !== expected) throw new HttpError(409,'Revision conflict');
      const result: Row & ContentRef = { ...value, id: id ?? randomUUID(), revision: (prior?.revision ?? 0) + 1 };
      if (kind === 'content' && result.package) result.package = validateContentPackage({...result.package,id:result.id,revision:result.revision,title:result.title,description:result.description,body:result.text});
      this.db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(kind,result.id,result.revision,json(result)); return result;
    });
  }
  content(value: unknown, id?: string) {
    const b = record(value); fields(b,['kind','title','description','text','loading','relatedIds','expectedRevision','package']);
    if (!Array.isArray(b.relatedIds) || b.relatedIds.length > 100) throw new HttpError(400,'Invalid related IDs');
    if(id&&b.kind!=='bot'&&!b.package&&this.db.prepare('SELECT 1 FROM chat_organization WHERE bot_id=? LIMIT 1').get(id))throw new HttpError(400,'A chat owner must remain available as a bot or package');
    return this.save('content',{ kind: choice(b.kind,['bot','persona','module','lore','canon','skill','glossary'],'content kind'), title: text(b.title,'title',200), description: text(b.description,'description',b.package?4000:2000,true), text: text(b.text,'text',b.package?1_000_000:100000,!!b.package), loading: choice(b.loading,['pinned','discoverable'],'loading'), relatedIds: [...new Set(b.relatedIds.map((x: unknown) => text(x,'related ID',100)))],...(b.package!==undefined?{package:validateContentPackage(b.package)}:{}) },id,id ? number(b.expectedRevision,'revision') : undefined);
  }
  preset(value: unknown) { const b = record(value); fields(b,['title','controls']); return this.save('preset',{ title: text(b.title,'title',200), controls: creative(b.controls) }); }
  promptCombination(value:unknown) {
    const b=record(value);fields(b,['title','prompt','values']);const prompt=ref(b.prompt);
    const preset=this.get<PromptPreset>('prompt-preset',prompt.id,prompt.revision);
    if(!preset.program)throw new HttpError(400,'Creative preset requires prompt controls');
    const values=resolvePromptValues(preset.program,record(b.values));
    return this.save('prompt-combination',{title:text(b.title,'title',200),prompt,values});
  }
  promptPreset(value: unknown, id?: string) {
    const b = record(value); fields(b,['title','role','text','program','expectedRevision']);
    return this.save('prompt-preset',{title:text(b.title,'title',200),role:choice(b.role,['main','translation'],'prompt role'),text:text(b.text,'prompt text',200000,true),...(b.program!==undefined?{program:validatePromptProgram(b.program)}:{})},id,id ? number(b.expectedRevision,'revision') : undefined);
  }
  prepareConnection(value: unknown, id?: string) {
    const b = record(value); fields(b,['title','protocol','endpoint','credentialEnv','requestTier','enabled','expectedRevision']);
    const protocol = choice(b.protocol,[...PROVIDER_PROTOCOLS],'protocol'); const tier = requestTier(b.requestTier,protocol);
    const endpoint = connectionEndpoint(b.endpoint,protocol);
    const credentialEnv = b.credentialEnv === undefined || b.credentialEnv === '' ? undefined : text(b.credentialEnv,'credential reference',200);
    if (credentialEnv && !/^NARRATIVE_PROVIDER_[A-Z0-9_]+$/.test(credentialEnv)) throw new HttpError(400,'Invalid credential reference');
    if (credentialEnv && isVertexFileReference(credentialEnv) && (protocol !== 'vertex-gemini-v1' || !validVertexFileReference(credentialEnv))) throw new HttpError(400,'Invalid service account reference');
    const prior = id ? this.get<Connection>('connection',id) : undefined;
    const expectedRevision = id ? number(b.expectedRevision,'revision') : undefined;
    if (prior && prior.revision !== expectedRevision) throw new HttpError(409,'Revision conflict');
    const sameAuthority = prior?.protocol === protocol && prior.endpoint === endpoint && prior.credentialEnv === credentialEnv;
    const prepared: Omit<Connection,'id'|'revision'> = { title: text(b.title,'title',200), protocol, endpoint, ...(credentialEnv ? {credentialEnv} : {}), ...(tier !== undefined ? {requestTier:tier} : {}), enabled: boolean(b.enabled), catalog: sameAuthority ? structuredClone(prior.catalog) : [], catalogError: sameAuthority ? prior.catalogError : null, catalogUpdatedAt: sameAuthority ? prior.catalogUpdatedAt ?? null : null };
    return {value:prepared,expectedRevision};
  }
  connection(value: unknown, id?: string) { const prepared = this.prepareConnection(value,id); return this.save('connection',prepared.value,id,prepared.expectedRevision); }
  prepareModel(value: unknown, id?: string, validationConnection?: Connection) {
    const b = record(value); fields(b,['title','connectionId','connectionRevision','modelId','maxOutputTokens','temperature',...modelOptionKeys,'enabled','userOverrides','expectedRevision']);
    const expectedRevision = id ? number(b.expectedRevision,'revision') : undefined;
    if (id && this.get<ModelPreset>('model',id).revision !== expectedRevision) throw new HttpError(409,'Revision conflict');
    const connectionId = text(b.connectionId,'connection ID',100); const connectionRevision = number(b.connectionRevision,'connection revision');
    if (validationConnection && (validationConnection.id !== connectionId || validationConnection.revision !== connectionRevision)) throw new HttpError(400,'Validation connection revision mismatch');
    const connection = validationConnection ?? this.get<Connection>('connection',connectionId,connectionRevision);
    const modelId = text(b.modelId,'model ID',300); validateModelGeneration(b,connection.protocol);
    const vertex = connection.protocol === 'vertex-gemini-v1';
    const prepared: Omit<ModelPreset,'id'|'revision'> = { title: text(b.title,'title',200), connectionId, connectionRevision, modelId, maxOutputTokens: b.maxOutputTokens, temperature: b.temperature,
      ...(vertex || b.thinkingLevel !== undefined ? {thinkingLevel:b.thinkingLevel ?? VERTEX_GEMINI_DEFAULT_THINKING_LEVEL} : {}),
      ...(vertex || b.timeoutMs !== undefined ? {timeoutMs:b.timeoutMs ?? VERTEX_GEMINI_DEFAULT_TIMEOUT_MS} : {}),
      ...Object.fromEntries(['structuredOutput','reasoningEffort','thinkingMode','thinkingBudgetTokens'].filter(key => b[key] !== undefined).map(key => [key,b[key]])),
      ...(b.sol !== undefined ? {sol:validateSolOptions(b.sol)} : {}),
      ...(b.enabled !== undefined ? {enabled:boolean(b.enabled)} : {}),
      ...(b.userOverrides !== undefined ? {userOverrides:userOverrides(b.userOverrides)} : {}),
      source:{kind:connection.catalog.some(item => item.id === modelId) ? 'catalog' : 'manual',connectionRevision,catalogUpdatedAt:connection.catalogUpdatedAt ?? null},
    };
    return {value:prepared,expectedRevision};
  }
  model(value: unknown, id?: string) { const prepared = this.prepareModel(value,id); return this.save('model',prepared.value,id,prepared.expectedRevision); }
  profile(chatId: string): ChatProfile { this.store.chat(chatId); const r = this.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chatId) as Row | undefined; return r ? parse(r.body) : defaultProfile(chatId); }
  updateProfile(chatId: string, value: unknown): ChatProfile {
    const b = record(value); fields(b,['expectedRevision','attachments','creative','routes','image','prompts','promptControls','hiddenStory','packageAttachments','packageValues']); const routes = record(b.routes); fields(routes,['main','translation','status','image']);
    if (!Array.isArray(b.attachments) || b.attachments.length > 300) throw new HttpError(400,'Invalid attachments');
    const attachments = b.attachments.map(ref); if (new Set(attachments.map(r => r.id)).size !== attachments.length) throw new HttpError(400,'Duplicate attachment');
    for (const r of attachments) this.get('content',r.id,r.revision);
    const selected = Object.fromEntries(['main','translation','status','image'].map(role => { const r = routes[role] === null ? null : ref(routes[role]); if (r) this.get('model',r.id,r.revision); return [role,r]; })) as ChatProfile['routes'];
    const controls = creative(b.creative); const image = boolean(b.image);
    const requestedPrompts = b.prompts === undefined ? undefined : promptRefs(this,b.prompts);
    const requestedControls = b.promptControls === undefined ? undefined : promptControls(this,b.promptControls);
    const requestedHidden = b.hiddenStory===undefined?undefined:validateHiddenStorySelection(this,b.hiddenStory);
    return this.store.transaction(() => {
      const prior = this.profile(chatId); if (prior.revision !== number(b.expectedRevision,'profile revision')) throw new HttpError(409,'Profile revision conflict');
      const packageAttachments=b.packageAttachments===undefined?prior.packageAttachments:packageRefs(this,b.packageAttachments);
      validateAttachmentRoles(this,attachments,packageAttachments);
      const allowedPackageKeys=new Set((packageAttachments??[]).map(packageControlKey));
      const inheritedPackageValues=prior.packageValues===undefined?undefined:Object.fromEntries(Object.entries(prior.packageValues).filter(([key])=>allowedPackageKeys.has(key)));
      const requestedPackageValues=b.packageValues===undefined?inheritedPackageValues:b.packageValues;
      const packageValues=requestedPackageValues===undefined?undefined:packageControlValues(this,packageAttachments??[],requestedPackageValues);
      this.store.organization.assertBotAttachments(chatId,attachments,packageAttachments);
      for (const role of ['main','translation','status','image'] as const) assertModelSelection(this,selected[role],prior.routes[role]);
      const prompts = requestedPrompts === undefined ? prior.prompts : {...prior.prompts,...requestedPrompts};
      const savedControls = requestedControls === undefined ? prior.promptControls : {...prior.promptControls,...requestedControls};
      const hiddenStory=requestedHidden??prior.hiddenStory;
      const result: ChatProfile = { chatId, revision: prior.revision+1, attachments, creative: controls, routes: selected, image, ...(prompts !== undefined ? {prompts} : {}), ...(savedControls!==undefined?{promptControls:savedControls}:{}),...(hiddenStory?{hiddenStory}:{}),...(packageAttachments!==undefined?{packageAttachments}:{}),...(packageValues!==undefined?{packageValues}:{}) };
      this.db.prepare('INSERT INTO profiles VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET body=excluded.body').run(chatId,json(result)); this.store.event(chatId,'profile.updated',chatId); return result;
    });
  }
  applyPreset(chatId: string, value: unknown) { const b = record(value); fields(b,['expectedRevision','presetId','presetRevision']); const preset = this.get<{controls: CreativeControls}>('preset',text(b.presetId,'preset ID',100),number(b.presetRevision,'preset revision')); const p = this.profile(chatId); return this.updateProfile(chatId,{ expectedRevision: b.expectedRevision, attachments: p.attachments, creative: preset.controls, routes: p.routes, image: p.image }); }
  snapshot(chatId: string): ProfileSnapshot | undefined {
    // Untouched M0 chats retain the original deterministic fixture contract.
    if (!this.db.prepare('SELECT 1 FROM profiles WHERE chat_id=?').get(chatId)) return undefined;
    const p = this.profile(chatId); const contents = p.attachments.map(r => this.get<Content>('content',r.id,r.revision));
    const models: ProfileSnapshot['models'] = {};
    for (const role of ['main','translation','status','image'] as const) { const r = p.routes[role]; if (r) { const m = this.get<ModelPreset>('model',r.id,r.revision); models[role] = {...m,connection:this.get<Connection>('connection',m.connectionId,m.connectionRevision)}; } }
    return structuredClone({...p,contents,models,...(p.packageAttachments!==undefined?{packages:p.packageAttachments.map(r=>this.get<Content>('content',r.id,r.revision).package!)}:{}),...(p.prompts !== undefined ? {promptPresets:resolvedPrompts(this,p.prompts)} : {})});
  }
  resolveJobPrompt(snapshot: RunSnapshot, input: unknown): RunSnapshot {
    const resolved = structuredClone(snapshot);
    if(input && typeof input==='object' && !Array.isArray(input) && Object.hasOwn(input,'translationModelSelection')){
      const selected=record(input).translationModelSelection;
      resolved.profile ??= {...defaultProfile(resolved.chatId),contents:[],models:{}};
      if(selected===null){delete resolved.profile.models.translation;resolved.profile.routes.translation=null;}
      else {const reference=ref(selected);const model=this.get<ModelPreset>('model',reference.id,reference.revision);resolved.profile.models.translation={...model,connection:this.get<Connection>('connection',model.connectionId,model.connectionRevision)};resolved.profile.routes.translation=reference;}
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input,'promptSelection')) return resolved;
    const selection = record(record(input).promptSelection); fields(selection,['translation']);
    if (!Object.hasOwn(selection,'translation')) throw new HttpError(400,'Translation prompt selection required');
    const selected = promptRefs(this,selection).translation!;
    if (!resolved.profile) {
      if (selected === null) return resolved;
      resolved.profile = {...defaultProfile(resolved.chatId),contents:[],models:{}};
    }
    resolved.profile.prompts = {...resolved.profile.prompts,translation:selected};
    resolved.profile.promptPresets = {...resolved.profile.promptPresets};
    if (selected === null) delete resolved.profile.promptPresets.translation;
    else resolved.profile.promptPresets.translation = this.get<PromptPreset>('prompt-preset',selected.id,selected.revision);
    if(Object.hasOwn(input,'promptControlSelection')){
      const raw=record(input).promptControlSelection;
      if(selected){const key=`${selected.id}@${selected.revision}`;const existing={...resolved.profile.promptControls};delete existing[key];if(raw!==null)Object.assign(existing,promptControls(this,{[key]:raw}));resolved.profile.promptControls=existing;}
      else if(raw!==null)throw new HttpError(400,'Prompt controls require selected translation prompt');
    }
    return resolved;
  }
  resources(chatId: string, p?: ProfileSnapshot): Resource[] { return p ? [...p.contents.filter(c => ['lore','skill','glossary'].includes(c.kind)).map(c => ({...c,chatId,kind:c.kind === 'skill' ? 'skill' as const : 'lore' as const,sourceKind:c.kind})),...(p.packageAttachments??[]).flatMap(r=>compilePackageAttachment(p.packages!.find(pkg=>pkg.id===r.id&&pkg.revision===r.revision)!,r,{chatId,target:'main',resourcesOnly:true,values:p.packageValues?.[packageControlKey(r)]}).resources)] : this.store.resources(chatId); }
  authorize(connection: Connection) { const current = this.get<Connection>('connection',connection.id); if (!current.enabled || current.endpoint !== connection.endpoint || current.protocol !== connection.protocol || current.credentialEnv !== connection.credentialEnv || current.requestTier !== connection.requestTier) throw new HttpError(403,'Connection disabled or authority changed'); return structuredClone(connection); }
  branches(chatId: string): Branch[] { return (this.db.prepare('SELECT * FROM branches WHERE chat_id=? ORDER BY is_default DESC,id').all(chatId) as Row[]).map(r => ({id:r.id,chatId:r.chat_id,title:r.title,headRevision:r.head_revision,revision:r.revision,default:!!r.is_default})); }
  branch(chatId: string, id = `main:${chatId}`): Branch { const b = this.branches(chatId).find(x => x.id === id); if (!b) throw new HttpError(404,'Branch not found'); return b; }
  createBranch(chatId:string,value:unknown,native?:import('../core/native-bot.js').NativeBotSnapshot|null){
    const b=record(value);fields(b,['title','fromRevision']);const title=text(b.title,'title',200);const head=b.fromRevision===null?null:text(b.fromRevision,'source revision',100);
    if(head&&this.store.source(head).chatId!==chatId)throw new HttpError(400,'Source outside chat');this.store.chat(chatId);
    const original=native===undefined&&head?this.store.run(this.store.source(head).runId).snapshot.nativeBot:native;
    this.db.exec('SAVEPOINT create_native_branch');
    try{
      const id=randomUUID();this.db.prepare('INSERT INTO branches VALUES(?,?,?,?,1,0)').run(id,chatId,title,head);
      if(original)this.store.native.cloneToBranchInTransaction(original,id);
      branchPackageStates(this.store,chatId,id,head);
      this.store.event(chatId,'branch.created',id);this.db.exec('RELEASE create_native_branch');return this.branch(chatId,id);
    }catch(error){this.db.exec('ROLLBACK TO create_native_branch; RELEASE create_native_branch');throw error;}
  }
  chunks(jobId: string) { return (this.db.prepare('SELECT * FROM job_chunks WHERE job_id=? ORDER BY rowid').all(jobId) as Row[]).map(r => ({ id:r.id,status:r.status,attempt:r.attempt,error:r.error,result:parse(r.result),input:parse(r.input) })); }
  plan(jobId: string, value?: unknown): any { if (value !== undefined) this.db.prepare('UPDATE jobs SET plan=? WHERE id=? AND plan IS NULL').run(json(value),jobId); const r = this.db.prepare('SELECT plan FROM jobs WHERE id=?').get(jobId) as Row; return parse(r.plan); }
  chunk(jobId: string, id: string, status: string, input?: unknown, result?: unknown, error?: string) { this.db.prepare('INSERT INTO job_chunks(job_id,id,status,attempt,input,result,error) VALUES(?,?,?,1,?,?,?) ON CONFLICT(job_id,id) DO UPDATE SET status=excluded.status,attempt=job_chunks.attempt+CASE WHEN excluded.status=\'running\' THEN 1 ELSE 0 END,input=COALESCE(excluded.input,job_chunks.input),result=COALESCE(excluded.result,job_chunks.result),error=excluded.error').run(jobId,id,status,input === undefined ? null : json(input),result === undefined ? null : json(result),error ?? null); }
  startAttempt(chatId: string, runId: string | null, jobId: string | null, request: WireRecord) { const id = randomUUID(); const safe = structuredClone(request); if (safe.body && typeof safe.body === 'object' && !Array.isArray(safe.body) && 'opaqueState' in safe.body) safe.body.opaqueState = '[provider continuation withheld]'; this.db.prepare("INSERT INTO attempts(id,chat_id,run_id,job_id,role,connection_id,model_id,status,request) VALUES(?,?,?,?,?,?,?,'running',?)").run(id,chatId,runId,jobId,request.role,request.connectionId,request.modelId,json(safe)); return id; }
  finishAttempt(id: string, result: ProviderResult) { const safe = {...structuredClone(result),opaqueState:result.opaqueState === null ? null : '[provider continuation withheld]'}; this.db.prepare("UPDATE attempts SET status=?,response=?,input_tokens=?,output_tokens=?,cost_usd=?,raw_usage=?,price_revision=?,error=? WHERE id=? AND status='running'").run(result.status,json(safe),result.usage.inputTokens,result.usage.outputTokens,result.usage.costUsd,json(result.usage.raw),result.usage.priceRevision,result.error?.code ?? null,id); }
  mockAttempt(chatId:string,runId:string|null,jobId:string|null,role:string,input:unknown) { const id = randomUUID(); this.db.prepare("INSERT INTO attempts(id,chat_id,run_id,job_id,role,connection_id,model_id,status,request) VALUES(?,?,?,?,?,'local-scripted','deterministic-fixture','mock',?)").run(id,chatId,runId,jobId,role,json({mock:true,input})); return id; }
  attempts(chatId: string): Attempt[] { return (this.db.prepare('SELECT * FROM attempts WHERE chat_id=? ORDER BY rowid').all(chatId) as Row[]).map(r => ({id:r.id,runId:r.run_id,jobId:r.job_id,storyJobId:r.story_job_id??null,role:r.role,connectionId:r.connection_id,modelId:r.model_id,status:r.status,inputTokens:r.input_tokens,outputTokens:r.output_tokens,costUsd:r.cost_usd,rawUsage:parse(r.raw_usage),priceRevision:r.price_revision,error:r.error,request:parse(r.request),response:parse(r.response)})); }
  assets(chatId?: string): Asset[] { return ((chatId ? this.db.prepare('SELECT body FROM assets WHERE chat_id=?').all(chatId) : this.db.prepare('SELECT body FROM assets').all()) as Row[]).map(r => parse(r.body)); }
  asset(id: string) { const r = this.db.prepare('SELECT body,bytes FROM assets WHERE id=?').get(id) as Row | undefined; if (!r) throw new HttpError(404,'Asset not found'); return { asset:parse(r.body) as Asset,bytes:Buffer.from(r.bytes) }; }
  createAsset(chatId: string, value: unknown) {
    this.store.chat(chatId); const b = record(value); fields(b,['title','mime','base64','description','actor','outfit','location','allowedUse']);
    const mime = choice(b.mime,['image/png','image/jpeg'],'image type'); const base64 = text(b.base64,'image',3e6); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400,'Invalid image encoding'); const bytes = Buffer.from(base64,'base64');
    if (bytes.length > 2e6 || (mime === 'image/png' ? !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)) throw new HttpError(400,'Invalid image bytes');
    const id = randomUUID(); const result: Asset = {id,chatId,revision:1,title:text(b.title,'title',200),mime,hash:createHash('sha256').update(bytes).digest('hex'),description:text(b.description,'description',2000,true),actor:text(b.actor,'actor',200,true),outfit:text(b.outfit,'outfit',200,true),location:text(b.location,'location',200,true),allowedUse:choice(b.allowedUse,['profile','inline','both'],'asset use'),url:`/api/assets/${id}`};
    this.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(id,chatId,json(result),bytes); return result;
  }
  library(summary = false): Library {
    // Project inside SQLite so large bodies never cross into JS for list requests.
    const contents = summary ? (this.db.prepare("SELECT json_set(json_remove(v.body,'$.package'),'$.text','') AS body, json_type(v.body,'$.package') AS packaged FROM versions v WHERE kind='content' AND revision=(SELECT MAX(revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id) ORDER BY id").all() as Row[]).map(r => ({...parse(r.body),...(r.packaged?{hasPackage:true}:{})})) : this.all('content');
    return {...(summary ? {contentBodiesOmitted:true,assetsOmitted:true} : {}),promptPresets:this.all('prompt-preset'),promptCombinations:this.all('prompt-combination'),contents,presets:this.all('preset'),connections:this.all('connection'),models:this.all('model'),assets:summary ? [] : this.assets()};
  }
  export() { const tables = Object.fromEntries(archiveTables.map(t => [t,(this.db.prepare(`SELECT * FROM ${t}`).all() as Row[]).map(r => t === 'assets' ? {...r,bytes:Buffer.from(r.bytes).toString('base64')} : r)])); return {format:'narrative-archive',version:8,createdAt:new Date().toISOString(),tables}; }
  backup(): Buffer { const path = `${this.store.path}.backup-${randomUUID()}.sqlite`; if (existsSync(path)) throw new Error('Backup destination exists'); try { this.db.prepare('VACUUM INTO ?').run(path); return readFileSync(path); } finally { if (existsSync(path)) unlinkSync(path); } }
  import(value: unknown) {
    // Validation and normalization must never mutate the caller's archive, even
    // when a later row fails and the database transaction rolls back.
    let copy: unknown; try { copy = structuredClone(value); } catch { throw new HttpError(400,'Invalid archive'); }
    const a = record(copy); fields(a,['format','version','createdAt','tables']); if (a.format !== 'narrative-archive' || a.version!==8) throw new HttpError(400,'Unsupported archive'); const tables = record(a.tables); fields(tables,archiveTables);
    if (archiveTables.some(t => !Array.isArray(tables[t]) || tables[t].length > 100000)) throw new HttpError(400,'Missing or oversized archive table');
    if (archiveTables.some(t => t!=='package_behavior_entropy' && this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())) throw new HttpError(409,'Restore requires an empty database');
    try { this.store.transaction(() => {
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      this.db.exec('DELETE FROM package_behavior_entropy');
      for (const table of archiveTables) {
        const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(r => r.name as string);
        for (const entry of tables[table]) { const row = record(entry); fields(row,columns); if (columns.some(k => !(k in row))) throw new HttpError(400,'Missing archive column');
          if (Object.values(row).some(v => v !== null && (typeof v !== 'string' && typeof v !== 'number' || typeof v === 'number' && !Number.isFinite(v)))) throw new HttpError(400,'Invalid archive column');
          if (table === 'versions') { validateArchiveVersion(row); if (row.kind === 'connection') { const body = record(parse(row.body)); delete body.credentialEnv; body.enabled = false; row.body = json(body); } }
          if (table === 'assets') validateArchiveAsset(row);
          if (table === 'runs') {
            const snapshot = record(parse(row.snapshot));
            if (snapshot.profile?.models) for (const model of Object.values(record(snapshot.profile.models))) {
              const connection = record(record(model).connection); delete connection.credentialEnv; connection.enabled = false;
            }
            row.snapshot = json(snapshot);
          }
          if (table === 'runs' && ['queued','running'].includes(row.status)) { row.status = 'interrupted'; row.error = 'Restored unfinished run; explicit retry required'; }
          if (table === 'jobs' && ['queued','running'].includes(row.status)) { row.status = 'interrupted'; row.owner = null; row.error = 'Restored unfinished job; explicit retry required'; }
          if (table === 'job_chunks' && row.status === 'running') { row.status = 'interrupted'; row.error = 'Restored uncertain chunk; explicit retry required'; }
          if (table === 'attempts' && row.status === 'running') { row.status = 'interrupted'; row.error = 'Restored uncertain request'; }
          if (table === 'attempts') {
            const request = record(parse(row.request)); if (request.body && typeof request.body === 'object' && 'opaqueState' in request.body) request.body.opaqueState = '[provider continuation withheld]'; row.request = json(scrubArchiveSecrets(request));
            if (row.response !== null) { const response = record(parse(row.response)); if (response.opaqueState !== undefined && response.opaqueState !== null) response.opaqueState = '[provider continuation withheld]'; row.response = json(scrubArchiveSecrets(response)); }
            if (row.raw_usage !== null) row.raw_usage = json(scrubArchiveSecrets(parse(row.raw_usage)));
          }
          normalizeStoryArchiveRow(table,row);
          this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(k => table === 'assets' && k === 'bytes' ? Buffer.from(text(row[k],'asset bytes',3e6),'base64') : row[k]));
        }
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new HttpError(400,'Archive references invalid');
      validateArchiveGraph(this);
      validateStoryArchive(this.store);
      validateNativeArchive(this.store);
      validatePackageBehaviorArchive(this.store);
      this.store.organization.validateArchive();
    }); } catch (error) { if (error instanceof HttpError && error.statusCode === 400) throw error; throw new HttpError(400,'Archive data or references invalid'); }
    return {restored:true,chats:this.store.chats().length};
  }
}
const archiveTables = ['chats','resources','versions','profiles','branches','runs','sources','source_edits','jobs','job_results','model_inputs','tool_events','events','job_chunks','attempts','assets',...storyTables,...nativeBotTables,...organizationTables,...packageBehaviorTables];

export const packageControlKey=(r:PackageAttachment)=>`${r.id}@${r.revision}:${r.role}`;
function packageRefs(product:ProductStore,value:unknown):PackageAttachment[]{
  if(!Array.isArray(value)||value.length>100)throw new HttpError(400,'Invalid package attachments');
  const refs=value.map(validatePackageAttachment);
  if(new Set(refs.map(r=>`${r.id}:${r.role}`)).size!==refs.length||refs.filter(r=>r.role==='bot').length>1||refs.filter(r=>r.role==='persona').length>1)throw new HttpError(400,'Duplicate package or primary role');
  for(const r of refs)if(!product.get<Content>('content',r.id,r.revision).package)throw new HttpError(400,'Content is not a package');
  return refs;
}
function packageControlValues(product:ProductStore,attachments:PackageAttachment[],value:unknown){
  const b=record(value);const allowed=new Map(attachments.map(r=>[packageControlKey(r),r]));
  return Object.fromEntries(Object.entries(b).map(([key,values])=>{const r=allowed.get(key);if(!r)throw new HttpError(400,'Package controls outside attachment scope');const pkg=product.get<Content>('content',r.id,r.revision).package!;return[key,resolvePromptValues({version:1,controls:pkg.controls,blocks:[]},record(values))];}));
}
function validateAttachmentRoles(product:ProductStore,attachments:ContentRef[],packages:PackageAttachment[]|undefined){
  if(packages?.some(r=>attachments.some(a=>a.id===r.id)))throw new HttpError(400,'Package is also attached as legacy content');
  if(attachments.some(r=>product.get<Content>('content',r.id,r.revision).package))throw new HttpError(400,'Package requires an explicit attachment role');
  // Preserve historical multi-content profiles; new primary package roles cannot coexist
  // with a second legacy primary role that would make the selected persona/bot ambiguous.
  for(const role of ['bot','persona'] as const)if(packages?.some(r=>r.role===role)&&attachments.some(r=>product.get<Content>('content',r.id,r.revision).kind===role))throw new HttpError(400,'Duplicate legacy and package primary role');
}

const archiveId = (value: unknown) => { const id = text(value,'archive ID',200); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new HttpError(400,'Invalid archive ID'); return id; };
function scrubArchiveSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubArchiveSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,/^(authorization|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(key) ? '[REDACTED]' : scrubArchiveSecrets(item)]));
  return value;
}
function archiveList(value: unknown, maximum = 300): any[] { if (!Array.isArray(value) || value.length > maximum) throw new HttpError(400,'Invalid archive list'); return value; }
function archiveSettings(value: unknown) {
  const b = record(value); fields(b,['preset','mode','translation','status','maxCalls']);
  choice(b.preset,['calm','vivid'],'preset'); choice(b.mode,['direct','research'],'mode'); boolean(b.translation); boolean(b.status); number(b.maxCalls,'call limit',1,16);
}
function promptControls(product:ProductStore,value:unknown):NonNullable<ChatProfile['promptControls']>{
  const b=record(value);if(Object.keys(b).length>200)throw new HttpError(400,'Too many saved prompt control sets');
  return Object.fromEntries(Object.entries(b).map(([key,raw])=>{const match=/^([^@]+)@([1-9][0-9]*)$/u.exec(key);if(!match)throw new HttpError(400,'Prompt control key requires id@revision');const preset=product.get<PromptPreset>('prompt-preset',match[1],number(Number(match[2]),'prompt revision'));if(!preset.program)throw new HttpError(400,'Prompt controls require a composed prompt');const controls=validateChatPromptControls(raw);resolvePromptValues(preset.program,controls.values);controls.combinations.forEach(c=>resolvePromptValues(preset.program!,c.values));return[key,controls];}));
}
function promptRefs(product: ProductStore, value: unknown): NonNullable<ChatProfile['prompts']> {
  const selected = record(value); fields(selected,['main','translation']);
  const result: NonNullable<ChatProfile['prompts']> = {};
  for (const role of Object.keys(selected) as PromptRole[]) {
    const reference = selected[role] === null ? null : ref(selected[role]);
    if (reference && product.get<PromptPreset>('prompt-preset',reference.id,reference.revision).role !== role) throw new HttpError(400,'Prompt role mismatch');
    result[role] = reference;
  }
  return result;
}
function resolvedPrompts(product: ProductStore, value: NonNullable<ChatProfile['prompts']>): NonNullable<ProfileSnapshot['promptPresets']> {
  return Object.fromEntries(Object.entries(promptRefs(product,value)).flatMap(([role,reference]) => reference ? [[role,product.get<PromptPreset>('prompt-preset',reference.id,reference.revision)]] : []));
}
function validateArchiveVersion(row: Row) {
  const body = record(parse(row.body)); archiveId(row.id); number(row.revision,'version');
  if (body.id !== row.id || body.revision !== row.revision) throw new HttpError(400,'Version identity mismatch');
  if(row.kind==='registration-run'){validateRegistrationArchive(body);return;}
  text(body.title,'title',200);
  if (row.kind === 'content') {
    fields(body,['id','revision','kind','title','description','text','loading','relatedIds','package']); choice(body.kind,['bot','persona','module','lore','canon','skill','glossary'],'content kind');
    text(body.description,'description',body.package?4000:2000,true); text(body.text,'content text',body.package?1_000_000:100000,!!body.package); choice(body.loading,['pinned','discoverable'],'loading'); archiveList(body.relatedIds,100).forEach(archiveId);
    if(body.package!==undefined){const pkg=validateContentPackage(body.package);if(pkg.id!==body.id||pkg.revision!==body.revision||pkg.title!==body.title||pkg.description!==body.description||pkg.body!==body.text)throw new HttpError(400,'Package identity mismatch');}
  } else if (row.kind === 'preset') { fields(body,['id','revision','title','controls']); creative(body.controls); }
  else if (row.kind === 'prompt-preset') { fields(body,['id','revision','title','role','text','program']); choice(body.role,['main','translation'],'prompt role'); text(body.text,'prompt text',200000,true); if(body.program!==undefined)validatePromptProgram(body.program); }
  else if (row.kind === 'prompt-combination') { fields(body,['id','revision','title','prompt','values']);ref(body.prompt);validateChatPromptControls({values:body.values,combinations:[]}); }
  else if (row.kind === 'connection') {
    fields(body,['id','revision','title','protocol','endpoint','credentialEnv','requestTier','enabled','catalog','catalogError','catalogUpdatedAt']); const protocol = choice(body.protocol,[...PROVIDER_PROTOCOLS],'protocol'); requestTier(body.requestTier,protocol);
    if (body.catalogUpdatedAt !== undefined) catalogTimestamp(body.catalogUpdatedAt);
    connectionEndpoint(body.endpoint,protocol);
    boolean(body.enabled); if (body.credentialEnv !== undefined && !/^NARRATIVE_PROVIDER_[A-Z0-9_]+$/.test(text(body.credentialEnv,'credential reference',200))) throw new HttpError(400,'Invalid credential reference');
    archiveList(body.catalog,5000).forEach(raw => { const model = record(raw); fields(model,['id','name','capabilities','priceRevision']); text(model.id,'catalog ID',300); text(model.name,'catalog name',400); const capabilities = record(model.capabilities); if (Object.values(capabilities).some(v => v !== null && typeof v !== 'boolean')) throw new HttpError(400,'Invalid catalog capabilities'); if (model.priceRevision !== null) text(model.priceRevision,'price revision',200); });
    if (body.catalogError !== null) text(body.catalogError,'catalog error',2000);
  } else if (row.kind === 'model') {
    fields(body,['id','revision','title','connectionId','connectionRevision','modelId','maxOutputTokens','temperature',...modelOptionKeys,'enabled','userOverrides','source']); archiveId(body.connectionId); number(body.connectionRevision,'connection revision'); text(body.modelId,'model ID',300); validateModelGeneration(body); validateModelMetadata(body);
  } else if(['native-bot','hidden-story'].includes(row.kind))validateNativeVersion(row);else throw new HttpError(400,'Invalid archive version kind');
}
function validateArchiveAsset(row: Row) {
  const body = record(parse(row.body)); fields(body,['id','chatId','revision','title','mime','hash','description','actor','outfit','location','allowedUse','url']);
  archiveId(row.id); archiveId(row.chat_id); if (body.id !== row.id || body.chatId !== row.chat_id) throw new HttpError(400,'Asset identity mismatch');
  if (BUILTIN_ASSETS.some(asset => asset.ref === row.id)) throw new HttpError(400,'Reserved host asset ID');
  number(body.revision,'asset revision'); text(body.title,'asset title',200); text(body.description,'asset description',2000,true); for (const key of ['actor','outfit','location']) text(body[key],key,200,true);
  choice(body.allowedUse,['profile','inline','both'],'asset use'); const mime = choice(body.mime,['image/png','image/jpeg'],'asset MIME');
  const encoded = text(row.bytes,'asset bytes',3e6); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new HttpError(400,'Invalid asset encoding'); const bytes = Buffer.from(encoded,'base64');
  if (bytes.length > 2e6 || (mime === 'image/png' ? !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)) throw new HttpError(400,'Invalid asset bytes');
  if (createHash('sha256').update(bytes).digest('hex') !== body.hash) throw new HttpError(400,'Asset hash mismatch');
  body.url = `/api/assets/${encodeURIComponent(row.id)}`; row.body = json(body);
}
function validateArchiveProfile(product: ProductStore, value: unknown, chatId: string, frozen = false): ProfileSnapshot | ChatProfile {
  const p = record(value); fields(p,['chatId','revision','attachments','creative','routes','image','prompts','promptControls','hiddenStory','packageAttachments','packageValues',...(frozen ? ['contents','models','promptPresets','packages'] : [])]);
  if (p.chatId !== chatId) throw new HttpError(400,'Profile chat mismatch'); number(p.revision,'profile revision'); creative(p.creative); boolean(p.image);
  const attachments = archiveList(p.attachments).map(ref); if (new Set(attachments.map(r => r.id)).size !== attachments.length) throw new HttpError(400,'Duplicate attachment');
  const contents = attachments.map(r => product.get<Content>('content',r.id,r.revision)); const routes = record(p.routes); fields(routes,['main','translation','status','image']);
  const models: ProfileSnapshot['models'] = {};
  for (const role of ['main','translation','status','image'] as const) if (routes[role] !== null) { const r = ref(routes[role]); const model = product.get<ModelPreset>('model',r.id,r.revision); models[role] = {...model,connection:product.get<Connection>('connection',model.connectionId,model.connectionRevision)}; }
  const prompts = p.prompts === undefined ? undefined : promptRefs(product,p.prompts); if(p.promptControls!==undefined)promptControls(product,p.promptControls);if(p.hiddenStory!==undefined)validateHiddenStorySelection(product,p.hiddenStory);
  const promptPresets = prompts === undefined ? undefined : resolvedPrompts(product,prompts);
  const packageAttachments=p.packageAttachments===undefined?undefined:packageRefs(product,p.packageAttachments);
  if(p.packageValues!==undefined)packageControlValues(product,packageAttachments??[],p.packageValues);
  validateAttachmentRoles(product,attachments,packageAttachments);
  const packages=packageAttachments?.map(r=>product.get<Content>('content',r.id,r.revision).package!);
  if(frozen&&!isDeepStrictEqual(p.packages,packages))throw new HttpError(400,'Frozen package revision mismatch');
  if (frozen && !isDeepStrictEqual(p.promptPresets,promptPresets)) throw new HttpError(400,'Frozen prompt revision mismatch');
  if (frozen && (!isDeepStrictEqual(p.contents,contents) || !isDeepStrictEqual(p.models,models))) throw new HttpError(400,'Frozen profile revision mismatch');
  return p as ProfileSnapshot | ChatProfile;
}
/** Re-tokenize a stored translation before applying the same output validator. */
export function validateStoredChunk(plan: TranslationPlan, raw: unknown): TranslationResult {
  const value = record(raw); const chunk = plan.chunks.find(c => c.id === value.chunkId); if (!chunk) throw new HttpError(400,'Unknown translation chunk');
  const restored = structuredClone(value); const segments = archiveList(restored.segments,plan.blocks.length);
  for (const segment of segments) {
    const entry = record(segment); const anchors = archiveList(entry.anchors,plan.blocks.length); let cursor = 0; let tokenized = '';
    const translated = text(entry.text,'translated block',50000);
    for (const span of chunk.protectedSpans.filter(span => anchors.includes(span.anchor))) { const index = translated.indexOf(span.literal,cursor); if (index < 0) throw new HttpError(400,'Stored protected span missing'); tokenized += translated.slice(cursor,index) + span.token; cursor = index + span.literal.length; }
    entry.text = tokenized + translated.slice(cursor);
  }
  const validated = validateTranslationChunk(plan,chunk.id,restored); if (!isDeepStrictEqual(validated,value)) throw new HttpError(400,'Stored translation mismatch'); return validated;
}
function validateArchiveGraph(product: ProductStore) {
  for(const saved of product.all('prompt-combination')){const r=ref(saved.prompt);const preset=product.get<PromptPreset>('prompt-preset',r.id,r.revision);if(!preset.program)throw new HttpError(400,'Creative preset prompt missing controls');resolvePromptValues(preset.program,record(saved.values));}
  const db = product.db; const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const chats = new Map(rows('chats').map(row => [archiveId(row.id),row])); const sources = new Map(rows('sources').map(row => [archiveId(row.id),row]));
  const runs = new Map(rows('runs').map(row => [archiveId(row.id),row])); const branches = new Map(rows('branches').map(row => [archiveId(row.id),row])); const jobs = new Map(rows('jobs').map(row => [archiveId(row.id),row]));
  const sameChat = (id: unknown, chat: string, collection: Map<string,Row>) => { if (id !== null && (typeof id !== 'string' || collection.get(id)?.chat_id !== chat)) throw new HttpError(400,'Archive cross-chat or missing reference'); };
  const visited = new Set<string>();
  for (const source of sources.values()) {
    text(source.text,'source',2e6); if (createHash('sha256').update(source.text).digest('hex') !== source.hash) throw new HttpError(400,'Source hash mismatch');
    sameChat(source.parent_revision,source.chat_id,sources); sameChat(source.run_id,source.chat_id,runs);
    const run = runs.get(source.run_id)!; if (run.source_revision !== source.id || run.parent_revision !== source.parent_revision || run.status !== 'completed') throw new HttpError(400,'Source run mismatch');
    const path = new Set<string>(); let cursor: string | null = source.id;
    while (cursor && !visited.has(cursor)) { if (path.has(cursor)) throw new HttpError(400,'Source ancestry cycle'); path.add(cursor); cursor = sources.get(cursor)!.parent_revision; }
    for (const id of path) visited.add(id);
  }
  for(const source of sources.values()) {
    const edits=db.prepare('SELECT * FROM source_edits WHERE source_id=? ORDER BY revision').all(source.id) as Row[];
    for(const [index,edit] of edits.entries()){number(edit.revision,'source edit revision');text(edit.text,'source edit',2e6);text(edit.created_at,'edit timestamp',100);if(edit.revision!==index+1||createHash('sha256').update(edit.text).digest('hex')!==edit.hash)throw new HttpError(400,'Invalid source edit history');}
  }
  for (const chat of chats.values()) { text(chat.title,'chat title',200); number(chat.settings_revision,'settings revision'); archiveSettings(parse(chat.settings)); sameChat(chat.head_revision,chat.id,sources); const defaults = [...branches.values()].filter(b => b.chat_id === chat.id && b.is_default === 1); if (defaults.length !== 1 || defaults[0].head_revision !== chat.head_revision) throw new HttpError(400,'Default branch mismatch'); }
  for (const branch of branches.values()) { sameChat(branch.head_revision,branch.chat_id,sources); text(branch.title,'branch title',200); number(branch.revision,'branch revision'); if (![0,1].includes(branch.is_default)) throw new HttpError(400,'Invalid branch type'); }
  for (const row of rows('versions')) if (row.kind === 'model') { const model = record(parse(row.body)); const connection = product.get<Connection>('connection',model.connectionId,model.connectionRevision); validateModelGeneration(model,connection.protocol);
    if (model.source && (model.source.catalogUpdatedAt !== (connection.catalogUpdatedAt ?? null) || model.source.kind !== (connection.catalog.some(item => item.id === model.modelId) ? 'catalog' : 'manual'))) throw new HttpError(400,'Model source catalog mismatch');
  }
  for (const row of rows('profiles')) validateArchiveProfile(product,parse(row.body),row.chat_id);
  for (const row of rows('resources')) { const resource = record(parse(row.body)); if (resource.id !== row.id || resource.chatId !== row.chat_id) throw new HttpError(400,'Resource identity mismatch'); number(resource.revision,'resource revision'); choice(resource.kind,['lore','skill'],'resource kind'); text(resource.text,'resource text',String(resource.id).startsWith('package:')?1_000_000:100000,String(resource.id).startsWith('package:')); }
  for (const run of runs.values()) {
    sameChat(run.parent_revision,run.chat_id,sources); sameChat(run.branch_id,run.chat_id,branches); sameChat(run.source_revision,run.chat_id,sources);
    choice(run.status,['completed','failed','cancelled','interrupted','refused','partial'],'run status'); if ((run.status === 'completed') !== (run.source_revision !== null)) throw new HttpError(400,'Run completion mismatch');
    const snapshot = record(parse(run.snapshot)); if (snapshot.chatId !== run.chat_id || snapshot.parentRevision !== run.parent_revision || snapshot.request !== run.request || snapshot.branchId !== undefined && snapshot.branchId !== run.branch_id) throw new HttpError(400,'Run snapshot identity mismatch');
    if (snapshot.forkedFrom !== undefined) { const origin = record(snapshot.forkedFrom); fields(origin,['chatId','runId','sourceRevision']); archiveId(origin.chatId); archiveId(origin.runId); archiveId(origin.sourceRevision); }
    archiveSettings(snapshot.settings); number(snapshot.settingsRevision,'snapshot settings revision');
    if (!product.store.validateHistory(snapshot.history,run.parent_revision)) throw new HttpError(400,'Snapshot history differs from source ancestry');
    const resources = archiveList(snapshot.resources,10000); const ids = new Set<string>();
    for (const raw of resources) { const resource = record(raw); if (resource.chatId !== run.chat_id || ids.has(resource.id)) throw new HttpError(400,'Snapshot resource scope mismatch'); ids.add(archiveId(resource.id)); number(resource.revision,'resource revision'); choice(resource.kind,['lore','skill'],'resource kind'); text(resource.text,'resource text',String(resource.id).startsWith('package:')?1_000_000:100000,String(resource.id).startsWith('package:')); }
    validateNativeRunSnapshot(product.store,snapshot as RunSnapshot);
    validatePackageBehaviorRunSnapshot(product.store,snapshot as RunSnapshot);
    if (snapshot.profile) { const profile = validateArchiveProfile(product,snapshot.profile,run.chat_id,true) as ProfileSnapshot; if (!isDeepStrictEqual(resources,[...product.resources(run.chat_id,profile),...nativeResources(run.chat_id,snapshot.nativeBot)])) throw new HttpError(400,'Snapshot resource revision mismatch'); }
  }
  for (const job of jobs.values()) {
    sameChat(job.source_revision,job.chat_id,sources); const source = product.store.sourceAtHash(job.source_revision,job.source_hash); const jobInput = parse(job.input);
    if (jobInput && typeof jobInput === 'object' && !Array.isArray(jobInput) && (Object.hasOwn(jobInput,'promptSelection')||Object.hasOwn(jobInput,'translationModelSelection')||Object.hasOwn(jobInput,'promptControlSelection')) && job.kind !== 'translation') throw new HttpError(400,'Prompt selection requires a translation job');
    const snapshot = product.resolveJobPrompt(product.store.run(source.runId).snapshot,jobInput);
    if (job.source_hash !== source.hash) throw new HttpError(400,'Job source hash mismatch'); choice(job.kind,['translation','status','image'],'job kind'); choice(job.status,['completed','failed','partial','cancelled','interrupted','stale'],'job status'); number(job.generation,'job generation',0); number(job.revision,'job revision');
    const resultRow = db.prepare('SELECT * FROM job_results WHERE job_id=?').get(job.id) as Row | undefined; const result = resultRow ? record(parse(resultRow.result)) : null;
    if (result && (result.sourceRevision !== source.id || result.sourceHash !== source.hash || typeof result.mock !== 'boolean' || resultRow!.generation > job.generation)) throw new HttpError(400,'Job result dependency mismatch');
    if (job.status === 'completed' && !result) throw new HttpError(400,'Completed job result missing');
    if(result?.manual!==undefined && (job.kind!=='translation'||result.manual!==true))throw new HttpError(400,'Invalid authored marker');
    if(job.kind==='translation' && job.status==='completed')validateTranslationArtifact(product.store,product.store.job(job.id),source);
    const chunks = product.chunks(job.id);
    if (job.plan !== null) {
      if (job.kind !== 'translation') throw new HttpError(400,'Unexpected job plan');
      const plan = validateTranslationPlan(source,sourceTimeContext(snapshot,'translation'),parse(job.plan));
      if (chunks.length !== plan.chunks.length || chunks.some(c => !plan.chunks.some(p => p.id === c.id))) throw new HttpError(400,'Translation reservation mismatch');
      const completed: TranslationResult[] = [];
      for (const chunk of chunks) { choice(chunk.status,['queued','completed','failed','cancelled','interrupted'],'chunk status'); number(chunk.attempt,'chunk attempt',0); if (chunk.result) { const validated = validateStoredChunk(plan,chunk.result); if (validated.chunkId !== chunk.id) throw new HttpError(400,'Chunk identity mismatch'); if (chunk.status === 'completed') completed.push(validated); } else if (chunk.status === 'completed') throw new HttpError(400,'Completed chunk result missing'); }
      const combined = aggregateTranslation(plan,completed);
      if (job.status === 'completed' && (combined.status !== 'completed' || !isDeepStrictEqual(result?.segments,combined.segments))) throw new HttpError(400,'Completed translation coverage mismatch');
      if (result?.segments) { const storedSegments = archiveList(result.segments,plan.blocks.length); let cursor = 0; for (const segment of storedSegments) { const index = combined.segments.findIndex((candidate,index) => index >= cursor && isDeepStrictEqual(candidate,segment)); if (index < 0) throw new HttpError(400,'Translation result differs from stored chunks'); cursor = index+1; } }
      if (result) {
        const segments = archiveList(result.segments,plan.blocks.length); const anchors = new Set(segments.flatMap(segment => archiveList(record(segment).anchors,plan.blocks.length)));
        const included = plan.chunks.filter(chunk => chunk.anchors.every(anchor => anchors.has(anchor)));
        if (included.flatMap(chunk => chunk.anchors).length !== anchors.size || result.completedChunks !== included.length || result.totalChunks !== plan.chunks.length || result.text !== segments.map(segment => segment.text).join('\n\n')) throw new HttpError(400,'Translation summary coverage mismatch');
      }
    } else if (chunks.length) throw new HttpError(400,'Chunk plan missing');
    if (result && job.kind === 'image') {
      const assets = [...BUILTIN_ASSETS,...product.assets(job.chat_id).map(a => ({ref:a.id,revision:a.revision,hash:a.hash,url:a.url,alt:a.title,caption:a.description,actorId:a.actor,clothing:a.outfit,location:a.location,uses:a.allowedUse === 'both' ? ['profile' as const,'inline' as const] : [a.allowedUse]}))];
      const entries = archiveList(result.annotations,4).map(raw => { const entry = record(raw); fields(entry,['blockAnchor','assetRef','assetRevision','presentationIntent','caption']); const {caption:_caption,...annotation} = entry; return annotation; });
      validatePresentation(source,{sourceRevision:source.id,sourceHash:source.hash,entries},assets);
    }
    if (result && job.kind === 'status' && result.display) validateDisplayAnnotation(source,{sourceRevision:source.id,sourceHash:source.hash,kind:'display-only',entries:result.display});
  }
  for (const attempt of rows('attempts')) {
    sameChat(attempt.run_id,attempt.chat_id,runs); sameChat(attempt.job_id,attempt.chat_id,jobs); if ([attempt.run_id,attempt.job_id,attempt.story_job_id].filter(id=>id!==null).length!==1) throw new HttpError(400,'Attempt target mismatch');
    if(attempt.story_job_id!==null){const target=product.db.prepare('SELECT chat_id,kind FROM story_jobs WHERE id=?').get(attempt.story_job_id) as Row|undefined;if(!target||target.chat_id!==attempt.chat_id||target.kind!==attempt.role)throw new HttpError(400,'Story attempt target mismatch');}
    choice(attempt.role,['main','translation','status','image','state','memory'],'attempt role'); if (attempt.story_job_id===null && (attempt.run_id !== null ? attempt.role !== 'main' : jobs.get(attempt.job_id)?.kind !== attempt.role)) throw new HttpError(400,'Attempt role mismatch');
    const request = record(parse(attempt.request));
    if (attempt.status === 'mock') {
      fields(request,['mock','input']); const input = record(request.input);
      if (request.mock !== true || attempt.connection_id !== 'local-scripted' || attempt.model_id !== 'deterministic-fixture' || input.role !== (attempt.role === 'image' ? 'presentation' : attempt.role) || [attempt.input_tokens,attempt.output_tokens,attempt.cost_usd,attempt.raw_usage].some(value => value !== null)) throw new HttpError(400,'Mock attempt identity mismatch');
    } else if (request.connectionId !== attempt.connection_id || request.modelId !== attempt.model_id || request.role !== attempt.role) throw new HttpError(400,'Attempt identity mismatch');
  }
  validateRegistrationGraph(product);
}
