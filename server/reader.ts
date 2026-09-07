import { BUILTIN_ASSETS } from '../core/auxiliary.js';
import { latestTranslation, validateTranslationArtifact } from './source-editing.js';
import { HttpError, type Store } from './store.js';

/** Read projection only. Frozen execution records remain available through detail/run APIs. */
export function readerDetail(store: Store, id: string, query: Record<string, string | undefined>) {
  const chat = store.chat(id);
  const branch = store.product.branch(id, query.branch || undefined);
  const rows = store.db.prepare('SELECT id,parent_revision AS parentRevision FROM sources WHERE chat_id=?').all(id) as {id:string;parentRevision:string|null}[];
  const byId = new Map(rows.map(row => [row.id,row])); const chain: string[] = []; const seen = new Set<string>();
  let head = branch.headRevision;
  while (head && !seen.has(head)) { seen.add(head); const row = byId.get(head); if (!row) break; chain.unshift(head); head = row.parentRevision; }
  const limit = 5;
  let start = query.source ? chain.indexOf(query.source) : 0;
  if (start < 0) throw new HttpError(404,'Source is not in this branch');
  start = Math.floor(start/limit)*limit;
  const order = chain.slice(start,start+limit);
  const cursor = Number((store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE chat_id=?').get(id) as {seq:number}).seq);
  const since = query.since === undefined ? null : Number(query.since);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0 || since > cursor)) throw new HttpError(400,'Invalid reader cursor');
  const events = since === null ? null : store.events(id,since) as {kind:string;entityId:string}[];
  const changed = new Set<string>();
  for (const event of events ?? []) {
    if (event.kind.startsWith('source.')) changed.add(event.entityId);
    if (event.kind.startsWith('job.')) {
      const job = store.db.prepare('SELECT source_revision FROM jobs WHERE id=? AND chat_id=?').get(event.entityId,id) as {source_revision:string}|undefined;
      if (job) changed.add(job.source_revision);
    }
  }
  // The caller supplies only IDs from its current page; identity is scoped again by order.
  const known = new Set((query.known ?? '').split(','));
  const sources = order.filter(sourceId => !events || !known.has(sourceId) || changed.has(sourceId)).map(sourceId => store.source(sourceId));
  const jobs = sources.flatMap(source => {
    const ids = store.db.prepare('SELECT id FROM jobs WHERE source_revision=? ORDER BY created_at,id').all(source.id) as {id:string}[];
    return ids.map(row => store.job(row.id)).filter(job => {
      if (job.sourceHash !== source.hash) return false;
      if (job.kind !== 'translation') return true;
      if (latestTranslation(store,source.id)?.id !== job.id) return false;
      if (job.status === 'completed') { try { validateTranslationArtifact(store,job,source); } catch { return false; } }
      return true;
    }).map(({input: _input,chunks,...job}) => ({...job,chunks:chunks?.map(({id,status,attempt,error})=>({id,status,attempt,error}))}));
  });
  // JSON projection happens in SQLite: do not parse quadratic history or diagnostic bodies.
  const runs = (store.db.prepare(`SELECT id,chat_id AS chatId,parent_revision AS parentRevision,status,request,source_revision AS sourceRevision,error,usage,partial_text AS partialText,issue,
    json_extract(snapshot,'$.settingsRevision') AS settingsRevision,json_extract(snapshot,'$.profile.models.main.title') AS modelTitle,json_extract(snapshot,'$.hiddenStory.config') AS hiddenConfig,COALESCE(json_array_length(snapshot,'$.profile.packageAttachments'),0)>0 AS hasPackages,
    json_object('branchId',branch_id,'candidateOf',json_extract(snapshot,'$.candidateOf'),'forkedFrom',json_extract(snapshot,'$.forkedFrom')) AS snapshot
    FROM runs WHERE chat_id=? ORDER BY created_at,id`).all(id) as Record<string,any>[]).map(row => ({...row,snapshot:JSON.parse(row.snapshot),hiddenConfig:row.hiddenConfig?JSON.parse(row.hiddenConfig):undefined,usage:row.usage ? JSON.parse(row.usage) : {modelCalls:0,inputTokens:null,outputTokens:null,costUsd:null}}));
  const activeJobs = Number((store.db.prepare(`SELECT COUNT(*) AS count FROM jobs j JOIN sources s ON s.id=j.source_revision WHERE j.chat_id=? AND j.status IN ('queued','running') AND j.source_hash=COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)`).get(id) as {count:number}).count);
  const assetsChanged = !events || events.some(event => event.kind.startsWith('asset.'));
  return {chat,runs,sources,jobs,profile:store.product.profile(id),branches:store.product.branches(id),
    ...(assetsChanged ? {assets:[...store.product.assets(id),...BUILTIN_ASSETS.map(a => ({id:a.ref,chatId:id,revision:a.revision,title:a.alt,mime:'image/svg+xml',hash:a.hash,description:a.caption,actor:a.actorId??'',outfit:a.clothing??'',location:a.location??'',allowedUse:a.uses.length===2?'both':a.uses[0],url:a.url}))]} : {}),
    reader:{nativeBotAttached:!!store.db.prepare('SELECT 1 FROM native_chat_settings WHERE chat_id=? AND branch_id=?').get(id,branch.id),headSourceHash:branch.headRevision?(store.db.prepare('SELECT COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AS hash FROM sources s WHERE s.id=?').get(branch.headRevision) as {hash:string}|undefined)?.hash??null:null,activeJobs,cursor,order,start,total:chain.length,previous:start>0?chain[Math.max(0,start-limit)]:null,next:chain[start+limit]??null,latest:chain[Math.max(0,Math.floor((chain.length-1)/limit)*limit)]??null,projection:true as const}};
}
