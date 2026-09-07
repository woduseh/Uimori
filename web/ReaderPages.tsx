import type { ReaderDetail } from '../core/types.js';

export function ReaderPages({detail,head,onSelect,end=false}:{detail:ReaderDetail|null;head:string|null;onSelect:(id:string)=>void;end?:boolean}) {
  const page=detail?.reader;
  if(!page || !page.previous && !page.next) return null;
  return <nav className="reader-pages" aria-label={end?'원고 구간 끝':'원고 구간'}>
    <button className="secondary" disabled={!page.previous} onClick={()=>onSelect(page.previous!)}>이전 원고</button>
    <span>{page.start+1}–{page.start+page.order.length} / {page.total}</span>
    <button className="secondary" disabled={!page.next} onClick={()=>onSelect(page.next!)}>다음 원고</button>
    <button className="secondary" disabled={!page.latest || !!head && page.order.includes(head)} onClick={()=>onSelect(page.latest!)}>최근 원고</button>
  </nav>;
}
