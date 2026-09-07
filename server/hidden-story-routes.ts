import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { HiddenStoryStore } from './hidden-story.js';
import { number } from './product-store.js';
export function hiddenStoryRoutes(app:FastifyInstance,store:Store,hooks:{publish:(chatId:string)=>void}){
  const hidden=new HiddenStoryStore(store.product);
  app.get('/api/hidden-story/modules',async()=>hidden.list());
  app.get<{Params:{id:string};Querystring:{revision?:string}}>('/api/hidden-story/modules/:id',async request=>hidden.get(request.params.id,request.query.revision===undefined?undefined:number(Number(request.query.revision),'hidden module revision')));
  app.post('/api/hidden-story/modules',async request=>hidden.import(request.body));
  app.put<{Params:{id:string}}>('/api/hidden-story/modules/:id',async request=>hidden.import(request.body,request.params.id));
  app.put<{Params:{id:string}}>('/api/chats/:id/hidden-story',async request=>{const profile=hidden.select(request.params.id,request.body);hooks.publish(request.params.id);return profile;});
}
