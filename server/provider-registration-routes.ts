import type { FastifyInstance } from 'fastify';
import type { Connection, ModelPreset, VertexRequestTier } from '../core/product.js';
import { PROVIDER_DEFINITIONS } from '../core/provider-definitions.js';
import { registrationJson, REGISTRATION_LIMITS } from '../core/provider-registration.js';
import { fields, record } from './product-store.js';
import type { Store } from './store.js';
import { HttpError } from './store.js';
import { RegistrationStore } from './provider-registration-store.js';
import { runRegistrationAgent } from './provider-registration-agent.js';

export function registrationRoutes(app:FastifyInstance,store:Store,options:{
  executeCodex?: import('../core/transport.js').ProviderExecutionOptions['executeCodex'];
  resolveCredential?: import('../core/transport.js').ProviderExecutionOptions['resolveCredential'];
  approvedOrigins:readonly string[];signal:AbortSignal;vertexRequestTier?:VertexRequestTier;
  track:(work:Promise<void>)=>void;authenticated:(cookie?:string)=>boolean;
}) {
  const journal=new RegistrationStore(store.product);journal.recover();
  const controllers=new Map<string,AbortController>();
  app.post('/api/provider-management/registrations',async request=>{
    const admission=journal.create(request.body);
    if(admission.created) {
      const {run,target}=admission,controller=new AbortController();controllers.set(run.id,controller);
      const signal=AbortSignal.any([controller.signal,options.signal]);
      // Configuration metadata is separate from the user's stories, credentials and custom endpoint authority.
      const context=registrationJson({definitions:PROVIDER_DEFINITIONS,
        connections:(store.product.all('connection') as Connection[]).slice(0,100).map(({id,revision,title,protocol})=>({id,revision,title,protocol})),
        models:(store.product.all('model') as ModelPreset[]).slice(0,100).map(({id,revision,title,modelId})=>({id,revision,title,modelId})),
      });
      options.track((async()=>{
        try {
          const result=await runRegistrationAgent(target,run.request,{
            approvedOrigins:options.approvedOrigins,signal,timeoutMs:REGISTRATION_LIMITS.timeoutMs,vertexRequestTier:options.vertexRequestTier,context,resolveCredential:options.resolveCredential,executeCodex:options.executeCodex,
            authorize:connection=>{
              if(!options.authenticated(request.headers.cookie)||signal.aborted)throw new HttpError(403,'Registration session no longer authorized');
              const current=store.product.get<ModelPreset>('model',target.id);if(current.enabled===false)throw new HttpError(403,'Registration assistant model disabled');
              return store.product.authorize(connection);
            },
            onAttemptStart:wire=>journal.startAttempt(run.id,wire),
            onAttemptFinish:(attempt,response)=>journal.finishAttempt(run.id,attempt,response),
            onProposal:value=>value,
          });
          journal.finish(run.id,result.status,result.proposal,result.error);
        } catch(error) {
          // Validation failures are safe codes. Provider text and arbitrary exception messages are never retained.
          journal.finish(run.id,signal.aborted?'cancelled':'failed',undefined,error instanceof HttpError&&error.statusCode===409?'PROPOSAL_STALE':'REGISTRATION_PROPOSAL_INVALID');
        } finally {controllers.delete(run.id);}
      })());
    }
    return journal.view(admission.run.id);
  });
  app.get<{Params:{key:string}}>('/api/provider-management/registrations/by-key/:key',async request=>journal.byKey(request.params.key));
  app.get<{Params:{id:string}}>('/api/provider-management/registrations/:id',async request=>journal.view(request.params.id));
  app.post<{Params:{id:string}}>('/api/provider-management/registrations/:id/cancel',async request=>{
    fields(record(request.body??{}),[]);journal.get(request.params.id);controllers.get(request.params.id)?.abort();
    return journal.view(request.params.id);
  });
  app.post<{Params:{id:string}}>('/api/provider-management/registrations/:id/apply',async request=>{
    journal.apply(request.params.id,request.body);return journal.view(request.params.id);
  });
}
