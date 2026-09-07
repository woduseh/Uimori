import { useState } from 'react';
import { Check, Search } from 'lucide-react';
import type { Connection } from '../core/product.js';
import { supportedModels, modelCapability, isOfficialModelConnection } from '../core/model-capabilities.js';

type CatalogModel = Connection['catalog'][number];
/** Local support metadata and cached catalog selection. Refresh alone owns network access. */
export function ProviderCatalogPicker({connection,selectedId,busy,onChoose}:{connection:Connection|undefined;selectedId:string;busy:boolean;onChoose:(model:CatalogModel)=>void}) {
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(24);
  if(!connection)return <p className="muted full">연결을 먼저 선택해 주세요. 새 연결이 필요하면 목록의 ‘빠른 연결 시작’을 이용해요.</p>;
  const official=isOfficialModelConnection(connection),local:CatalogModel[]=supportedModels(connection.protocol).map(item=>({id:item.id,name:item.name,capabilities:{},priceRevision:null}));
  const catalog=[...new Map([...local,...connection.catalog].map(item=>[item.id,item])).values()];
  const needle=query.trim().toLocaleLowerCase(),models=catalog.filter(item=>!needle||`${item.name} ${item.id}`.toLocaleLowerCase().includes(needle));
  return <section className="provider-catalog full" aria-label="저장된 모델 목록에서 선택">
    <div className="provider-section-heading"><h4>모델 목록에서 선택</h4><small>{catalog.length.toLocaleString()}개 · {local.length?official?'지원 명세와 저장된 목록':'참고 명세와 저장된 목록':'저장된 목록'}</small></div>
    {catalog.length>0?<>
      <label className="provider-search"><Search size={16} aria-hidden="true"/><input type="search" aria-label="모델 목록 검색" placeholder="모델 이름 또는 ID" value={query} onChange={event=>{setQuery(event.target.value);setLimit(24);}}/></label>
      <div className="provider-catalog-grid">{models.slice(0,limit).map(item=><button type="button" className={`secondary provider-catalog-choice ${selectedId===item.id?'selected':''}`} key={item.id} aria-pressed={selectedId===item.id} disabled={busy} onClick={()=>onChoose(item)}><strong>{item.name}</strong><small>{item.id}</small><small>{modelCapability(connection.protocol,item.id)?official?'파라미터 지원 명세 있음':'참고 명세 · 연결 지원 미확인':'모델별 옵션 미확인'}</small>{selectedId===item.id&&<Check size={16} aria-hidden="true"/>}</button>)}</div>
      {!models.length&&<p className="muted">검색 결과가 없어요. 아래에서 모델 ID를 직접 입력할 수 있어요.</p>}
      {models.length>limit&&<button type="button" className="secondary" onClick={()=>setLimit(value=>value+24)}>모델 더 보기 · {limit} / {models.length}</button>}
    </>:<p className="muted">저장된 목록이 없어요. 연결 준비 상태에서 목록을 불러오거나, 아래에 모델 ID를 직접 입력해요.</p>}
  </section>;
}
