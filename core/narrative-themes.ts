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
const paperGrain =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")";
const postmark =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 60' fill='none' stroke='black' stroke-width='2.5'%3E%3Ccircle cx='30' cy='30' r='26'/%3E%3Ccircle cx='30' cy='30' r='19' stroke-width='1.2'/%3E%3Cpath d='M17 25h26M17 35h26' stroke-width='1.6'/%3E%3Cpath d='M58 18q6-6 12 0t12 0t12 0M58 30q6-6 12 0t12 0t12 0M58 42q6-6 12 0t12 0t12 0'/%3E%3C/svg%3E\")";
const paperclip =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m16 6-8.414 8.586a2 2 0 0 0 2.828 2.828l8.414-8.586a4 4 0 0 0-5.656-5.656l-8.415 8.585a6 6 0 1 0 8.486 8.486'/%3E%3C/svg%3E\")";
const letterMargin = (left: number) =>
  `linear-gradient(to right, transparent ${left}px, var(--margin-rule) ${left}px ${left + 1}px, transparent ${left + 1}px ${left + 4}px, var(--margin-rule) ${left + 4}px ${left + 5}px, transparent ${left + 5}px)`;
const letterPaper = (left: number) =>
  `${paperGrain}, radial-gradient(ellipse at 50% 35%, transparent 55%, color-mix(in srgb, var(--accent) 12%, transparent) 100%), ${letterMargin(left)}, var(--panel)`;
export const letterTheme: ThemeDefinition = {
  title: '편지지',
  description: '작은 인물 사진과 섬세한 줄, 여백이 있는 한 장의 편지',
  colors: colors('cream'),
  appCss:
    commonApp +
    `
.reader { width: min(100%, calc(var(--reading-width) + 96px)); }
@container narrative-workspace (min-width: 851px) { .reader [data-uimori-body-scroll] { max-height: clamp(220px, calc(100dvh - 630px - var(--control-h) - 12px), 520px); } }
/* The request is a ruled note clipped above the letter. */
.reader .request-message:not(form) {
  position: relative;
  margin-inline: 4px;
  padding: 16px 20px 12px 24px;
  border: var(--hairline) solid var(--line);
  border-radius: var(--radius-small);
  color: var(--text);
  background:
    repeating-linear-gradient(transparent 0 calc(1.8em - 1px), color-mix(in srgb, var(--accent) 22%, transparent) calc(1.8em - 1px) 1.8em) 0 16px,
    linear-gradient(to right, transparent 12px, color-mix(in srgb, var(--error) 35%, transparent) 12px 13px, transparent 13px),
    var(--panel);
  transform: rotate(-0.6deg);
}
.reader .request-message:not(form)::before {
  content: '';
  position: absolute;
  top: -12px;
  left: 28px;
  width: 16px;
  height: 36px;
  background: var(--muted);
  mask: ${paperclip} no-repeat center / contain;
  transform: rotate(10deg);
  pointer-events: none;
}
/* The portrait is a tilted postage stamp, cancelled by a postmark. */
.scene-portraits { display: block; }
.scene-portraits [data-uimori-part="bot-portrait"] { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 112px; transform: rotate(3deg); }
.scene-portraits [data-uimori-part="bot-portrait"]::after {
  content: '';
  position: absolute;
  top: 28px;
  left: -44px;
  width: 104px;
  height: 62px;
  background: color-mix(in srgb, var(--accent-text) 55%, transparent);
  mask: ${postmark} no-repeat center / contain;
  transform: rotate(-16deg);
  pointer-events: none;
}
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button {
  --perforation: 4px;
  width: 100%;
  padding: calc(var(--perforation) * 2);
  border: 0;
  border-radius: 0;
  background: color-mix(in srgb, var(--panel), var(--text) 12%);
  mask:
    radial-gradient(var(--perforation), #0000 98%, #000) round calc(var(--perforation) * -1.5) calc(var(--perforation) * -1.5) / calc(var(--perforation) * 3) calc(var(--perforation) * 3),
    linear-gradient(#000 0 0) no-repeat 50% / calc(100% - var(--perforation) * 3) calc(100% - var(--perforation) * 3);
}
.scene-portraits [data-uimori-part="bot-portrait"] img { aspect-ratio: 3 / 4; height: auto; object-fit: cover; object-position: center 20%; outline: var(--hairline) solid color-mix(in srgb, var(--text) 25%, transparent); }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-empty { min-height: 0; aspect-ratio: 3 / 4; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { padding: 0; text-align: center; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: var(--font-small); color: var(--muted); font-style: italic; letter-spacing: 0.04em; }
` +
    mobilePortrait +
    `
@container narrative-workspace (max-width: 850px) {
  .scene-portraits { display: block; }
  .scene-portraits [data-uimori-part="bot-portrait"] { display: flex; width: 80px; }
  .scene-portraits [data-uimori-part="bot-portrait"]::after { top: 20px; left: -32px; width: 76px; height: 46px; }
  .scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { --perforation: 3px; width: 100%; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { width: 100%; height: auto; max-height: none; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { padding: 0; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: var(--font-small); }
  .reader .request-message:not(form) { padding: 14px 16px 10px 24px; }
}
`,
  messageCss,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><div class="copy"><header class="letterhead"><div class="heading"><slot name="heading"></slot></div><aside class="portrait"><slot name="portrait"></slot></aside></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
/* Grained paper with a double margin rule, an airmail edge, sheets peeking out below as hard
   edges and a wax seal where the letter closes. */
.manuscript {
  --margin-rule: color-mix(in srgb, var(--error) 40%, transparent);
  margin-bottom: 28px;
  padding: 48px 48px 28px 56px;
  border: var(--hairline) solid var(--line);
  background: ${letterPaper(32)};
  box-shadow: 0 6px 0 -4px var(--panel), 0 6px 0 -3.5px var(--line), 0 12px 0 -8px var(--panel), 0 12px 0 -7.5px var(--line);
}
.manuscript::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 8px;
  background: repeating-linear-gradient(-45deg, var(--accent) 0 12px, transparent 12px 18px, color-mix(in srgb, var(--accent), var(--info) 70%) 18px 30px, transparent 30px 36px);
  opacity: 0.85;
}
.manuscript::after {
  content: '\\2766\\FE0E';
  font-family: 'Segoe UI Symbol', 'Noto Sans Symbols 2', serif;
  position: absolute;
  right: 44px;
  bottom: -24px;
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 47% 53% 50% 50% / 52% 46% 54% 48%;
  --wax: color-mix(in srgb, var(--error-solid) 60%, var(--accent));
  background: radial-gradient(circle at 34% 30%, color-mix(in srgb, var(--wax), white 30%), var(--wax) 48%, color-mix(in srgb, var(--wax), black 40%));
  box-shadow: inset 0 0 0 5px color-mix(in srgb, var(--wax), black 22%), inset 0 0 0 6px color-mix(in srgb, var(--wax), white 25%);
  color: color-mix(in srgb, var(--wax), white 55%);
  text-shadow: 0 1px 0 color-mix(in srgb, var(--wax), black 45%);
  font-size: 24px;
  line-height: 1;
  transform: rotate(-12deg);
  pointer-events: none;
}
.letterhead { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 3px double color-mix(in srgb, var(--accent) 45%, var(--line)); }
.letterhead::after {
  content: '\\2766\\FE0E';
  font-family: 'Segoe UI Symbol', 'Noto Sans Symbols 2', serif;
  position: absolute;
  left: 50%;
  bottom: 0;
  padding-inline: 12px;
  background: var(--panel);
  color: var(--accent-text);
  font-size: 18px;
  line-height: 1;
  transform: translate(-50%, 55%);
}
.heading { border: 0; padding: 0; margin: 0; }
.actions { border-top: var(--hairline) dashed color-mix(in srgb, var(--accent) 45%, var(--line)); padding-right: 96px; }
@container narrative-scene (max-width: 520px) {
  .manuscript { padding: 32px 20px 20px 40px; background: ${letterPaper(24)}; }
  .manuscript::after { right: 24px; bottom: -20px; width: 44px; height: 44px; font-size: 20px; }
  .letterhead { gap: 16px; margin-bottom: 24px; padding-bottom: 16px; }
  .actions { padding-right: 72px; }
}
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
