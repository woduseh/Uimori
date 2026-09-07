import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { record, fields, text, number } from './product-store.js';
import { behaviorDetail, performBehaviorAction } from './package-behavior-host.js';

export function packageBehaviorRoutes(app: FastifyInstance, store: Store) {
  app.get<{Params:{id:string};Querystring:{branchId?:string}}>('/api/chats/:id/package-behaviors',async request=>behaviorDetail(store,request.params.id,request.query.branchId));
  for(const reset of [false,true])app.post<{Params:{id:string;instanceId:string}}>(`/api/chats/:id/package-behaviors/:instanceId/${reset?'reset':'actions'}`,async request=>{
    const b=record(request.body);fields(b,['branchId','expectedStateRevision','expectedSourceHash','idempotencyKey',...(reset?[]:['actionId','input'])]);
    const command={expectedStateRevision:number(b.expectedStateRevision,'state revision',0),expectedSourceHash:b.expectedSourceHash===null?null:text(b.expectedSourceHash,'source hash',200),idempotencyKey:text(b.idempotencyKey,'idempotency key',200),...(!reset?{actionId:text(b.actionId,'action ID',100),input:b.input}: {})};
    return performBehaviorAction(store,request.params.id,b.branchId===undefined?undefined:text(b.branchId,'branch ID',200),request.params.instanceId,command,reset);
  });
}
