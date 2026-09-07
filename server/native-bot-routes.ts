import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { NativeBotStore } from './native-bot.js';
import { fields, record } from './product-store.js';
export function registerNativeBotRoutes(app:FastifyInstance,store:Store) {
  const native=new NativeBotStore(store);
  app.get('/api/native-bots',async()=>native.list());
  app.post('/api/native-bots',async request=>native.importPackage(request.body));
  app.get<{Params:{id:string};Querystring:{branchId?:string}}>('/api/chats/:id/native-bot',async request=>{fields(record(request.query),['branchId']);return native.snapshot(request.params.id,request.query.branchId);});
  app.put<{Params:{id:string}}>('/api/chats/:id/native-bot',async request=>native.attach(request.params.id,request.body));
  app.post<{Params:{id:string}}>('/api/chats/:id/native-bot/commands',async request=>native.command(request.params.id,request.body));
}
