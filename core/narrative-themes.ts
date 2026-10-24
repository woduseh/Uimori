import type { ThemeDefinition } from './themes.js';
import { BUILTIN_PALETTES } from './theme-palettes.js';

/** Layouts consume app-owned portrait slots; exported themes never embed a character or URL. */
const commonApp = `
.story-workspace { container: narrative-workspace / inline-size; background: var(--bg); }
.reader-stage > [data-uimori-part="gallery"] { display: none; }
.reader:has([data-uimori-part="scene-portraits"]) > .story-context { display: none; }
.reader-scrollport { background: var(--bg); container: narrative-reader / size; }
.reader { width: min(100%, calc(var(--reading-width) + 340px)); padding: 32px 24px 48px; }
.source + .source { margin-top: 32px; padding-top: 0; border-top: 0; }
.reader .request-message { max-width: 100%; border: var(--hairline) solid var(--line); border-radius: var(--radius-control); background: var(--user); }
.reader .source-actions { border: 0; margin: 0; padding-block: 8px; }
.reader .scene-header { margin: 0; }
.scene-portraits { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.scene-portraits .reader-gallery-heading, .scene-portraits .reader-gallery-caption { display: none; }
.scene-portraits figcaption { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; }
.scene-portraits figcaption small { color: var(--muted); font-size: var(--font-small); }
.scene-portraits figcaption strong { color: var(--text); font-size: var(--font-heading); line-height: 1.4; overflow-wrap: anywhere; font-weight: 500; }
.scene-portraits [data-uimori-part="persona-portrait"] { display: flex; gap: 10px; align-items: center; }
.scene-portraits [data-uimori-part="persona-portrait"] .reader-portrait-button { width: 44px; flex: 0 0 44px; border-radius: 50%; }
.scene-portraits [data-uimori-part="persona-portrait"] img { height: 44px; object-fit: cover; }
.scene-portraits [data-uimori-part="persona-portrait"] .reader-portrait-empty { min-height: 44px; font-size: var(--font-heading); }
.scene-portraits [data-uimori-part="persona-portrait"] figcaption { padding: 0; }
.scene-portraits [data-uimori-part="persona-portrait"] figcaption strong { font-size: var(--font-small); }
.scene-portraits .reader-portrait-button:focus-visible { outline: var(--hairline) solid var(--focus-ring); outline-offset: 4px; }
.scene-portraits figcaption small, .scene-portraits [data-uimori-part="persona-portrait"] { display: none; }
.request-portraits { display: block; width: 56px; }
.request-portraits .reader-gallery-heading, .request-portraits .reader-gallery-caption, .request-portraits figcaption small { display: none; }
.request-portraits .reader-portrait-button { width: 48px; height: 48px; border-radius: 50%; margin-inline: auto; }
.request-portraits img { width: 48px; height: 48px; object-fit: cover; object-position: center 20%; }
.request-portraits .reader-portrait-empty { min-height: 48px; font-size: var(--font-heading); }
.request-portraits figcaption { padding-top: 4px; text-align: center; font-size: var(--font-small); line-height: 1.4; color: var(--muted); overflow-wrap: anywhere; }
.request-portraits figcaption strong { font-weight: 500; }
/* Reserve the collapsed usage disclosure: one control row plus its block margins. */
.reader [data-uimori-body-scroll] { max-height: clamp(220px, calc(100dvh - 560px - var(--control-h) - 12px), 520px); min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--muted) transparent; padding-right: 8px; }
.reader [data-uimori-body-scroll]:focus-visible { outline: var(--hairline) solid var(--focus-ring); outline-offset: 3px; }
@container narrative-workspace (max-width: 850px) { .reader [data-uimori-body-scroll] { max-height: clamp(220px, 42dvh, 400px); } }
.composer-dock { background: var(--bg); }
.composer { border-radius: var(--radius-panel); background: var(--panel); border: var(--hairline) solid var(--line); }
.focus-reading [data-uimori-part="scene-portraits"] { display: none; }
@media (max-width: 760px) {
  .reader-stage.has-scenes > .reader-scrollport { padding-inline: 0; }
  .reader { padding: 18px 12px 24px; }
  .reader-stage:has(> .scene-mini-navigator, > .scene-latest-floating) .reader { padding-bottom: 72px; }
  .source + .source { margin-top: 24px; }
}
`;
const mobilePortrait = `
@container narrative-workspace (max-width: 850px) {
  .scene-portraits { display: block; }
  .scene-portraits [data-uimori-part="bot-portrait"] { display: block; width: auto; flex: initial; }
  .scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { width: 100%; flex: initial; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { width: 100%; height: min(220px, 28dvh); max-height: 220px; object-fit: cover; object-position: center 18%; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { position: static; padding: 10px 4px; text-align: center; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: var(--font-heading); }
  .request-portraits { width: auto; }
  .request-portraits [data-uimori-part="persona-portrait"] { display: flex; align-items: center; gap: 8px; }
  .request-portraits .reader-portrait-button, .request-portraits img { width: 44px; height: 44px; }
  .request-portraits .reader-portrait-empty { min-height: 44px; }
  .request-portraits figcaption { padding: 0; }
  /* Allocate the body from the actual reader space after the header/composer,
     not a fixed deduction from the device viewport. Portraits remain page-scrollable. */
  .reader [data-uimori-body-scroll] { max-height: clamp(200px, 60cqh, 560px); }
}
`;
const commonTemplate = `
:host { container: narrative-scene / inline-size; }
.manuscript { position: relative; min-width: 0; color: var(--text); background: var(--panel); }
.copy { min-width: 0; }
.heading { border-bottom: var(--hairline) solid var(--line); padding-bottom: 16px; margin-bottom: 24px; }
.actions { border-top: var(--hairline) solid var(--line); margin-top: 24px; }
.portrait { min-width: 0; }
.request-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; }
.request-persona { padding-top: 4px; }
@container narrative-scene (max-width: 680px) {
  .request-row { display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
  .request-persona { order: -1; align-self: flex-end; padding-top: 0; }
}
:host([data-has-request-persona="false"]) .request-persona { display: none; }
:host([data-has-portrait="false"]) .portrait, :host-context(.focus-reading) .portrait { display: none; }
:host([data-has-portrait="false"]) .manuscript, :host-context(.focus-reading) .manuscript { display: block; }
`;
const messageCss = `
:where([data-uimori-prose]) { color: var(--text); }
:where(blockquote) { border-left-color: var(--line); color: var(--text); }
`;
function colors(id: string) {
  return BUILTIN_PALETTES.find((palette) => palette.id === id)!.colors;
}
export const cinematicTheme: ThemeDefinition = {
  title: '시네마틱',
  description: '가장자리로 스며드는 등장인물과 긴 이야기를 담은 장면',
  colors: colors('midnight'),
  appCss:
    commonApp +
    `
/* The portrait shares the scene edge, rather than occupying a separate identity card. */
.scene-portraits { position: relative; display: block; }
.scene-portraits [data-uimori-part="bot-portrait"] { position: relative; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border: 0; border-radius: 0; background: transparent; }
.scene-portraits [data-uimori-part="bot-portrait"] img { width: 100%; height: auto; max-height: 680px; object-fit: cover; object-position: center 20%; mask-image: linear-gradient(to right, transparent, black 22%), linear-gradient(to bottom, black 65%, transparent 100%); mask-composite: intersect; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { position: absolute; left: 28px; bottom: 26px; padding: 0; pointer-events: none; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: var(--font-heading); }
.scene-portraits figcaption small { display: none; }
.scene-portraits [data-uimori-part="persona-portrait"] { position: absolute; right: 20px; bottom: 24px; gap: 8px; }
.scene-portraits [data-uimori-part="persona-portrait"] figcaption { display: none; }
.scene-portraits [data-uimori-part="persona-portrait"] .reader-portrait-button { border: var(--hairline) solid var(--line); }
@container narrative-workspace (max-width: 850px) {
  .scene-portraits [data-uimori-part="bot-portrait"] img { height: 130px; object-fit: cover; object-position: center 22%; mask-image: linear-gradient(to bottom, black 65%, transparent); }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { left: 20px; bottom: 16px; }
  .scene-portraits [data-uimori-part="persona-portrait"] { right: 18px; bottom: 12px; }
}
` +
    mobilePortrait,
  messageCss,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div><aside class="portrait"><slot name="portrait"></slot></aside></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { display: grid; grid-template-columns: minmax(0, 60%) minmax(0, 40%); gap: 0; padding: 0; border: var(--hairline) solid var(--line); }
.copy { padding: 28px 20px 24px 32px; }
.portrait { align-self: start; padding: 0; }
@container narrative-scene (max-width: 680px) {
  .manuscript { display: flex; flex-direction: column; padding: 0; gap: 0; }
  .copy { padding: 12px 18px 24px; }
  .portrait { order: -1; width: 100%; }
}
`,
};
export const letterTheme: ThemeDefinition = {
  title: '편지지',
  description: '작은 인물 사진과 섬세한 줄, 여백이 있는 한 장의 편지',
  colors: colors('cream'),
  appCss:
    commonApp +
    `
.reader { width: min(100%, calc(var(--reading-width) + 96px)); }
@container narrative-workspace (min-width: 851px) { .reader [data-uimori-body-scroll] { max-height: clamp(220px, calc(100dvh - 650px - var(--control-h) - 12px), 450px); } }
.scene-portraits { flex-direction: row; align-items: center; gap: 28px; }
.scene-portraits [data-uimori-part="bot-portrait"] { display: flex; align-items: center; gap: 18px; flex: 0 1 auto; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { width: 88px; flex: 0 0 88px; border-radius: var(--radius-small); background: var(--surface); }
.scene-portraits [data-uimori-part="bot-portrait"] img { height: 88px; object-fit: cover; object-position: center 20%; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-empty { min-height: 88px; }
.scene-portraits figcaption { padding: 0; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: var(--font-heading); }
.scene-portraits [data-uimori-part="persona-portrait"] { padding-left: 24px; }
@media (max-width: 760px) {
  .scene-portraits { gap: 16px; flex-wrap: wrap; }
  .scene-portraits [data-uimori-part="persona-portrait"] { padding-left: 14px; }
  .scene-portraits [data-uimori-part="persona-portrait"] figcaption { display: none; }
  .scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { width: 72px; flex-basis: 72px; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { height: 72px; }
}
` +
    mobilePortrait,
  messageCss,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><header class="portrait"><slot name="portrait"></slot></header><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { border: var(--hairline) solid var(--line); }
.portrait { padding: 18px 28px; border-bottom: var(--hairline) solid var(--line); background: var(--surface); }
.copy { padding: 28px 32px; }
@container narrative-scene (max-width: 520px) { .copy { padding: 22px 18px; } .portrait { padding: 0; } }
`,
};
export const scrapbookTheme: ThemeDefinition = {
  title: '스크랩북',
  description: '테이프로 붙인 인물 사진과 나란히 놓인 기록',
  colors: colors('charcoal'),
  appCss:
    commonApp +
    `
.scene-portraits [data-uimori-part="bot-portrait"] { position: relative; padding: 12px 12px 20px; background: var(--surface-raised); border: var(--hairline) solid var(--line); margin: 10px 4px 14px; }
.scene-portraits [data-uimori-part="bot-portrait"]::before { content: ''; position: absolute; width: 56px; height: 16px; top: -8px; left: calc(50% - 28px); background: var(--accent-soft); border: var(--hairline) solid var(--accent-line); border-radius: var(--radius-small); z-index: 1; pointer-events: none; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border: 0; border-radius: 0; }
.scene-portraits [data-uimori-part="bot-portrait"] img { max-height: 520px; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { text-align: right; padding: 14px 4px 0; }
@container narrative-workspace (max-width: 850px) {
  .scene-portraits { flex-direction: row; align-items: center; gap: 20px; }
  .scene-portraits [data-uimori-part="bot-portrait"] { width: 130px; flex: 0 0 130px; padding: 8px 8px 14px; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { height: 112px; object-fit: cover; object-position: center 20%; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: var(--font-body); }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption small { display: none; }
  .scene-portraits [data-uimori-part="persona-portrait"] { flex-direction: column; align-items: flex-start; }
}
` +
    mobilePortrait,
  messageCss,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><aside class="portrait"><slot name="portrait"></slot></aside><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { display: grid; grid-template-columns: minmax(180px, 31%) minmax(0, 1fr); gap: 36px; padding: 32px; border: var(--hairline) solid var(--line); }
.portrait { padding-right: 26px; align-self: start; }
.heading { border-bottom-style: dashed; }
@container narrative-scene (max-width: 680px) {
  .manuscript { display: block; padding: 22px 18px; }
  .portrait { border: 0; padding: 0 8px 16px; max-width: none; margin-inline: auto; }
}
`,
};

export const classicFrameTheme: ThemeDefinition = {
  title: '클래식 프레임',
  description: '얇은 사각 프레임 안에 인물과 이야기를 나란히 담은 정갈한 장면',
  colors: colors('midnight'),
  appCss:
    commonApp +
    `
.scene-portraits [data-uimori-part="bot-portrait"] { padding: 8px; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border-radius: 0; border: 0; }
.scene-portraits [data-uimori-part="bot-portrait"] img { width:100%; max-height:520px; object-fit:contain; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { padding:12px 8px 8px; text-align:center; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size:var(--font-heading); }
` +
    mobilePortrait,
  messageCss,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><aside class="portrait"><slot name="portrait"></slot></aside><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { display:grid; grid-template-columns:minmax(180px,29%) minmax(0,1fr); gap:18px; padding:16px; border:var(--hairline) solid var(--line); }
.portrait { align-self:start; }
.copy { padding:20px; }
.heading { padding-bottom:12px; margin-bottom:20px; }
.actions { margin-top:20px; }
@container narrative-scene (max-width:680px) { .manuscript { display:block; padding:10px; } .portrait { margin-bottom:12px; } .copy { padding:18px 14px; } }
`,
};
