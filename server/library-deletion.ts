import type { FastifyInstance } from 'fastify';
import { fields, number, record } from './product-store.js';
import { HttpError, type Store } from './store.js';

export type LibraryKind = 'content' | 'preset' | 'prompt-preset' | 'prompt-combination' | 'connection' | 'model' | 'native-bot' | 'hidden-story';
type Blocker = {table:string;label:string;count:number};
const labels:Record<string,string> = {
  versions:'다른 자료·프롬프트·등록 기록(이전 개정 포함)', provider_settings:'저장된 모델 설정',
  profiles:'채팅 설정', chat_organization:'봇 소속 채팅', chat_folders:'봇 폴더·기본 페르소나',
  story_configs:'상태·기억 설정 이력', native_chat_settings:'채팅의 native 봇 설정',
  runs:'생성 기록', jobs:'번역·이미지 작업', story_jobs:'상태·기억 작업',
  attempts:'모델 호출', provider_connection_tests:'진행 중인 응답 테스트',
  assets:'저장된 이미지', resources:'채팅 자료', native_actions:'native 실행 기록',
};
const identifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
const providerKind=(kind:LibraryKind)=>kind==='connection'||kind==='model';

/** Reference checks stay inside SQLite: return counts, never prompt/source/credential bodies.
 * Versioned content remains necessary to validate frozen runs and archive graphs.
 * Provider settings differ: completed work carries its own immutable model/connection snapshot.
 */
export function libraryDeletionImpact(store:Store,kind:LibraryKind,id:string) {
  const item=store.product.get<{revision:number}>(kind,id);
  const ownTable=providerKind(kind)?'provider_settings':'versions';
  const blockers:Blocker[]=[];
  const tables=store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
  for(const {name:table} of tables){
    const columns=store.db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as {name:string;type:string}[];
    const textColumns=columns.filter(column=>column.type.toUpperCase()==='TEXT');
    if(!textColumns.length)continue;
    const conditions:string[]=[];
    const values:(string|number)[]=[];
    if(table===ownTable){conditions.push('NOT (t.kind=? AND t.id=?)');values.push(kind,id);}
    if(providerKind(kind)){
      if(['runs','jobs','story_jobs','provider_connection_tests','attempts'].includes(table))conditions.push("t.status IN ('queued','running','waiting_for_state','pending')");
      // These are immutable execution diagnostics, not current provider selectors.
      if(['model_inputs','tool_events','job_results','job_chunks','events','native_actions','package_behavior_journal','package_behavior_run_journal'].includes(table))continue;
      if(table==='versions')conditions.push("(t.kind<>'registration-run' OR (json_extract(t.body,'$.status')='running' AND t.revision=(SELECT MAX(v.revision) FROM versions v WHERE v.kind=t.kind AND v.id=t.id)))");
    }
    // Exact JSON values include refs in arrays (relatedIds), nested package modules,
    // prompt selections and future reference-bearing fields without substring matches.
    const references=textColumns.map(column=>{
      const field=`t.${identifier(column.name)}`;
      values.push(id,id);
      return `(${field}=? OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(${field}) THEN ${field} ELSE 'null' END) j WHERE j.type='text' AND j.atom=?))`;
    });
    conditions.push(`(${references.join(' OR ')})`);
    const count=Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${identifier(table)} t WHERE ${conditions.join(' AND ')}`).get(...values) as {n:number}).n);
    if(count)blockers.push({table,label:labels[table]??'연결된 저장 기록',count});
  }
  return {kind,id,revision:item.revision,canDelete:blockers.length===0,blockers};
}

export function deleteLibraryItem(store:Store,kind:LibraryKind,id:string,value:unknown){
  const body=record(value);fields(body,['expectedRevision']);const expected=number(body.expectedRevision,'revision');
  return store.transaction(()=>{
    const latest=store.product.get<{revision:number}>(kind,id);
    if(latest.revision!==expected)throw new HttpError(409,'항목이 변경됐어요. 새로고침한 뒤 다시 삭제해 주세요.');
    const impact=libraryDeletionImpact(store,kind,id);
    if(!impact.canDelete)throw new HttpError(409,`삭제할 수 없어요: ${impact.blockers.map(blocker=>`${blocker.label} ${blocker.count}건`).join(', ')}에서 참조하고 있어요. 연결을 해제하거나 해당 항목을 먼저 삭제해 주세요. 이전 개정·생성 기록의 참조는 해당 자료·채팅을 삭제해야 해제돼요.`);
    store.db.prepare(`DELETE FROM ${providerKind(kind)?'provider_settings':'versions'} WHERE kind=? AND id=?`).run(kind,id);
    return {deleted:true,id};
  });
}

export function libraryDeletionRoutes(app:FastifyInstance,store:Store){
  const routes:Record<LibraryKind,string>={content:'content',preset:'creative-presets','prompt-preset':'prompt-presets','prompt-combination':'prompt-combinations',connection:'connections',model:'model-presets','native-bot':'native-bots','hidden-story':'hidden-story/modules'};
  for(const [kind,path] of Object.entries(routes) as [LibraryKind,string][]){
    app.get<{Params:{id:string}}>(`/api/${path}/:id/deletion-impact`,async request=>libraryDeletionImpact(store,kind,request.params.id));
    app.delete<{Params:{id:string}}>(`/api/${path}/:id`,async request=>deleteLibraryItem(store,kind,request.params.id,request.body));
  }
}
