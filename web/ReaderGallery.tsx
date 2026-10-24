import { t, useI18n } from './i18n.js';
import { memo, useState, type ReactNode } from 'react';
import type { Content } from '../core/product.js';
import { contentPortraitUrl } from './content-portrait.js';
import { Dialog } from './Dialog.js';
import './reader-gallery.css';

function Portrait({ url, title }: { url: string; title: string }) {
  useI18n();
  const [failed, setFailed] = useState(false);
  return url && !failed ? (
    <img src={url} alt={title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  ) : (
    <span
      className="reader-portrait-empty"
      role="img"
      aria-label={t('reader.valueNoPortraitImage', { v0: title })}
    >
      {Array.from(title.trim())[0] ?? '◇'}
    </span>
  );
}

function PortraitDialog({
  open,
  onClose,
  url,
  title,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  title: string;
}) {
  useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('reader.valuePortraitImage', { v0: title })}
      className="reader-portrait-dialog"
    >
      {open && <Portrait key={url} url={url} title={title} />}
    </Dialog>
  );
}

/** The compact bot header shares the gallery's original-image viewer. */
export function ReaderPortraitButton({
  url,
  title,
  children,
}: {
  url: string;
  title: string;
  children: ReactNode;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="reader-bot-avatar"
        aria-label={t('reader.enlargeValuePortraitImage', { v0: title })}
        disabled={!url}
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <PortraitDialog open={open} onClose={() => setOpen(false)} url={url} title={title} />
    </>
  );
}

/** Stable app-owned portraits. Themes can arrange them but cannot replace their behavior. */
export const ReaderGallery = memo(function ReaderGallery({
  bot,
  persona,
  scene = false,
  requestPersona = false,
}: {
  scene?: boolean;
  requestPersona?: boolean;
  bot: Content;
  persona?: Content | null;
}) {
  useI18n();
  const [expanded, setExpanded] = useState<'bot' | 'persona' | null>(null);
  const selected = expanded === 'bot' ? bot : expanded === 'persona' ? persona : null;
  const selectedUrl = contentPortraitUrl(selected);
  return (
    <>
      <aside
        className={`reader-gallery${requestPersona ? ' request-portraits' : scene ? ' scene-portraits' : ''}`}
        data-uimori-part={
          requestPersona ? 'request-portrait-group' : scene ? 'portrait-group' : 'gallery'
        }
        aria-label={t('reader.characterGallery')}
      >
        {(
          [
            ['bot', bot, t('reader.bot')],
            ['persona', persona, t('reader.myPersona')],
          ] as const
        ).map(([role, content, label]) => {
          if (!content || (requestPersona && role !== 'persona')) return null;
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
                aria-label={t('reader.enlargeValuePortraitImage', { v0: content.title })}
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
      </aside>
      <PortraitDialog
        open={!!selected}
        onClose={() => setExpanded(null)}
        url={selectedUrl}
        title={selected?.title ?? t('reader.character')}
      />
    </>
  );
});
