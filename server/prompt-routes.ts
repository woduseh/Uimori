import type { FastifyInstance } from 'fastify';
import { defaultProfile } from '../core/product.js';
import { compilePromptProgram, validatePromptProgram } from '../core/prompt-program.js';
import { planNativeMessages } from '../core/provider-messages.js';
import { captureLogicalHistory, compileSnapshotPrompt, promptContext } from './prompt-snapshot.js';
import { nativeResources } from '../core/native-context.js';
import { HiddenStoryStore } from './hidden-story.js';
import { fields, record, text } from './product-store.js';
import { HttpError, type Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainProviderRequest, encodeMainPreview } from './main-request.js';

/** A read-only preview, including unsaved draft blocks. No provider call or Run is created. */
export function promptRoutes(app:FastifyInstance,store:Store){
  app.post<{Params:{id:string}}>('/api/chats/:id/prompt-preview',{bodyLimit:2_000_000},async request=>{
    const b=record(request.body);fields(b,['program','request','values','branchId','role']);
    const program=validatePromptProgram(b.program);const role=b.role??'main';if(!['main','translation'].includes(role))throw new HttpError(400,'Invalid prompt role');
    const chat=store.chat(request.params.id);const branch=store.product.branch(chat.id,b.branchId===undefined?undefined:text(b.branchId,'branch ID',100));
    const profile=store.product.snapshot(chat.id)??{...defaultProfile(chat.id),contents:[],models:{}};
    if(role==='main'){
      const selected=profile.promptPresets?.main;
      profile.promptPresets={...profile.promptPresets,main:{id:selected?.id??'preview-draft',revision:selected?.revision??1,title:selected?.title??'Preview draft',role:'main',text:selected?.text??'',program}};
    }
    let snapshot:RunSnapshot={chatId:chat.id,parentRevision:branch.headRevision,settingsRevision:chat.settingsRevision,settings:chat.settings,request:text(b.request,'preview request',500_000),history:store.history(branch.headRevision),resources:store.product.resources(chat.id,profile),profile,branchId:branch.id};
    const nativeBot=store.native.snapshot(chat.id,branch.id);if(nativeBot){snapshot.nativeBot=nativeBot;snapshot.resources.push(...nativeResources(chat.id,nativeBot));}
    if(role==='main')snapshot.hiddenStory=new HiddenStoryStore(store.product).freeze(profile.hiddenStory,{seed:`preview:${branch.id}:${snapshot.request}`,userLabel:profile.contents.find(c=>c.kind==='persona')?.title??'User'});
    if(nativeBot&&snapshot.hiddenStory?.config.contentPolicy==='general-fiction')throw new HttpError(400,'This native bot requires the nonsexual Hidden Story policy');
    snapshot=store.story.prepareRunInTransaction(snapshot);snapshot.logicalHistory=captureLogicalHistory(store,snapshot);
    const context=promptContext(snapshot);if(role==='translation'){context.history=[context.history.at(-1)!];context.slots.source=branch.headRevision?store.source(branch.headRevision).text:'';}
    const values=b.values!==undefined?record(b.values):undefined;
    let compilation=role==='main'&&!snapshot.story?.waiting?compileSnapshotPrompt(snapshot,program,values).promptCompilation!:compilePromptProgram(program,{...context,...(values?{values}:{})});
    const target=profile.models[role as 'main'|'translation'];let provider=null;let error:string|undefined;
    if(target)try{
      if(role==='main'&&!snapshot.story?.waiting){
        const built=buildMainProviderRequest({...snapshot,promptCompilation:compilation});compilation=built.snapshot.promptCompilation!;provider=encodeMainPreview(built.request,target);
      }else{
        const plan=planNativeMessages({role:role as 'main'|'translation',modelId:target.modelId,stable:{contract:'',tools:[]},input:{task:snapshot.request,controls:{}},prompt:{compilerVersion:compilation.compilerVersion,messages:compilation.messages,cachePlan:compilation.cachePlan,values:compilation.values}},target.connection.protocol);
        provider={protocol:target.connection.protocol,modelId:target.modelId,kind:'mapping-only' as const,...plan};
      }
    }catch(caught){error=(caught as Error).message;}
    return{compilation,provider,...(error?{error}:{}),...(snapshot.story?.waiting?{waitingForState:true}:{}),scope:'preview-only-no-provider-call'};
  });
}
