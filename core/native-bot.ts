import type { StateModule } from './state.js';
import { validateStateModule } from './state.js';

export type NativeLanguage = 'en' | 'kr' | 'jp';
export type NativeVolume = 'standard' | 'long' | 'extra';
export type NativeAxis = 'affection' | 'trust' | 'independence';
export type NativeLocalized = Record<NativeLanguage, string>;
export type NativeScene = { id: string; title: NativeLocalized; request: NativeLocalized; assetId: string };
export type NativeAction = NativeScene & { requires: Partial<Record<NativeAxis, number>> };
export type NativeLore = { id: string; kind: 'group' | 'entry'; groupId: string | null; relatedIds: string[]; title: string; text: string; loading: 'pinned' | 'discoverable' };
export type NativeAsset = { id: string; path: string; kind: 'synthetic-symbol'; symbol: string; color: string; actor: string; outfit: string; emotion: string; use: 'icon' | 'scene' };
export type NativeBotPackage = {
  schemaVersion: 1; id: string; revision: number; title: string;
  provenance: { label: string; mode: 'nonsexual-adaptation' | 'synthetic'; excluded: string[] };
  instructions: string; lore: NativeLore[];
  stateModule: StateModule;
  scenes: NativeScene[]; actions: NativeAction[];
  assets: NativeAsset[];
};
export type NativeBotState = { affection: number; trust: number; independence: number; language: NativeLanguage; volume: NativeVolume; sceneId: string | null };
export type NativeCommandInput = { kind: 'set-stat'; field: NativeAxis; value: number } | { kind: 'language'; value: NativeLanguage } | { kind: 'volume'; value: NativeVolume } | { kind: 'scene' | 'action'; id: string } | { kind: 'back' | 'clear-pending' } | { kind: 'time-skip'; text: string };
export type NativePending = { commandId: string; request: string; label: string };
export type NativeBotSnapshot = { package: NativeBotPackage; revision: number; state: NativeBotState; pending: NativePending | null; branchId: string; sourceRevision: string | null; sourceHash: string | null; stateConfigRevision?: number };
const axes: NativeAxis[] = ['affection', 'trust', 'independence'];
function bad(message: string): never { throw new Error(`NATIVE_${message}`); }
function obj(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad('OBJECT'); return value as Record<string, any>; }
function str(value: unknown, max=10000): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) bad('TEXT'); }
function exact(value: Record<string, any>, keys: string[]) { if (Object.keys(value).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(value,key))) bad('FIELDS'); }
function ident(value: unknown): asserts value is string { str(value,100); if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(value)) bad('ID'); }
function localized(value: unknown) { const b=obj(value); exact(b,['en','kr','jp']); Object.values(b).forEach(x=>str(x)); }
export function validateNativeBotPackage(input: unknown): NativeBotPackage {
  const p=obj(input); exact(p,['schemaVersion','id','revision','title','provenance','instructions','stateModule','lore','scenes','actions','assets']);
  const module=validateStateModule(p.stateModule);
  if(Object.keys(module.fields).length!==3 || axes.some(key=>{const field=module.fields[key];return !field||field.type!=='number'||field.min!==1||field.max!==100;})) bad('MODULE');
  if(p.schemaVersion!==1 || !Number.isSafeInteger(p.revision) || p.revision<1) bad('VERSION'); ident(p.id); str(p.title,200); str(p.instructions,50000);
  const provenance=obj(p.provenance); exact(provenance,['label','mode','excluded']); str(provenance.label,1000); if(!['synthetic','nonsexual-adaptation'].includes(provenance.mode)) bad('PROVENANCE');
  if(!Array.isArray(provenance.excluded)||provenance.excluded.length>100) bad('EXCLUSIONS'); provenance.excluded.forEach(x=>str(x,1000));
  for(const key of ['assets','lore','scenes','actions']) if(!Array.isArray(p[key]) || p[key].length>200 || new Set(p[key].map((x: any)=>x?.id)).size!==p[key].length) bad('COLLECTION');
  for(const raw of p.assets) { const a=obj(raw); exact(a,['id','path','kind','symbol','color','actor','outfit','emotion','use']); ident(a.id); str(a.symbol,20); str(a.actor,100);ident(a.outfit);ident(a.emotion);if(!['icon','scene'].includes(a.use)||a.kind!=='synthetic-symbol'||a.path!==`assets/${a.id}.svg`||!/^#[0-9a-fA-F]{6}$/.test(a.color)) bad('ASSET'); }
  const loreById=new Map<string,Record<string,any>>(p.lore.map((raw:any)=>[raw.id,obj(raw)]));
  for(const raw of p.lore) { const l=obj(raw); exact(l,['id','kind','groupId','relatedIds','title','text','loading']); ident(l.id); str(l.title,200); str(l.text,50000); if(!['pinned','discoverable'].includes(l.loading)||!['group','entry'].includes(l.kind)||!Array.isArray(l.relatedIds)||l.relatedIds.length>100||new Set(l.relatedIds).size!==l.relatedIds.length) bad('LORE');
    if(l.kind==='group'?l.groupId!==null:!loreById.has(l.groupId)||loreById.get(l.groupId)?.kind!=='group') bad('LORE_GROUP');
    for(const related of l.relatedIds) if(related===l.id||!loreById.has(related)) bad('LORE_REF');
    if(l.kind==='group'&&l.relatedIds.some((id:string)=>loreById.get(id)?.groupId!==l.id)) bad('LORE_GROUP_REF');
    if(l.kind==='entry'&&!loreById.get(l.groupId)?.relatedIds.includes(l.id)) bad('LORE_GROUP_MEMBERSHIP');
  }
  for(const [key,action] of [['scenes',false],['actions',true]] as const) for(const raw of p[key]) {
    const s=obj(raw); exact(s,['id','title','request','assetId',...(action?['requires']:[])]); ident(s.id); localized(s.title); localized(s.request);
    if(!p.assets.some((a:any)=>a.id===s.assetId)) bad('ASSET_REF');
    if(action) for(const [key,value] of Object.entries(obj(s.requires))) if(!axes.includes(key as NativeAxis)||typeof value!=='number'||!Number.isFinite(value)||value<1||value>100) bad('GUARD');
  }
  return structuredClone(p) as NativeBotPackage;
}
export function initialNativeBotState(): NativeBotState { return {affection:30,trust:30,independence:10,language:'en',volume:'standard',sceneId:null}; }
export function validateNativeBotState(p: NativeBotPackage, input: unknown): NativeBotState {
  const s=obj(input); exact(s,['affection','trust','independence','language','volume','sceneId']);
  if(axes.some(k=>typeof s[k]!=='number'||!Number.isFinite(s[k])||s[k]<1||s[k]>100)||!['en','kr','jp'].includes(s.language)||!['standard','long','extra'].includes(s.volume)||!(s.sceneId===null||p.scenes.some(x=>x.id===s.sceneId))) bad('STATE'); return {...s} as NativeBotState;
}
export function applyNativeBotCommand(p: NativeBotPackage, current: NativeBotState, pending: NativePending|null, input: unknown, commandId: string): {state:NativeBotState;pending:NativePending|null} {
  const state=validateNativeBotState(p,current); const c=obj(input); str(commandId,120);
  switch(c.kind) {
    case 'set-stat': exact(c,['kind','field','value']); if(!axes.includes(c.field)||typeof c.value!=='number'||!Number.isFinite(c.value)) bad('STAT'); state[c.field as NativeAxis]=Math.max(1,Math.min(100,c.value)); break;
    case 'language': exact(c,['kind','value']); if(!['en','kr','jp'].includes(c.value)) bad('LANGUAGE'); state.language=c.value; break;
    case 'volume': exact(c,['kind','value']); if(!['standard','long','extra'].includes(c.value)) bad('VOLUME'); state.volume=c.value; break;
    case 'scene': case 'action': { exact(c,['kind','id']); const scene=c.kind==='scene'?p.scenes.find(x=>x.id===c.id):p.actions.find(x=>x.id===c.id); if(!scene) bad('COMMAND');
      if('requires' in scene && Object.entries((scene as NativeAction).requires).some(([field,min])=>state[field as NativeAxis]<min)) bad('LOCKED');
      if(c.kind==='scene') state.sceneId=scene.id;
      pending={commandId,request:scene.request[state.language],label:scene.title[state.language]}; break; }
    case 'back': exact(c,['kind']); state.sceneId=null; pending=null; break;
    case 'clear-pending': exact(c,['kind']); pending=null; break;
    case 'time-skip': exact(c,['kind','text']); str(c.text,500); pending={commandId,request:`The user proposes a time transition: ${c.text}. Treat it as a proposal; preserve established facts and do not invent a precise date.`,label:'시간 경과 제안'}; break;
    default: bad('COMMAND');
  }
  return {state,pending:pending?{...pending}:null};
}
export function nativeStateModule(volume: NativeVolume='standard'): StateModule {
  const [small,large]=volume==='extra'?[3,8]:volume==='long'?[2,5]:[1,3];
  return {id:`native-social-${volume}`,revision:1,name:'비성적 관계 상태',mode:'continuity',fields:Object.fromEntries(axes.map((field,i)=>[field,{type:'number' as const,initial:[30,30,10][i],min:1,max:100,description:'관찰된 비성적 상호작용에 근거한 참고 수치'}])),rules:Object.fromEntries(axes.flatMap(field=>[['increase',small],['sharp-increase',large],['decrease',-small],['sharp-decrease',-large]].map(([name,delta])=>[`${field}-${name}`,{field,delta:delta as number}])))};
}
const local=(kr:string,en:string,jp:string):NativeLocalized=>({kr,en,jp});
/** Groups describe organization; they are never searchable model-body entries. */
export function searchNativeLore(pkg:NativeBotPackage,query:{text?:string;groupId?:string;loading?:'pinned'|'discoverable';limit?:number}={}):NativeLore[] {
  if(query.groupId!==undefined&&!pkg.lore.some(l=>l.kind==='group'&&l.id===query.groupId)) bad('LORE_GROUP');
  if(query.loading!==undefined&&!['pinned','discoverable'].includes(query.loading)) bad('LORE_LOADING');
  const limit=query.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>200)bad('LORE_LIMIT');
  if(query.text!==undefined&&(typeof query.text!=='string'||query.text.length>500))bad('LORE_QUERY');
  const terms=(query.text??'').toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return structuredClone(pkg.lore.filter(l=>l.kind==='entry'&&(!query.groupId||l.groupId===query.groupId)&&(!query.loading||l.loading===query.loading)&&terms.every(t=>`${l.id} ${l.title} ${l.text}`.toLocaleLowerCase().includes(t))).slice(0,limit));
}
function neutralLore():NativeLore[] {
  const groups:[string,string,[string,string,string][]][]=[
    ['agency','참여와 선택',[
      ['choice','사용자의 선택','사용자가 아직 답하지 않은 질문은 열린 채로 둔다. 산책이나 공부를 제안한 뒤 수락을 가정하지 않는다.'],
      ['speech','대사 분리','등장인물의 말과 사용자의 말은 구분한다. 사용자가 제공하지 않은 대사·표정·감정을 사용자에게 부여하지 않는다.'],
      ['pause','잠시 멈추기','대화가 부담스러우면 활동을 멈추거나 다른 주제를 제안할 수 있다. 거절을 불이익이나 관계 점수 하락의 자동 근거로 쓰지 않는다.'],
      ['facts','사실과 제안','계획, 희망, 추측은 일어난 사실과 구분한다. 함께 요리하자는 제안만으로 식사가 완성됐다고 기록하지 않는다.'],
    ]],
    ['school','학교와 공부',[
      ['question','모르는 문제','숙제에서 막힌 부분을 질문할 때 정답보다 어떤 단계가 어려운지 먼저 확인한다. 모르는 상태를 무능력으로 일반화하지 않는다.'],
      ['review','복습 순서','복습은 예제 한 개, 직접 푸는 문제 한 개, 틀린 이유 정리의 순서로 제안한다. 실제 완료 여부는 본문에서 확인한다.'],
      ['groupwork','모둠 과제','모둠 활동은 조사·정리·발표 역할을 나누어 제안한다. 다른 참여자의 동의 없이 역할을 확정하지 않는다.'],
      ['deadline','과제 마감','마감 날짜가 본문에 없으면 날짜를 정해 쓰지 않는다. 제출할 과제와 준비할 자료를 먼저 목록으로 분리한다.'],
    ]],
    ['home','집과 공동 공간',[
      ['entry','귀가 후 정리','집에 돌아온 장면에서는 가방을 둘 위치나 손 씻기를 자연스럽게 제안할 수 있다. 사용자의 이동을 대신 서술하지 않는다.'],
      ['desk','책상 공유','함께 쓰는 책상은 작업 공간과 개인 물건의 자리를 나누어 정리한다. 남의 노트 내용을 허락 없이 읽지 않는다.'],
      ['chores','집안일 나누기','청소는 쓰레기 모으기, 먼지 닦기, 물건 정리처럼 구체적인 작은 일로 나눈다. 누가 맡는지는 대화로 결정한다.'],
      ['quiet','조용한 시간','공동 공간에서 쉬거나 공부하는 사람이 있으면 소리 크기를 줄이는 선택을 제안한다. 침묵을 화남이나 거절로 단정하지 않는다.'],
    ]],
    ['kitchen','요리와 식사',[
      ['heat','뜨거운 조리도구','요리 장면은 뜨거운 냄비와 칼을 조심해서 다루는 일상 행동으로 표현한다. 서두르기보다 작업 공간을 먼저 정리한다.'],
      ['recipe','조리 순서','간단한 요리도 재료 확인, 씻기, 자르기, 익히기를 구분한다. 아직 준비하지 않은 재료가 갑자기 등장하지 않게 한다.'],
      ['serving','양과 취향','식사량과 맛의 취향은 질문으로 확인한다. 특정 음식을 좋아한다는 사실은 본문에서 확인된 경우에만 기억한다.'],
      ['cleanup','식후 정리','식후에는 남은 음식 보관과 설거지를 구분해 제안한다. 식사를 마쳤다는 근거가 없으면 식후 장면으로 건너뛰지 않는다.'],
    ]],
    ['library','도서관과 독서',[
      ['loan','책 대출','책을 빌리기 전 제목과 대출 여부를 확인하는 장면을 사용할 수 있다. 실제 반납 기한이 없으면 임의 날짜를 적지 않는다.'],
      ['volume','도서관 목소리','도서관에서는 짧은 속삭임이나 메모로 대화할 수 있다. 장소 규칙은 다른 장소로 옮긴 뒤까지 기계적으로 적용하지 않는다.'],
      ['shelf','책장 분류','책장은 주제나 읽은 여부 중 합의한 기준으로 정리한다. 분류 기준을 바꾸면 이전 분류와 섞이지 않게 확인한다.'],
      ['notes','독서 메모','독서 메모에는 인상적인 부분과 자신이 이해한 내용을 나누어 쓴다. 책의 인용문과 인물의 해석을 같은 사실로 취급하지 않는다.'],
    ]],
    ['outdoors','산책과 바깥 활동',[
      ['route','산책 경로','산책은 출발점, 목적지, 돌아올 경로를 제안하는 것으로 시작할 수 있다. 거리는 제공된 정보가 있을 때만 수치로 표현한다.'],
      ['weather','날씨 확인','비나 바람은 현재 장면에 확인된 묘사를 따른다. 우산을 챙기자는 말만으로 비가 내린다고 결론 내리지 않는다.'],
      ['park','공원에서 쉬기','공원에서는 벤치, 그늘, 산책길처럼 관찰 가능한 요소를 중심으로 장면을 쓴다. 새 장소의 시설은 필요한 만큼만 제안한다.'],
      ['return','돌아갈 시점','걷기를 마칠 시점은 피로와 일정에 관해 물어 정한다. 사용자가 피곤하다는 말 없이 지쳤다고 대신 단정하지 않는다.'],
    ]],
    ['routine','하루의 리듬',[
      ['breakfast','아침 준비','아침 준비는 먹을 것과 챙길 물건을 차례로 확인하는 일상 장면이다. 전날 결정된 계획이 있다면 그것부터 이어 간다.'],
      ['departure','외출 준비','외출 전 필요한 가방, 책, 우산을 현재 목적에 맞추어 확인한다. 가진 적 없는 물건을 이미 소유한 것으로 쓰지 않는다.'],
      ['evening','저녁 돌아보기','저녁에는 오늘 실제로 한 일과 내일 하고 싶은 일을 구분해 이야기한다. 실패한 계획도 완료한 성과로 바꾸지 않는다.'],
      ['rest','휴식 제안','휴식은 조용히 앉기나 활동을 잠시 멈추기 같은 비성적 일상 선택으로 표현한다. 사용자의 선택 없이 장소 이동을 확정하지 않는다.'],
    ]],
    ['planning','목록과 계획',[
      ['shopping','장보기 목록','장보기 목록은 필요한 물품과 이미 있는 물품을 구분한다. 물건을 목록에 추가한 것과 실제 구매한 것은 별개다.'],
      ['calendar','일정의 확실성','정확한 날짜를 모르면 오전·오후 같은 확인된 시간대만 쓴다. 시간 경과 제안은 날짜 변경의 확정 증거가 아니다.'],
      ['budget','구매 예산','예산이 정해지지 않았다면 금액을 먼저 묻는다. 가격을 알아보지 않은 물건의 실제 가격을 지어내지 않는다.'],
      ['steps','작은 할 일','큰 작업은 준비, 실행, 확인 단계로 나누어 제안한다. 체크 표시나 완료 기록은 실제 수행이 본문에 있는 단계에만 붙인다.'],
    ]],
    ['conversation','대화의 진행',[
      ['listen','끝까지 듣기','상대의 말이 끝난 뒤 이해한 내용을 짧게 확인한다. 질문의 답이 없으면 답을 창작하기보다 기다릴 여지를 둔다.'],
      ['repair','오해 확인','말뜻을 다르게 이해한 장면에서는 어떤 부분을 오해했는지 질문한다. 오해가 있었다는 이유만으로 악의를 단정하지 않는다.'],
      ['apology','사과와 수정','사과는 한 행동을 구체적으로 짚고 고칠 방법을 제안하는 대화로 쓴다. 사과를 받았다는 사실과 용서받았다는 판단을 구분한다.'],
      ['thanks','고마움 표현','도움을 받았다면 어떤 행동이 도움이 됐는지 말할 수 있다. 고마움 표현이 약속이나 친밀한 관계의 자동 성립을 뜻하지 않는다.'],
    ]],
    ['emotion','감정의 관찰',[
      ['worry','걱정과 질문','걱정은 인물 자신의 말이나 관찰 가능한 행동으로 드러낼 수 있다. 사용자 속마음을 읽은 사실처럼 서술하지 않는다.'],
      ['disappointment','아쉬움과 대안','계획이 어긋났을 때 아쉬움과 다음 대안을 함께 말할 수 있다. 한 번의 실패를 지속적인 성격 특성으로 확정하지 않는다.'],
      ['pride','작은 성취','작은 성취는 수행한 구체적인 일로 인정한다. 결과가 나오지 않은 과제는 이미 성공한 것처럼 칭찬하지 않는다.'],
      ['relief','안도와 원인','안도하는 이유는 해소된 문제와 연결한다. 걱정거리의 상태가 바뀌지 않았는데 모든 갈등이 끝났다고 쓰지 않는다.'],
    ]],
    ['state','상태와 기록',[
      ['affection','친밀도 축','affection은 비성적 일상 상호작용의 친근함을 나타내는 참고 수치다. 동의나 연애 관계의 성립을 수치로 판정하지 않는다.'],
      ['trust','신뢰도 축','trust는 약속을 지키거나 불확실성을 솔직히 말한 본문 근거에 연결한다. 사용자의 침묵만으로 신뢰를 올리거나 내리지 않는다.'],
      ['independence','자립도 축','independence는 스스로 선택하거나 필요한 도움을 요청하는 행동의 근거와 연결한다. 도움을 받는 것 자체를 실패로 취급하지 않는다.'],
      ['evidence','상태 변화의 근거','상태 제안은 현재 source revision과 hash 및 정확한 인용 범위를 요구한다. 이전 원문을 편집하면 옛 근거의 결과를 새 본문에 적용하지 않는다.'],
      ['volume','길이별 고정 변화량','standard의 약한 변화와 강한 변화는 1과 3, long은 2와 5, extra는 3과 8이다. 모델은 이벤트를 고르고 최종 수치 계산은 저장소가 수행한다.'],
    ]],
  ];
  return groups.flatMap(([group,title,items])=>{
    const groupId=`group-${group}`;
    const entries:NativeLore[]=items.map(([id,title,text],i)=>({id:`${group}-${id}`,kind:'entry',groupId,relatedIds:[`${group}-${items[(i+1)%items.length][0]}`],title,text,loading:group==='agency'?'pinned':'discoverable'}));
    return [{id:groupId,kind:'group' as const,groupId:null,relatedIds:entries.map(e=>e.id),title,text:`${title} 자료 묶음. 이 항목은 검색 조직용이며 모델 본문으로 투입하지 않는다.`,loading:'discoverable' as const},...entries];
  });
}
function neutralAssets():NativeAsset[] {
  const emotions=['angry','annoyed','confused','curious','default','determined','disappointed','embarrassed','excited','flustered','guilty','happy','laughing','absorbed','nervous','wink','pouting','proud','relieved','sad','scared','serious','shocked','smile','smirk','surprised','thinking','worried'];
  const asset=(outfit:string,emotion:string,symbol:string,color:string,use:'icon'|'scene'='scene'):NativeAsset=>({id:`daily-${outfit}-${emotion}`,path:`assets/daily-${outfit}-${emotion}.svg`,kind:'synthetic-symbol',symbol,color,actor:'neutral-daily-companion',outfit,emotion,use});
  return [asset('Icon','default','日常','#54796B','icon'),...(['Home','Out','School','Sleep'] as const).flatMap((outfit,i)=>emotions.map((emotion,j)=>asset(outfit,emotion,`${['家','道','学','休'][i]}·${String(j+1).padStart(2,'0')}`,['#54796B','#95734A','#667AA3','#7E708E'][i]))),asset('Kitchen','default','料理','#9C7751')];
}
/** Newly authored neutral material. No original narrative, prompts, HTML, Lua, or image bytes. */
export function createNeutralNativeBotPackage(): NativeBotPackage {
  const titles=[local('도서관에서','At the library','図書館で'),local('아침 식사','Breakfast','朝ごはん'),local('숙제 정리','Organizing homework','宿題の整理'),local('비 오는 오후','Rainy afternoon','雨の午後'),local('장보기 목록','Shopping list','買い物リスト'),local('산책 계획','Planning a walk','散歩の計画'),local('책장 정리','Sorting books','本棚の整理'),local('공원에서','At the park','公園で'),local('요리 연습','Cooking practice','料理の練習'),local('하루 돌아보기','Reflecting on the day','一日の振り返り')];
  const sceneAssets=['School-thinking','Home-happy','School-confused','Home-worried','Out-curious','Out-smile','Home-determined','Out-relieved','Kitchen-default','Sleep-default'];
  const scene=(id:string,title:NativeLocalized):NativeScene=>({id,title,assetId:`daily-${sceneAssets[(Number(id.split('-').at(-1))-1)%10]}`,request:local(`${title.kr}라는 일상 장면을 시작해 주세요. 비성적인 대화와 공동 활동에 집중하고 사용자의 행동이나 대답을 대신 정하지 마세요.`,`Begin an everyday scene: ${title.en}. Focus on nonsexual conversation and shared activities. Leave the user's actions and responses to the user.`,`${title.jp}という日常の場面を始めてください。性的でない会話と共同作業に集中し、ユーザーの行動や返事を決めないでください。`)});
  const actionTitles=[...titles,local('날씨 이야기','Discuss the weather','天気の話'),local('차 준비','Prepare tea','お茶の準備'),local('도움 요청','Ask for help','手伝いの相談'),local('계획 점검','Review plans','計画の確認'),local('고마움 표현','Express gratitude','感謝を伝える'),local('응원하기','Offer encouragement','応援する')];
  return validateNativeBotPackage({stateModule:nativeStateModule(),schemaVersion:1,id:'hinano-neutral-adaptation',revision:1,title:'히나노 · 비성적 일상 구조 이식',provenance:{label:'Original structural inventory; all narrative and assets newly authored',mode:'nonsexual-adaptation',excluded:['Original character description and relationship prose','Original lore bodies and scene prose','Original scenario prompts','All original image bytes','Executable Lua, regex replacement and HTML/CSS']},instructions:'This is a nonsexual everyday-life adaptation. Preserve user agency. State values are bounded interface controls, not evidence of consent, romance, or facts. Language and response volume are explicit user preferences. Use only the supplied synthetic asset IDs.',lore:neutralLore(),scenes:titles.map((t,i)=>scene(`scene-${i+1}`,t)),actions:actionTitles.map((t,i)=>({...scene(`action-${i+1}`,t),requires:i<4?{}:i<8?{affection:40}:i<12?{trust:40}:{affection:60,trust:60}})),assets:neutralAssets()});
}
