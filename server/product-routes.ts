import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HttpError, type Store } from './store.js';
import { fields, record, text, number } from './product-store.js';
import type { Connection } from '../core/product.js';
import { parseCatalog, validateConnection } from '../core/transport.js';
import { BUILTIN_ASSETS, builtinAssetSvg } from '../core/auxiliary.js';

export function productRoutes(app: FastifyInstance, store: Store, options: {accessToken?:string;approvedOrigins:readonly string[];publish:(chatId:string)=>void;onAuthChanged?:()=>void}) {
  const product = store.product;
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
  app.get('/api/library',async () => product.library());
  app.post('/api/content',async request => product.content(request.body));
  app.put<{Params:{id:string}}>('/api/content/:id',async request => product.content(request.body,request.params.id));
  app.post('/api/creative-presets',async request => product.preset(request.body));
  app.post('/api/connections',async request => product.connection(request.body));
  app.put<{Params:{id:string}}>('/api/connections/:id',async request => product.connection(request.body,request.params.id));
  app.post('/api/model-presets',async request => product.model(request.body));
  app.put<{Params:{id:string}}>('/api/model-presets/:id',async request => product.model(request.body,request.params.id));
  app.get<{Params:{kind:string;id:string;revision:string}}>('/api/revisions/:kind/:id/:revision',async request => { if (!['content','preset','connection','model'].includes(request.params.kind)) throw new HttpError(404,'Revision kind not found'); return product.get(request.params.kind,request.params.id,number(Number(request.params.revision),'revision')); });
  app.post<{Params:{id:string}}>('/api/connections/:id/catalog',async request => {
    const b = record(request.body ?? {}); fields(b,[]); const previous = product.get<Connection>('connection',request.params.id);
    let error: string|null = null; let catalog = previous.catalog;
    try {
      product.authorize(previous);
      const c = validateConnection({id:previous.id,protocol:previous.protocol,endpoint:previous.endpoint,...(previous.credentialEnv ? {credentialEnv:previous.credentialEnv} : {})},options.approvedOrigins);
      const credential = c.credentialEnv ? process.env[c.credentialEnv] : undefined;
      if (c.credentialEnv && (!credential || /[\r\n]/.test(credential))) throw new Error('Credential unavailable');
      const response = await fetch(new URL('models',c.endpoint),{signal:AbortSignal.timeout(5000),redirect:'error',headers:credential ? {Authorization:`Bearer ${credential}`} : {}});
      if (!response.ok || !response.body) throw new Error('Catalog unavailable');
      const reader = response.body.getReader(); const parts:Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1000000) throw new Error('Catalog too large'); parts.push(next.value); } } finally { await reader.cancel().catch(() => {}); }
      catalog = parseCatalog(JSON.parse(Buffer.concat(parts).toString('utf8'))).map(m => ({id:m.id,name:m.label,capabilities:m.capabilities,priceRevision:m.pricing.revision}));
    } catch { error = 'CATALOG_UNAVAILABLE'; }
    return product.save('connection',{...previous,catalog,catalogError:error},previous.id,previous.revision);
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
