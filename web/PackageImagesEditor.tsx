import { useLayoutEffect, useRef, useState } from 'react';
import type { ContentPackage } from '../core/content-package.js';
import { PACKAGE_IMAGE_MIMES, type PackageImage } from '../core/package-images.js';
import { sessionRequiredEvent } from './api.js';
import './package-images.css';

type Props = { value: ContentPackage; onChange: (value: ContentPackage) => void; onDirtyChange?: (dirty: boolean) => void };
const pageSize = 50;
const imageUrl = (image: PackageImage) => `/api/package-image-blobs/${image.blobHash}`;

/** Uploads immutable bytes, then appends a reference to the latest authoring draft. */
export function PackageImagesEditor({ value, onChange, onDirtyChange }: Props) {
  const scope = `${value.id}@${value.revision}`;
  const latest = useRef({ value, onChange, onDirtyChange, scope });
  latest.current = { value, onChange, onDirtyChange, scope };
  const generation = useRef(0), upload = useRef<AbortController | null>(null);
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [selected, setSelected] = useState('');
  const [remove, setRemove] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  useLayoutEffect(() => {
    generation.current++; setBusy(false); setMessage(''); setError(''); setQuery(''); setPage(0); setSelected(''); setRemove('');
    return () => { generation.current++; upload.current?.abort(); upload.current = null; latest.current.onDirtyChange?.(false); };
  }, [scope]);
  const change = (images: PackageImage[]) => {
    const next = { ...latest.current.value, images };
    if(next.portraitImageId&&!images.some(image=>image.id===next.portraitImageId&&image.allowedUse!=='inline'))delete next.portraitImageId;
    latest.current.value = next;
    latest.current.onChange(next);
  };
  const edit = (id: string, patch: Partial<PackageImage>) => change((latest.current.value.images ?? []).map(image => image.id === id ? { ...image, ...patch } : image));
  const images = value.images ?? [], needle = query.trim().toLocaleLowerCase();
  const found = images.filter(image => `${image.title} ${image.description}`.toLocaleLowerCase().includes(needle));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(found.length / pageSize) - 1)), visible = found.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const active = images.find(image => image.id === selected), removing = images.find(image => image.id === remove);

  async function addFiles(files: File[]) {
    if (!files.length || upload.current) return;
    if ((latest.current.value.images?.length ?? 0) + files.length > 2000) { setError('자료 하나에 이미지를 2,000개까지 등록할 수 있어요.'); return; }
    const token = ++generation.current, originalScope = latest.current.scope, controller = new AbortController();
    upload.current = controller; setBusy(true); setError(''); setMessage(`0 / ${files.length}개 업로드`); latest.current.onDirtyChange?.(true);
    const current = () => generation.current === token && latest.current.scope === originalScope && !controller.signal.aborted;
    const failed: string[] = []; let added = 0;
    try {
      for (const [index, file] of files.entries()) {
        if (!current()) return;
        try {
          if (!PACKAGE_IMAGE_MIMES.includes(file.type as PackageImage['mime']) || file.size > 2_000_000 || file.size === 0) throw new Error('2MB 이하 PNG, JPEG 또는 WebP가 필요해요.');
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!current()) return;
          let binary = ''; for (let start = 0; start < bytes.length; start += 32_768) binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
          const response = await fetch('/api/package-image-blobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: file.type, base64: btoa(binary) }), signal: controller.signal });
          if (!current()) return;
          if (response.status === 401) window.dispatchEvent(new Event(sessionRequiredEvent));
          if (!response.ok) throw new Error(`이미지를 업로드하지 못했어요. (${response.status})`);
          const result: { hash: string; mime: PackageImage['mime'] } = await response.json();
          if (!current()) return;
          if (!/^[a-f0-9]{64}$/u.test(result.hash) || result.mime !== file.type) throw new Error('이미지 응답을 확인할 수 없어요.');
          const image: PackageImage = { id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/u, '').trim().slice(0, 200) || '이미지', description: '', blobHash: result.hash, mime: result.mime, allowedUse: 'both' };
          if ((latest.current.value.images?.length ?? 0) >= 2000) throw new Error('자료 하나에 이미지를 2,000개까지 등록할 수 있어요.');
          change([...(latest.current.value.images ?? []), image]); setSelected(image.id); added++;
        } catch (cause) {
          if (!current()) return;
          failed.push(`${file.name}: ${cause instanceof Error ? cause.message : '업로드하지 못했어요.'}`);
        }
        if (current()) setMessage(`${index + 1} / ${files.length}개 처리 · ${added}개 추가`);
      }
      if (current()) { setMessage(`${added}개 이미지를 자료에 추가했어요. 자료를 저장하면 적용돼요.`); setError(failed.slice(0, 5).join('\n') + (failed.length > 5 ? `\n외 ${failed.length - 5}개 실패` : '')); }
    } finally {
      if (current()) { upload.current = null; setBusy(false); latest.current.onDirtyChange?.(false); }
    }
  }

  return <section className="package-images" aria-label="자료 이미지">
    <p className="muted">이미지를 올리고 알아보기 쉬운 이름을 붙여요. 이미지 선택 모델이 이름과 선택적 설명을 읽고 원문의 적절한 위치를 골라요. 봇·페르소나·모듈로 사용할 때 같은 이미지를 쓸 수 있어요.</p>
    <div className="package-images-toolbar">
      <label>이미지 파일 추가<input aria-label="자료 이미지 파일 추가" type="file" multiple accept={PACKAGE_IMAGE_MIMES.join(',')} disabled={busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addFiles(files); }}/><small>PNG · JPEG · WebP, 파일마다 2MB 이하</small></label>
      <label>이미지 검색<input type="search" value={query} placeholder="이름 또는 설명" onChange={event => { setQuery(event.target.value); setPage(0); }}/></label>
    </div>
    <p role="status" aria-live="polite">{message || `${images.length}개 이미지`}{busy && ' · 업로드가 끝난 뒤 자료를 저장해 주세요.'}</p>
    {error && <p role="alert" className="error package-images-error">{error}</p>}
    <div className="package-images-layout">
      <div>
        <div className="package-images-list" role="list" aria-label="등록한 이미지">
          {visible.map(image => <div role="listitem" key={image.id}><button type="button" className={`secondary package-image-choice${selected === image.id ? ' is-selected' : ''}`} aria-pressed={selected === image.id} onClick={() => { setSelected(image.id); setRemove(''); }}><img src={imageUrl(image)} alt="" loading="lazy"/><span>{image.title || '이름 없음'}<small>{image.allowedUse === 'both' ? '대표 · 본문' : image.allowedUse === 'profile' ? '대표 이미지' : '본문용'}</small></span></button></div>)}
        </div>
        {!found.length && <p className="muted">{images.length ? '검색 결과가 없어요.' : '아직 등록한 이미지가 없어요.'}</p>}
        {found.length > pageSize && <nav className="package-images-pages" aria-label="자료 이미지 페이지"><button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</button><span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, found.length)} / {found.length}</span><button type="button" className="secondary" disabled={(currentPage + 1) * pageSize >= found.length} onClick={() => setPage(currentPage + 1)}>다음</button></nav>}
      </div>
      {active ? <div className="package-image-detail" aria-label="선택한 이미지 편집">
        <img className="package-image-preview" src={imageUrl(active)} alt={active.description || active.title}/>
        <label>이미지 이름<input aria-label="선택한 이미지 이름" required maxLength={200} value={active.title} onChange={event => edit(active.id, { title: event.target.value })}/></label>
        <label>설명 <small>선택 사항</small><textarea aria-label="선택한 이미지 설명" maxLength={2000} rows={3} value={active.description} placeholder="이름만으로 구분하기 어려울 때 적어요." onChange={event => edit(active.id, { description: event.target.value })}/></label>
        <label>사용 위치<select aria-label="선택한 이미지 사용 위치" value={active.allowedUse} onChange={event => edit(active.id, { allowedUse: event.target.value as PackageImage['allowedUse'] })}><option value="both">대표 이미지와 본문</option><option value="profile">대표 이미지</option><option value="inline">본문용</option></select></label>
        <label className="check"><input type="checkbox" aria-label="자료의 대표 이미지로 사용" disabled={active.allowedUse==='inline'} checked={value.portraitImageId===active.id} onChange={event=>{const next={...latest.current.value};if(event.target.checked)next.portraitImageId=active.id;else delete next.portraitImageId;latest.current.value=next;latest.current.onChange(next);}}/>자료의 대표 이미지로 사용</label>
        <small>같은 이름도 사용할 수 있어요. 구분 번호: {active.id.slice(0, 8)}</small>
        <button type="button" className="ghost" onClick={() => setRemove(active.id)}>이 자료에서 이미지 제거</button>
        {removing && <div role="alertdialog" aria-label="이미지 참조 제거 확인" className="package-image-remove"><p>“{removing.title}”을 이 자료의 새 버전에서 제거할까요? 저장된 이전 자료 버전과 과거 장면에서 쓰는 이미지는 보존돼요.</p><button type="button" className="secondary" onClick={() => { change((latest.current.value.images ?? []).filter(image => image.id !== removing.id)); setRemove(''); setSelected(''); }}>이미지 참조 제거</button><button type="button" className="secondary" onClick={() => setRemove('')}>취소</button></div>}
      </div> : <p className="muted">이미지를 선택하면 이름과 설명을 편집할 수 있어요.</p>}
    </div>
  </section>;
}
