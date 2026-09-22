import { memo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Content } from '../core/product.js';
import { contentPortraitUrl } from './content-portrait.js';
import { Dialog } from './Dialog.js';
import './reader-gallery.css';

function Portrait({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img src={url} alt={title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  ) : (
    <span className="reader-portrait-empty" role="img" aria-label={`${title} · 대표 이미지 없음`}>
      {Array.from(title.trim())[0] ?? '◇'}
    </span>
  );
}

/** Stable app-owned portraits. Themes can arrange them but cannot replace their behavior. */
export const ReaderGallery = memo(function ReaderGallery({
  bot,
  persona,
}: {
  bot: Content;
  persona?: Content | null;
}) {
  const [expanded, setExpanded] = useState<'bot' | 'persona' | null>(null);
  const selected = expanded === 'bot' ? bot : expanded === 'persona' ? persona : null;
  const selectedUrl = contentPortraitUrl(selected);
  return (
    <>
      <aside className="reader-gallery" data-uimori-part="gallery" aria-label="등장인물 갤러리">
        <div className="reader-gallery-heading" aria-hidden="true">
          <span>PORTRAITS</span>
          <Sparkles size={13} aria-hidden="true" />
        </div>
        {(
          [
            ['bot', bot, '이야기의 얼굴'],
            ['persona', persona, '나의 페르소나'],
          ] as const
        ).map(([role, content, label]) => {
          if (!content) return null;
          const url = contentPortraitUrl(content);
          return (
            <figure
              className="reader-gallery-card"
              data-uimori-part={`${role}-portrait`}
              key={role}
            >
              <button
                className="reader-portrait-button"
                type="button"
                aria-label={`${content.title} 대표 이미지 확대`}
                disabled={!url}
                onClick={() => setExpanded(role)}
              >
                <Portrait key={url} url={url} title={content.title} />
              </button>
              <figcaption>
                <small>{label}</small>
                <strong>{content.title}</strong>
              </figcaption>
            </figure>
          );
        })}
        <p className="reader-gallery-caption">이미지를 눌러 크게 감상해요</p>
      </aside>
      <Dialog
        open={!!selected}
        onClose={() => setExpanded(null)}
        title={`${selected?.title ?? '등장인물'} 대표 이미지`}
        className="reader-portrait-dialog"
      >
        {selected && <Portrait key={selectedUrl} url={selectedUrl} title={selected.title} />}
      </Dialog>
    </>
  );
});
