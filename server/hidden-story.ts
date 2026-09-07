import { createHash } from 'node:crypto';
import { validateHiddenStoryConfig } from '../core/hidden-story.js';
import { freezeHiddenStory, validateHiddenConversion, type HiddenStoryNativePackage, type HiddenStorySelection } from '../core/hidden-story-package.js';
import { fields, record, text, number, type ProductStore } from './product-store.js';
import { HttpError } from './store.js';

export function validateHiddenStorySelection(product: ProductStore, value: unknown): HiddenStorySelection {
  const b=record(value);fields(b,['module','config','insertion']);
  if(b.insertion!==undefined&&!['before-current','before-history'].includes(b.insertion))throw new HttpError(400,'Invalid hidden module insertion');
  const r=b.module===null?null:record(b.module);if(r)fields(r,['id','revision']);
  const module=r?{id:text(r.id,'hidden module ID',100),revision:number(r.revision,'hidden module revision')}:null;
  if(module)product.get('hidden-story',module.id,module.revision);
  return {module,config:validateHiddenStoryConfig(b.config),...(b.insertion?{insertion:b.insertion}:{})};
}
export class HiddenStoryStore {
  constructor(readonly product:ProductStore){}
  list():HiddenStoryNativePackage[]{return this.product.all('hidden-story');}
  get(id:string,revision?:number):HiddenStoryNativePackage{return this.product.get('hidden-story',id,revision);}
  import(value:unknown,id?:string):HiddenStoryNativePackage {
    const b=record(value);fields(b,['title','conversion','expectedRevision']);
    const conversion=validateHiddenConversion(b.conversion),title=text(b.title,'hidden module title',200);
    const packageHash=createHash('sha256').update(JSON.stringify(conversion)).digest('hex');
    return this.product.save('hidden-story',{...conversion,title,packageHash},id,id?number(b.expectedRevision,'hidden module revision'):undefined) as HiddenStoryNativePackage;
  }
  select(chatId:string,value:unknown){
    const b=record(value);fields(b,['expectedRevision','selection']);
    const selection=validateHiddenStorySelection(this.product,b.selection),profile=this.product.profile(chatId);
    const {chatId:_chatId,revision:_revision,...rest}=profile;
    return this.product.updateProfile(chatId,{...rest,expectedRevision:number(b.expectedRevision,'profile revision'),hiddenStory:selection});
  }
  freeze(selection:HiddenStorySelection|undefined,context:{seed:string;userLabel:string}){
    if(!selection?.module)return undefined;
    const selected=validateHiddenStorySelection(this.product,selection);
    return freezeHiddenStory(this.get(selected.module!.id,selected.module!.revision),selected,context);
  }
}
