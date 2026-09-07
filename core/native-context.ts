import type { NativeBotSnapshot } from './native-bot.js';
import type { Resource } from './types.js';

export function nativeResources(chatId:string,native:NativeBotSnapshot|undefined):Resource[]{
  if(!native)return[];
  const prefix=`native:${native.package.id}:`;
  return native.package.lore.filter(item=>item.kind==='entry').map(item=>({id:prefix+item.id,chatId,revision:native.package.revision,kind:'lore',sourceKind:'lore',title:item.title,description:`Native lore entry · ${native.package.lore.find(group=>group.id===item.groupId)?.title??''}`,text:item.text,loading:item.loading,relatedIds:item.relatedIds.map(id=>prefix+id)}));
}
export function nativeInstructions(native:NativeBotSnapshot|undefined):string{
  if(!native)return'';
  return `${native.package.instructions}\nUser-selected native controls: ${JSON.stringify(native.state)}\nThese controls belong to this source and branch. Interpret semantic state changes only through the auxiliary state job.`;
}
