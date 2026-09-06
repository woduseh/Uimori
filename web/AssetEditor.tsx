import { useState } from 'react';
import type { Asset } from '../core/product.js';
import { api } from './api.js';

export function AssetEditor({ chatId, assets, refresh, onError }: { chatId: string; assets: Asset[]; refresh: () => Promise<void>; onError: (error: string) => void }) {
  const [value, setValue] = useState({ title: '', description: '', actor: '', outfit: '', location: '', allowedUse: 'both' as Asset['allowedUse'] });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return <details className="workspace-tools"><summary>이 이야기의 이미지 <small>{assets.length}개</small></summary>
    <div className="asset-grid">{assets.map(asset => <figure key={asset.id}><img src={asset.url} alt={asset.description || asset.title} loading="lazy"/><figcaption>{asset.title}<small>{[asset.actor, asset.outfit, asset.location].filter(Boolean).join(' · ')} · {asset.allowedUse}</small></figcaption></figure>)}</div>
    <form className="editor-grid" onSubmit={async event => {
      event.preventDefault(); if (!file) return; setBusy(true); onError('');
      try {
        if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2_000_000) throw new Error('2MB 이하 PNG 또는 JPEG를 선택해 주세요.');
        const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했어요.')); reader.readAsDataURL(file); });
        await api(`/chats/${chatId}/assets`, { ...value, mime: file.type, base64 }); await refresh(); setMessage('이미지를 등록했어요.');
      } catch (error) { onError((error as Error).message); } finally { setBusy(false); }
    }}>
      <label className="full">PNG 또는 JPEG 이미지<input aria-label="PNG 또는 JPEG 이미지" type="file" accept="image/png,image/jpeg" required onChange={event => setFile(event.target.files?.[0] ?? null)}/></label>
      <label>이미지 이름<input aria-label="이미지 이름" required maxLength={160} value={value.title} onChange={event => setValue({ ...value, title: event.target.value })}/></label>
      <label>이미지 설명<input aria-label="이미지 설명" required maxLength={1000} value={value.description} onChange={event => setValue({ ...value, description: event.target.value })}/></label>
      <label>이미지 인물<input aria-label="이미지 인물" value={value.actor} onChange={event => setValue({ ...value, actor: event.target.value })}/></label><label>이미지 의상<input aria-label="이미지 의상" value={value.outfit} onChange={event => setValue({ ...value, outfit: event.target.value })}/></label><label>이미지 장소<input aria-label="이미지 장소" value={value.location} onChange={event => setValue({ ...value, location: event.target.value })}/></label>
      <label>이미지 용도<select aria-label="이미지 용도" value={value.allowedUse} onChange={event => setValue({ ...value, allowedUse: event.target.value as Asset['allowedUse'] })}><option value="both">프로필과 본문</option><option value="profile">프로필</option><option value="inline">본문</option></select></label>
      <div className="form-actions full"><button disabled={busy || !file}>이미지 등록</button><span role="status">{message}</span></div>
    </form>
  </details>;
}
