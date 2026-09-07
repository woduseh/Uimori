import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError, type Store } from './store.js';
import { forkChat } from './chat-fork.js';
import { fields, record, text, number } from './product-store.js';
import { validateVertexEndpoint, VERTEX_GEMINI_MODEL_ID, type Connection } from '../core/product.js';
import { parseCatalog, validateConnection } from '../core/transport.js';
import { BUILTIN_ASSETS, builtinAssetSvg } from '../core/auxiliary.js';
import { promptRoutes } from './prompt-routes.js';
import { readiness, managementImpact } from './provider-management.js';
import { PROVIDER_DEFINITIONS } from '../core/provider-definitions.js';

export function productRoutes(app: FastifyInstance, store: Store, options: {accessToken?:string;approvedOrigins:readonly string[];publish:(chatId:string)=>void;onAuthChanged?:()=>void}) {
  const product = store.product;
  promptRoutes(app,store);
  app.post<{Params:{id:string}}>('/api/chats/:id/fork',async request => { const chat = forkChat(store,request.params.id,request.body); options.publish(chat.id); return chat; });
  const digest = (v: string) => createHash('sha256').update(v).digest();
  const sessions = new Map<string,number>();
  const authenticated = (cookie?:string) => { if (!options.accessToken) return true; const token = cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('nr_session='))?.slice(11); if (!token) return false; const key = digest(token).toString('hex'); const expiry = sessions.get(key); if (!expiry || expiry < Date.now()) { sessions.delete(key); return false; } return true; };
  app.addHook('onRequest',async request => {
    if (request.url.split('?')[0].startsWith('/api/') && request.url.split('?')[0] !== '/api/session' && !authenticated(request.headers.cookie)) throw new HttpError(401,'Authentication required');
  });
  app.get('/api/session',async request => ({required:!!options.accessToken,authenticated:authenticated(request.headers.cookie)}));
  app.post('/api/session',async (request,reply) => {
    const b = record(request.body); fields(b,['token']); const value = text(b.token,'token',1000);
    if (options.accessToken && !timingSafeEqual(digest(value),digest(options.accessToken))) throw new HttpError(401,'Invalid access token');
    const token = randomBytes(32).toString('hex'); sessions.set(digest(token).toString('hex'),Date.now()+12*60*60*1000);
    reply.header('Set-Cookie',`nr_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`); return {required:!!options.accessToken,authenticated:true};
  });
  app.delete('/api/session',async (request,reply) => { const token = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('nr_session='))?.slice(11); if (token) sessions.delete(digest(token).toString('hex')); options.onAuthChanged?.(); reply.header('Set-Cookie','nr_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return {required:!!options.accessToken,authenticated:!options.accessToken}; });
  app.get<{Querystring:{view?:string}}>('/api/library',async request => {
    if (request.query.view !== undefined && request.query.view !== 'summary') throw new HttpError(400,'Invalid library view');
    return product.library(request.query.view === 'summary');
  });
  app.get('/api/provider-management/definitions',async () => PROVIDER_DEFINITIONS);
  app.get<{Params:{id:string}}>('/api/provider-management/connections/:id/readiness',async request=>readiness(product,product.get<Connection>('connection',request.params.id),options.approvedOrigins));
  app.get<{Params:{kind:string;id:string}}>('/api/provider-management/:kind/:id/impact',async request=>{
    if(request.params.kind!=='connection'&&request.params.kind!=='model')throw new HttpError(404,'Unsupported management kind');
    return managementImpact(product,request.params.kind,request.params.id);
  });
  app.post('/api/content',async request => product.content(request.body));
  app.put<{Params:{id:string}}>('/api/content/:id',async request => product.content(request.body,request.params.id));
  app.post('/api/creative-presets',async request => product.preset(request.body));
  app.post('/api/prompt-presets',async request => product.promptPreset(request.body));
  app.put<{Params:{id:string}}>('/api/prompt-presets/:id',async request => product.promptPreset(request.body,request.params.id));
  app.post('/api/connections',async request => product.connection(request.body));
  app.put<{Params:{id:string}}>('/api/connections/:id',async request => product.connection(request.body,request.params.id));
  app.post('/api/model-presets',async request => product.model(request.body));
  app.put<{Params:{id:string}}>('/api/model-presets/:id',async request => product.model(request.body,request.params.id));
  app.get<{Params:{kind:string;id:string;revision:string}}>('/api/revisions/:kind/:id/:revision',async request => { if (!['content','preset','prompt-preset','connection','model'].includes(request.params.kind)) throw new HttpError(404,'Revision kind not found'); return product.get(request.params.kind,request.params.id,number(Number(request.params.revision),'revision')); });
  app.post<{Params:{id:string}}>('/api/connections/:id/catalog',async request => {
    const b = record(request.body ?? {}); fields(b,[]); const previous = product.get<Connection>('connection',request.params.id);
    let error: string|null = null; let catalog = previous.catalog;
    try {
      if (previous.protocol === 'vertex-gemini-v1') {
        // This is the adapter's local support list, not a provider availability probe.
        validateVertexEndpoint(previous.endpoint);
        catalog = [{id:VERTEX_GEMINI_MODEL_ID,name:'Gemini 3.8 Flash',capabilities:{tools:true,structuredOutput:null},priceRevision:null}];
      } else {
        product.authorize(previous);
        const c = validateConnection({id:previous.id,protocol:previous.protocol,endpoint:previous.endpoint,...(previous.credentialEnv ? {credentialEnv:previous.credentialEnv} : {})},options.approvedOrigins);
        const credential = c.credentialEnv ? process.env[c.credentialEnv] : undefined;
        if ((c.credentialEnv || ['openai-responses-v1','sol-responses-v1','anthropic-messages-v1'].includes(c.protocol)) && (!credential || /[\r\n]/.test(credential))) throw new Error('Credential unavailable');
        const headers: Record<string,string> = {Accept:'application/json'};
        if (c.protocol === 'anthropic-messages-v1') { headers['anthropic-version'] = '2023-06-01'; headers['x-api-key'] = credential!; }
        else if (credential) headers.Authorization = 'Bearer ' + credential;
        const url = c.protocol === 'fixture-sse-v1' ? new URL('models',c.endpoint) : new URL(c.endpoint.replace(/\/$/u,'') + '/models');
        if (c.protocol === 'anthropic-messages-v1') url.searchParams.set('limit','1000');
        const signal = AbortSignal.timeout(5000); const collected: Connection['catalog'] = []; const ids = new Set<string>(); let totalSize = 0;
        for (let page = 0; page < 5; page++) {
          product.authorize(previous);
          const response = await fetch(url,{method:'GET',signal,redirect:'error',headers});
          if (!response.ok || !response.body) throw new Error('Catalog unavailable');
          const reader = response.body.getReader(); const parts:Uint8Array[] = [];
          const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort',abort,{once:true});
          try {
            if (signal.aborted) throw new Error('Catalog timeout');
            while (true) { const next = await reader.read(); if (signal.aborted) throw new Error('Catalog timeout'); if (next.done) break; totalSize += next.value.length; if (totalSize > 1000000) throw new Error('Catalog too large'); parts.push(next.value); }
          } finally { signal.removeEventListener('abort',abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
          const body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
          if (c.protocol === 'fixture-sse-v1') { collected.push(...parseCatalog(body).map(m => ({id:m.id,name:m.label,capabilities:m.capabilities,priceRevision:m.pricing.revision}))); break; }
          const payload = record(body);
          if (!Array.isArray(payload.data) || collected.length + payload.data.length > 5000) throw new Error('Invalid model catalog');
          for (const item of payload.data) {
            const model = record(item); const id = text(model.id,'model ID',300); const name = text(model.display_name ?? model.name ?? id,'model name',400);
            if (ids.has(id)) throw new Error('Duplicate model ID'); ids.add(id);
            collected.push({id,name,capabilities:{tools:null,structuredOutput:null},priceRevision:null});
          }
          if (c.protocol !== 'anthropic-messages-v1' || payload.has_more === false || payload.has_more === undefined) break;
          if (payload.has_more !== true || payload.data.length === 0 || page === 4) throw new Error('Incomplete model catalog');
          const cursor = text(payload.last_id,'model cursor',300); if (cursor !== payload.data.at(-1).id) throw new Error('Invalid model cursor');
          url.searchParams.set('after_id',cursor);
        }
        catalog = collected;
      }
    } catch { error = 'CATALOG_UNAVAILABLE'; }
    return product.save('connection',{...previous,catalog,catalogError:error,catalogUpdatedAt:error?previous.catalogUpdatedAt??null:new Date().toISOString()},previous.id,previous.revision);
  });
  app.get<{Params:{id:string}}>('/api/chats/:id/profile',async request => product.profile(request.params.id));
  app.put<{Params:{id:string}}>('/api/chats/:id/profile',async request => { const p = product.updateProfile(request.params.id,request.body); options.publish(p.chatId); return p; });
  app.post<{Params:{id:string}}>('/api/chats/:id/preset',async request => { const p = product.applyPreset(request.params.id,request.body); options.publish(p.chatId); return p; });
  app.post<{Params:{id:string}}>('/api/chats/:id/branches',async request => { const branch = product.createBranch(request.params.id,request.body); options.publish(branch.chatId); return branch; });
  app.post<{Params:{id:string}}>('/api/runs/:id/issue',async request => { const b = record(request.body); fields(b,['note']); const run = store.run(request.params.id); store.db.prepare('UPDATE runs SET issue=? WHERE id=?').run(text(b.note,'issue note',4000),run.id); store.event(run.chatId,'run.issue',run.id); options.publish(run.chatId); return store.run(run.id); });
  app.post<{Params:{id:string}}>('/api/chats/:id/assets',async request => { const asset = product.createAsset(request.params.id,request.body); store.event(asset.chatId,'asset.created',asset.id); options.publish(asset.chatId); return asset; });
  app.get<{Params:{id:string}}>('/api/assets/:id',async (request,reply) => { const svg = builtinAssetSvg(request.params.id); if (svg) return reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").type('image/svg+xml').send(svg); const a = product.asset(request.params.id); return reply.header('X-Content-Type-Options','nosniff').header('Cache-Control','private, max-age=86400').type(a.asset.mime).send(a.bytes); });
  app.get<{Params:{id:string}}>('/api/builtin-assets/:id',async (request,reply) => { const asset = BUILTIN_ASSETS.find(a => a.ref === request.params.id); const svg = asset && builtinAssetSvg(asset.ref); if (!svg) throw new HttpError(404,'Asset not found'); return reply.header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; sandbox").type('image/svg+xml').send(svg); });
  app.get('/api/export',async (_request,reply) => reply.header('Content-Disposition','attachment; filename="narrative-archive.json"').send(product.export()));
  app.get('/api/backup',async (_request,reply) => reply.header('Content-Disposition','attachment; filename="narrative-backup.sqlite"').type('application/vnd.sqlite3').send(product.backup()));
  app.post('/api/import',{bodyLimit:64*1024*1024},async request => { const b = record(request.body); fields(b,['archive']); return product.import(b.archive); });
  return {authenticated};
}
