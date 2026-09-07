import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api.js';

export function LazyDiagnostics<T>({ path, revision, title, initiallyOpen = false, children }: { path:string; revision:number|string; title:ReactNode; initiallyOpen?:boolean; children:(value:T)=>ReactNode }) {
  const [open,setOpen] = useState(initiallyOpen);
  const [value,setValue] = useState<T|null>(null);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  useEffect(() => { setOpen(initiallyOpen); },[initiallyOpen]);
  useEffect(() => {
    if (!open) { setValue(null); return; }
    let active = true; setValue(null); setError('');
    void api<T>(path).then(result => { if (active) setValue(result); }).catch(cause => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  },[path,revision,open,retry]);
  return <details className="inspector" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}</summary>{open && (error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value+1)}>다시 불러오기</button></p> : value === null ? <p role="status">상세를 불러오는 중이에요…</p> : children(value))}</details>;
}
