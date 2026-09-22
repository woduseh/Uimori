import type { ThemeDefinition } from './themes.js';

/** Portable CSS/slot presentation. Portrait data and interaction remain owned by the reader. */
export const liquidGallery: ThemeDefinition = {
  title: 'Liquid Gallery',
  description:
    '긴 소설을 위한 잉크빛 리더와 은은한 유리 조작부. 대표 이미지는 배경까지 원본 비율로 감상해요.',
  colors: {
    dark: {
      bg: '#11131e',
      nav: '#151724',
      panel: '#1a1d2a',
      surface: '#252939',
      'surface-raised': '#292e40',
      hover: '#30364b',
      line: '#383e53',
      'input-border': '#68718b',
      text: '#e5e7ee',
      muted: '#acb4ca',
      faint: '#9da7c0',
      accent: '#c7bafa',
      'accent-ink': '#24203b',
      'accent-soft': '#343047',
      user: '#242738',
      error: '#ffb5b5',
      'error-ink': '#431c24',
      'error-bg': '#38232b',
      shade: '#080b1680',
    },
    light: {
      bg: '#eeedf4',
      nav: '#f2f0f7',
      panel: '#fbfaf8',
      surface: '#eae8f1',
      'surface-raised': '#f4f2f9',
      hover: '#e1deed',
      line: '#d4d2df',
      'input-border': '#85839c',
      text: '#303143',
      muted: '#626378',
      faint: '#6a687f',
      accent: '#695292',
      'accent-ink': '#ffffff',
      'accent-soft': '#eee7f6',
      user: '#f0edf5',
      error: '#9b293e',
      'error-ink': '#ffffff',
      'error-bg': '#fbecef',
      shade: '#30294a24',
    },
  },
  appCss: `
/* No wallpaper, live color extraction, external font, or full-screen blur. */
:root { --lg-gleam: #c7bafa21; --lg-cool: #8faee918; }
:root[data-theme="light"] { --lg-gleam: #b6a0e72b; --lg-cool: #98bee421; }
.app-shell { background: var(--bg); }
.story-workspace {
  container: liquid-workspace / inline-size;
  background: var(--panel);
}
.sidebar {
  background: radial-gradient(ellipse at 10% 0%, var(--lg-gleam), transparent 65%), var(--nav);
  border-right-color: color-mix(in srgb, var(--line) 65%, transparent);
}
.brand { letter-spacing: -.8px; }
.sidebar .bot-branch-toggle { border-radius: 12px; }
.sidebar .bot-choice-avatar { border-radius: 9px; }
.sidebar .chat-link.selected {
  background: linear-gradient(105deg, var(--accent-soft), var(--surface));
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
  border-radius: 11px;
}
.sidebar .nav-button { border-radius: 11px; }
.workspace-header {
  background: linear-gradient(100deg, var(--lg-gleam), transparent 60%), var(--nav);
  border-bottom-color: var(--line);
  padding-block: 10px;
}
.header-title h1 { font-weight: 600; letter-spacing: -.025em; }
.header-title small { color: var(--muted); }
.model-chip { background: var(--surface); border-radius: 999px; }
.reader-stage { flex-direction: column; background: var(--panel); }
.reader-scrollport { background: var(--panel); }
.reader-stage.has-scenes > .reader-scrollport { padding-inline: 48px 12px; }
.reader {
  width: min(100%, calc(var(--reading-width) + 64px));
  padding: 32px 32px 72px;
}
.source + .source { margin-top: 48px; padding-top: 34px; }
.reader .request-message-wrap { position: relative; margin-bottom: 24px; }
/* Keep memo controls beside the label instead of reserving an empty row below short input. */
.reader .request-message-actions { position: absolute; top: 10px; right: 10px; }
.reader .request-message {
  max-width: 100%; width: 100%; margin: 0;
  padding: 15px 20px; border: 1px solid var(--line);
  border-left: 2px solid var(--accent); border-radius: 4px 12px 12px 4px;
  background: var(--user); color: var(--muted); font-size: 13px;
}
.reader .request-message:not(.request-message-editor)::before {
  content: '연출 메모'; display: block; margin-bottom: 7px;
  min-height: 28px; line-height: 28px; padding-right: 96px;
  color: var(--accent); font-size: 11px; font-weight: 650; letter-spacing: .04em;
}
.reader .source-actions {
  margin: 0; padding: 0; border: 0; justify-content: flex-end;
}
.reader .scene-header { margin: 0; }
.reader .folio { color: var(--accent); }
.reader .prose h1, .reader .prose h2 { letter-spacing: -.025em; }
.reader .prose blockquote { border-left-color: var(--accent); }
.reader .segmented { border-radius: 999px; overflow: hidden; }
.reader .segmented button { border-radius: 999px; }
.scene-navigator { left: 0; }
.composer-dock {
  max-width: none; margin: 0;
  padding: 12px 32px max(14px, env(safe-area-inset-bottom));
  background: linear-gradient(0deg, var(--nav), var(--panel));
  border-top: 1px solid color-mix(in srgb, var(--line) 65%, transparent);
}
.composer-dock > * { max-width: var(--reading-width); margin-inline: auto; }
.composer {
  border: 1px solid var(--input-border); border-radius: 22px; padding: 7px;
  background: linear-gradient(130deg, var(--lg-gleam), transparent 65%), var(--surface-raised);
  box-shadow: 0 8px 24px var(--shade), inset 0 1px 0 color-mix(in srgb, var(--text) 10%, transparent);
}
.composer:focus-within {
  border-color: var(--accent); outline: 2px solid var(--accent-soft); outline-offset: 2px;
}
.composer .send-button {
  border-radius: 50%; background: var(--accent); color: var(--accent-ink);
  box-shadow: inset 0 1px 0 #ffffff40;
}
/* Glass only on the small composer surface, never on paragraphs or portraits. */
@supports (backdrop-filter: blur(12px)) {
  .composer {
    background: linear-gradient(130deg, var(--lg-gleam), transparent 65%), color-mix(in srgb, var(--surface-raised) 92%, transparent);
    backdrop-filter: blur(12px);
  }
}
.reader-gallery {
  display: flex; order: -1; align-items: center; gap: 16px;
  flex: 0 0 auto; padding: 10px 24px;
  background: linear-gradient(100deg, var(--lg-gleam), var(--lg-cool)), var(--nav);
  border-bottom: 1px solid var(--line);
}
.reader-gallery-heading, .reader-gallery-caption { display: none; }
.reader-gallery-card {
  display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;
}
.reader-gallery .reader-portrait-button { width: 44px; flex: 0 0 44px; min-height: 48px; border-radius: 8px; }
.reader-gallery .reader-portrait-button img { width: 100%; height: 48px; object-fit: contain; }
.reader-gallery .reader-portrait-empty { min-height: 48px; font-size: 20px; }
.reader-gallery figcaption { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.reader-gallery figcaption small { color: var(--muted); font-size: 10px; letter-spacing: .04em; }
.reader-gallery figcaption strong {
  color: var(--text); font-size: 13px; font-weight: 550;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.reader-portrait-button:hover:not(:disabled) { filter: none; border-color: var(--accent); }
.reader-portrait-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
/* Available workspace width, not screen width: opening helper/settings never crushes the text. */
@container liquid-workspace (min-width: 1050px) {
  .reader-stage { flex-direction: row; }
  .reader-gallery {
    order: 1; flex: 0 0 246px; width: 246px;
    flex-direction: column; align-items: stretch; gap: 22px;
    padding: 28px 22px 18px;
    border-bottom: 0; border-left: 1px solid var(--line);
    overflow-y: auto; scrollbar-width: thin;
    background: radial-gradient(ellipse at 90% 0%, var(--lg-gleam), transparent 65%), var(--nav);
  }
  .reader-gallery-heading {
    display: flex; justify-content: space-between; color: var(--muted);
    font-size: 10px; letter-spacing: .2em;
  }
  .reader-gallery-heading > svg { color: var(--accent); }
  .reader-gallery-card { flex: 0 0 auto; }
  .reader-gallery-card[data-uimori-part="bot-portrait"] { display: block; }
  .reader-gallery-card[data-uimori-part="bot-portrait"] .reader-portrait-button {
    width: 100%; border-radius: 14px; padding: 5px;
    background: var(--surface-raised); box-shadow: 0 10px 28px var(--shade);
  }
  .reader-gallery-card[data-uimori-part="bot-portrait"] img {
    width: 100%; height: auto; max-height: max(140px, calc((100dvh - 350px) * .72));
    object-fit: contain; border-radius: 9px;
  }
  .reader-gallery-card[data-uimori-part="bot-portrait"] figcaption { margin-top: 16px; gap: 5px; }
  .reader-gallery-card[data-uimori-part="bot-portrait"] figcaption strong {
    font-size: 22px; line-height: 1.35; white-space: normal; overflow-wrap: anywhere;
  }
  .reader-gallery-card[data-uimori-part="persona-portrait"] {
    border-top: 1px solid var(--line); padding-top: 22px;
  }
  .reader-gallery-card[data-uimori-part="persona-portrait"] .reader-portrait-button {
    width: 68px; flex-basis: 68px; border-radius: 10px;
  }
  .reader-gallery-card[data-uimori-part="persona-portrait"] img { height: auto; max-height: 110px; }
  .reader-gallery-caption {
    display: block; margin: auto 0 0; padding-top: 24px;
    color: var(--faint); font-size: 11px; text-align: center;
  }
  .app-shell:not(.focus-reading) .story-workspace:has(.reader-gallery) .composer-dock {
    width: calc(100% - 246px); align-self: flex-start;
  }
}
.focus-reading .reader-gallery { display: none; }
.focus-reading .composer-dock { width: 100%; }
@media (max-width: 760px) {
  .workspace-header { padding: 8px 12px; }
  .reader-stage.has-scenes > .reader-scrollport { padding-inline: 0; }
  .reader { padding: 24px 20px 84px; }
  .reader-gallery { padding: 8px 16px; gap: 10px; }
  .reader .request-message { padding: 12px 14px; }
  .composer-dock { padding: 8px 12px max(8px, env(safe-area-inset-bottom)); }
  .composer { border-radius: 19px; padding: 5px; }
}
@media (prefers-reduced-motion: reduce) {
  .reader-gallery *, .composer { transition: none; animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .composer { backdrop-filter: none; background: var(--surface-raised); }
}
`,
  messageCss: `
/* Authored bot HTML and explicit reading preferences retain precedence. */
:where([data-uimori-prose]) { color: var(--text); }
:where(h1, h2) { letter-spacing: -.025em; }
:where(blockquote) { border-left-color: var(--accent); }
`,
  templateHtml:
    '<slot name="request"></slot><section class="lg-manuscript"><header class="lg-tools"><div class="lg-heading"><slot name="heading"></slot></div><div class="lg-actions"><slot name="actions"></slot></div></header><slot name="body"></slot></section>',
  templateCss: `
.lg-manuscript { min-width: 0; background: var(--panel); color: var(--text); }
.lg-tools { display: flex; align-items: center; gap: 12px; margin: 0 0 24px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.lg-heading { flex: 1; min-width: 0; }
.lg-actions { flex: 0 0 auto; }
@media (max-width: 600px) { .lg-tools { display: block; } .lg-actions { margin-top: 6px; } }
`,
};
