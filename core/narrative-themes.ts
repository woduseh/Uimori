import type { ThemeDefinition } from './themes.js';
import { BUILTIN_PALETTES } from './theme-palettes.js';
import { builtinThemeAsset } from './builtin-theme-assets.js';

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
  assets: [
    builtinThemeAsset('title', 'GowunBatang-Regular.woff2'),
    builtinThemeAsset('hand', 'NanumPenScript-Regular.woff2'),
    builtinThemeAsset('corner', 'letter-corner.webp'),
    builtinThemeAsset('divider', 'letter-divider.webp'),
  ],
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
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-family: var(--theme-font-hand), cursive; font-size: 18px; font-weight: 400; color: var(--muted); }
/* Decorative text takes the theme's own fonts; the manuscript keeps the reader's font. */
.reader .request-message:not(form) p { font-family: var(--theme-font-hand), cursive; font-size: 19px; line-height: calc(var(--font-body) * 1.8); }
.reader [data-uimori-part="heading"] .folio { font-family: var(--theme-font-title), serif; font-size: var(--font-heading); font-weight: 400; letter-spacing: 0.06em; }
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
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: 16px; }
  .reader .request-message:not(form) { padding: 14px 16px 10px 24px; }
}
`,
  messageCss:
    messageCss +
    `
:where(h1, h2, h3) { font-family: var(--theme-font-title), serif; font-weight: 400; letter-spacing: 0.02em; }
`,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><i class="corner top-left" aria-hidden="true"></i><i class="corner top-right" aria-hidden="true"></i><i class="corner bottom-left" aria-hidden="true"></i><i class="corner bottom-right" aria-hidden="true"></i><div class="copy"><header class="letterhead"><div class="heading"><slot name="heading"></slot></div><aside class="portrait"><slot name="portrait"></slot></aside></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
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
.letterhead { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; margin-bottom: 32px; padding-bottom: 20px;
  --rule: color-mix(in srgb, var(--accent) 45%, var(--line));
  --rule-gap: 116px;
  --rule-line: linear-gradient(to right, var(--rule) calc(50% - var(--rule-gap)), transparent calc(50% - var(--rule-gap)) calc(50% + var(--rule-gap)), var(--rule) calc(50% + var(--rule-gap)));
  background: var(--rule-line) 0 100% / 100% 1px no-repeat, var(--rule-line) 0 calc(100% - 3px) / 100% 1px no-repeat;
}
/* The double rule leaves a gap for the divider ornament instead of painting a patch over it. */
.letterhead::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 220px;
  height: 30px;
  transform: translate(-50%, 45%);
  background: var(--accent-text);
  mask: var(--theme-image-divider) no-repeat center / contain;
  pointer-events: none;
}
.copy { position: relative; z-index: 1; }
/* Vine corners frame the sheet; they sit under the text and the stamp. */
.corner { position: absolute; z-index: 0; width: 76px; height: 76px; background: color-mix(in srgb, var(--accent-text) 60%, transparent); mask: var(--theme-image-corner) no-repeat center / contain; pointer-events: none; }
.corner.top-left { top: 14px; left: 6px; }
.corner.top-right { top: 14px; right: 6px; transform: scaleX(-1); }
.corner.bottom-left { bottom: 6px; left: 6px; transform: scaleY(-1); }
.corner.bottom-right { bottom: 6px; right: 6px; transform: scale(-1); }
.heading { border: 0; padding: 0; margin: 0; }
.actions { border-top: var(--hairline) dashed color-mix(in srgb, var(--accent) 45%, var(--line)); padding-right: 96px; }
@container narrative-scene (max-width: 520px) {
  .manuscript { padding: 32px 20px 20px 40px; background: ${letterPaper(24)}; }
  .manuscript::after { right: 24px; bottom: -20px; width: 44px; height: 44px; font-size: 20px; }
  .letterhead { gap: 16px; margin-bottom: 24px; padding-bottom: 16px; }
  .letterhead { --rule-gap: 84px; }
  .letterhead::after { width: 160px; }
  .corner { width: 48px; height: 48px; }
  .actions { padding-right: 72px; }
}
`,
};
const squiggle =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 8'%3E%3Cpath d='M0 4 Q 6 0 12 4 T 24 4' fill='none' stroke='black' stroke-width='2'/%3E%3C/svg%3E\")";
const rubberStamp =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none' stroke='black'%3E%3Ccircle cx='50' cy='50' r='46' stroke-width='4'/%3E%3Ccircle cx='50' cy='50' r='38' stroke-width='1.5'/%3E%3Cpath d='M50 30 L55 45 L71 45 L58 54 L63 70 L50 60 L37 70 L42 54 L29 45 L45 45 Z' fill='black' stroke='none'/%3E%3Cpath d='M50 8 V16 M50 84 V92 M8 50 H16 M84 50 H92' stroke-width='3'/%3E%3C/svg%3E\")";
const washiTape = (angle: number) => `
  background: repeating-linear-gradient(${angle}deg, color-mix(in srgb, var(--accent) 38%, var(--panel)) 0 6px, color-mix(in srgb, var(--info) 30%, var(--panel)) 6px 12px);
  mask: conic-gradient(from -45deg at left, #0000 25%, #000 0) left / 51% 8px repeat-y, conic-gradient(from 135deg at right, #0000 25%, #000 0) right / 51% 8px repeat-y;
  opacity: 0.9;`;
const journalPage = (holeX: number, holeR: number, step: number) =>
  `${paperGrain}, radial-gradient(circle at ${holeX}px 50%, var(--bg) ${holeR}px, color-mix(in srgb, var(--text) 25%, transparent) ${holeR + 0.5}px ${holeR + 1}px, transparent ${holeR + 1.5}px) 0 0 / ${holeX * 2}px ${step}px repeat-y, radial-gradient(color-mix(in srgb, var(--text) 16%, transparent) 1px, transparent 1.5px) 0 0 / 20px 20px, var(--panel)`;
export const scrapbookTheme: ThemeDefinition = {
  title: '스크랩북',
  description: '테이프로 붙인 인물 사진과 나란히 놓인 기록',
  colors: colors('charcoal'),
  assets: [
    builtinThemeAsset('hand', 'NanumPenScript-Regular.woff2'),
    builtinThemeAsset('round', 'Gaegu-Regular.woff2'),
    builtinThemeAsset('torn', 'scrap-torn.webp'),
    builtinThemeAsset('sprig', 'scrap-sprig.webp'),
  ],
  appCss:
    commonApp +
    `
/* A travel-journal collage: a taped polaroid, a torn graph-paper note and a highlighted folio. */
.scene-portraits [data-uimori-part="bot-portrait"] {
  position: relative;
  padding: 10px 10px 36px;
  margin: 14px 8px 18px;
  background: color-mix(in srgb, var(--panel), var(--text) 5%);
  border: var(--hairline) solid var(--line);
  box-shadow: 7px 6px 0 -1px var(--surface), 7px 6px 0 -0.5px var(--line);
  transform: rotate(-2.5deg);
}
.scene-portraits [data-uimori-part="bot-portrait"]::before,
.scene-portraits [data-uimori-part="bot-portrait"]::after {
  content: '';
  position: absolute;
  top: -10px;
  width: 84px;
  height: 22px;
  z-index: 1;
  pointer-events: none;${washiTape(90)}
}
.scene-portraits [data-uimori-part="bot-portrait"]::before { left: -16px; transform: rotate(-32deg); }
.scene-portraits [data-uimori-part="bot-portrait"]::after { right: -14px; transform: rotate(28deg); }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border: 0; border-radius: 0; }
.scene-portraits [data-uimori-part="bot-portrait"] img { max-height: 520px; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { position: absolute; inset: auto 10px 6px; padding: 0; text-align: center; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-family: var(--theme-font-hand), cursive; font-size: 22px; font-weight: 400; color: var(--text); }
.reader [data-uimori-part="heading"] .folio {
  padding: 0 6px;
  font-family: var(--theme-font-hand), cursive;
  font-size: 22px;
  font-weight: 400;
  background: linear-gradient(176deg, transparent 52%, color-mix(in srgb, var(--accent) 32%, transparent) 54% 88%, transparent 90%);
}
.reader .request-message:not(form) {
  position: relative;
  padding: 18px 20px 24px;
  border: 0;
  border-radius: 0;
  color: var(--text);
  background:
    linear-gradient(color-mix(in srgb, var(--info) 14%, transparent) 1px, transparent 1px) 0 0 / 14px 14px,
    linear-gradient(90deg, color-mix(in srgb, var(--info) 14%, transparent) 1px, transparent 1px) 0 0 / 14px 14px,
    color-mix(in srgb, var(--panel), var(--text) 3%);
  mask: linear-gradient(#000 0 0) top / 100% calc(100% - 10px) no-repeat, var(--theme-image-torn) bottom / 256px 12px repeat-x;
  transform: rotate(0.8deg);
}
.reader .request-message:not(form) p { font-family: var(--theme-font-hand), cursive; font-size: 20px; line-height: 1.4; }
.reader .request-message:not(form)::before {
  content: '';
  position: absolute;
  top: -2px;
  left: calc(50% - 40px);
  width: 80px;
  height: 18px;
  pointer-events: none;${washiTape(0)}
}
` +
    mobilePortrait +
    `
@container narrative-workspace (max-width: 850px) {
  .scene-portraits [data-uimori-part="bot-portrait"] { transform: rotate(-1deg); margin: 12px 4px 16px; }
  .scene-portraits [data-uimori-part="bot-portrait"]::before { left: 12px; transform: rotate(-12deg); }
  .scene-portraits [data-uimori-part="bot-portrait"]::after { display: none; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { position: absolute; padding: 0; }
  .reader .request-message:not(form) { transform: none; }
}
`,
  messageCss:
    messageCss +
    `
:where(h1, h2, h3) { font-family: var(--theme-font-round), var(--theme-font-hand), cursive; font-weight: 400; }
`,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><aside class="portrait"><slot name="portrait"></slot></aside><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div><i class="sprig" aria-hidden="true"></i></section>',
  templateCss:
    commonTemplate +
    `
/* Dot-grid journal page with binder holes, a stitched edge, a folded corner and a pressed sprig. */
.manuscript {
  display: grid;
  grid-template-columns: minmax(180px, 31%) minmax(0, 1fr);
  gap: 36px;
  padding: 36px 36px 32px 56px;
  border: var(--hairline) solid var(--line);
  outline: 1.5px dashed color-mix(in srgb, var(--accent) 35%, transparent);
  outline-offset: -10px;
  background: ${journalPage(22, 7, 44)};
}
.manuscript::after {
  content: '';
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 40px;
  height: 40px;
  background: linear-gradient(to top left, var(--bg) 50%, color-mix(in srgb, var(--panel), var(--text) 14%) 50%);
}
.portrait { position: relative; padding-right: 12px; align-self: start; }
.portrait::after {
  content: '';
  position: absolute;
  left: -18px;
  bottom: -26px;
  width: 92px;
  height: 92px;
  background: color-mix(in srgb, var(--error) 50%, transparent);
  mask: ${rubberStamp} no-repeat center / contain;
  transform: rotate(-14deg);
  pointer-events: none;
}
.copy { position: relative; z-index: 1; }
.heading { position: relative; border-bottom: 0; }
.heading::after {
  content: '';
  position: absolute;
  inset: auto 0 -4px;
  height: 8px;
  background: color-mix(in srgb, var(--accent) 55%, var(--line));
  mask: ${squiggle} left / 24px 8px repeat-x;
}
.sprig {
  position: absolute;
  left: 64px;
  bottom: 28px;
  z-index: 0;
  width: 96px;
  height: 144px;
  background: color-mix(in srgb, var(--success) 45%, transparent);
  mask: var(--theme-image-sprig) no-repeat center / contain;
  transform: rotate(-18deg);
  pointer-events: none;
}
@container narrative-scene (max-width: 680px) {
  .manuscript { display: block; padding: 24px 18px 24px 40px; background: ${journalPage(16, 5, 36)}; }
  .portrait { border: 0; padding: 0 8px 16px; max-width: none; margin-inline: auto; }
  .portrait::after, .sprig { display: none; }
}
:host([data-has-portrait="false"]) .sprig, :host-context(.focus-reading) .sprig { display: none; }
`,
};

export const classicFrameTheme: ThemeDefinition = {
  title: '클래식 프레임',
  description: '얇은 사각 프레임 안에 인물과 이야기를 나란히 담은 정갈한 장면',
  colors: colors('midnight'),
  assets: [
    builtinThemeAsset('title', 'GowunBatang-Regular.woff2'),
    builtinThemeAsset('rosette', 'classic-rosette.webp'),
    builtinThemeAsset('laurel', 'classic-laurel.webp'),
  ],
  appCss:
    commonApp +
    `
@container narrative-workspace (min-width: 851px) { .reader [data-uimori-body-scroll] { max-height: clamp(220px, calc(100dvh - 620px - var(--control-h) - 12px), 520px); } }
/* A neoclassical salon: the portrait hangs in a gilt frame above a brass nameplate. */
.scene-portraits [data-uimori-part="bot-portrait"] { padding: 0; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border-radius: 0; border: 0; background: color-mix(in srgb, var(--panel), var(--text) 6%); }
.scene-portraits [data-uimori-part="bot-portrait"] img { width: 100%; max-height: 500px; object-fit: contain; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption {
  position: relative;
  margin: 16px auto 0;
  width: fit-content;
  max-width: 100%;
  padding: 6px 28px;
  text-align: center;
  border: 3px double color-mix(in srgb, var(--accent-text) 60%, transparent);
  background:
    radial-gradient(circle at 12px 50%, var(--accent-text) 2px, color-mix(in srgb, var(--accent-text) 30%, transparent) 2.5px 3.5px, transparent 4px),
    radial-gradient(circle at calc(100% - 12px) 50%, var(--accent-text) 2px, color-mix(in srgb, var(--accent-text) 30%, transparent) 2.5px 3.5px, transparent 4px),
    linear-gradient(180deg, color-mix(in srgb, var(--accent) 26%, var(--panel)), color-mix(in srgb, var(--accent) 12%, var(--panel)) 55%, color-mix(in srgb, var(--accent) 22%, var(--panel)));
}
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-family: var(--theme-font-title), serif; font-size: var(--font-body); font-weight: 400; letter-spacing: 0.2em; color: var(--text); }
.reader [data-uimori-part="heading"] .folio { font-family: var(--theme-font-title), serif; font-size: var(--font-heading); font-weight: 400; letter-spacing: 0.16em; }
/* The request is an engraved museum label. */
.reader .request-message:not(form) {
  padding: 14px 22px;
  border: 1px solid color-mix(in srgb, var(--accent-text) 45%, var(--line));
  border-radius: 0;
  background: var(--panel);
  box-shadow: inset 0 0 0 4px var(--panel), inset 0 0 0 5px color-mix(in srgb, var(--accent-text) 30%, var(--line));
  font-family: var(--theme-font-title), serif;
}
` +
    mobilePortrait +
    `
@container narrative-workspace (max-width: 850px) {
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { position: relative; margin-top: 10px; padding: 4px 22px; }
}
`,
  messageCss:
    messageCss +
    `
:where(h1, h2, h3) { font-family: var(--theme-font-title), serif; font-weight: 400; letter-spacing: 0.04em; }
`,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><aside class="portrait"><div class="frame"><i class="rosette top-left" aria-hidden="true"></i><i class="rosette top-right" aria-hidden="true"></i><i class="rosette bottom-left" aria-hidden="true"></i><i class="rosette bottom-right" aria-hidden="true"></i><slot name="portrait"></slot></div></aside><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
/* Striped regency wallpaper under a picture light, with a placard page beside the framed portrait. */
.manuscript {
  display: grid;
  grid-template-columns: minmax(180px, 29%) minmax(0, 1fr);
  gap: 24px;
  padding: 20px;
  border: var(--hairline) solid var(--line);
  box-shadow: inset 0 0 0 4px var(--panel), inset 0 0 0 5px color-mix(in srgb, var(--accent-text) 30%, var(--line));
  background:
    radial-gradient(ellipse 60% 40% at 15% 0, color-mix(in srgb, var(--accent) 16%, transparent), transparent),
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent) 0 14px, transparent 14px 18px, color-mix(in srgb, var(--accent) 4%, transparent) 18px 20px, transparent 20px 34px),
    var(--panel);
}
.portrait { align-self: start; padding-top: 22px; position: relative; }
/* Picture wire to a brass nail. */
.portrait::before {
  content: '';
  position: absolute;
  top: 0;
  left: 25%;
  right: 25%;
  height: 24px;
  background:
    radial-gradient(circle at 50% 3px, var(--accent-text) 3px, transparent 3.5px),
    linear-gradient(to top right, transparent calc(50% - 0.75px), var(--accent-text) calc(50% - 0.75px) calc(50% + 0.75px), transparent calc(50% + 0.75px)) left bottom / 50% 22px no-repeat,
    linear-gradient(to top left, transparent calc(50% - 0.75px), var(--accent-text) calc(50% - 0.75px) calc(50% + 0.75px), transparent calc(50% + 0.75px)) right bottom / 50% 22px no-repeat;
  opacity: 0.7;
}
/* Gilt moulding: stacked keylines around a bead row. */
.frame {
  position: relative;
  padding: 14px;
  background:
    radial-gradient(circle, color-mix(in srgb, var(--accent-text) 70%, transparent) 1.5px, transparent 2px) 0 0 / 7px 7px,
    color-mix(in srgb, var(--accent) 20%, var(--panel));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent-text) 70%, transparent),
    0 0 0 3px var(--panel),
    0 0 0 4px color-mix(in srgb, var(--accent-text) 45%, transparent),
    inset 0 0 0 2px color-mix(in srgb, var(--accent-text) 80%, transparent),
    inset 0 0 0 5px var(--panel),
    inset 0 0 0 6px color-mix(in srgb, var(--accent-text) 50%, transparent);
}
.rosette { position: absolute; z-index: 1; width: 22px; height: 22px; background: var(--accent-text); mask: var(--theme-image-rosette) no-repeat center / contain; pointer-events: none; }
.rosette.top-left { top: -4px; left: -4px; }
.rosette.top-right { top: -4px; right: -4px; }
.rosette.bottom-left { bottom: -4px; left: -4px; }
.rosette.bottom-right { bottom: -4px; right: -4px; }
:host([data-has-portrait="false"]) .rosette { display: none; }
.copy {
  position: relative;
  padding: 24px 28px;
  background: var(--panel);
  outline: var(--hairline) solid color-mix(in srgb, var(--accent-text) 40%, var(--line));
  outline-offset: -8px;
}
.heading { position: relative; padding-bottom: 18px; margin-bottom: 24px; border-bottom: 0; }
.heading::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -8px;
  height: 22px;
  background:
    linear-gradient(to right, color-mix(in srgb, var(--accent-text) 40%, var(--line)) calc(50% - 92px), transparent calc(50% - 92px) calc(50% + 92px), color-mix(in srgb, var(--accent-text) 40%, var(--line)) calc(50% + 92px)) center / 100% 1px no-repeat;
  pointer-events: none;
}
.heading::before {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -8px;
  width: 240px;
  height: 22px;
  transform: translateX(-50%);
  background: var(--accent-text);
  mask: var(--theme-image-laurel) no-repeat center / contain;
  pointer-events: none;
}
.actions { margin-top: 20px; }
@container narrative-scene (max-width: 680px) {
  .manuscript { display: block; padding: 10px; }
  .portrait { margin-bottom: 14px; padding-top: 0; }
  .portrait::before { display: none; }
  .frame { padding: 8px; }
  .rosette { width: 16px; height: 16px; }
  .copy { padding: 18px 16px; }
  .heading::before { width: 130px; }
  .heading::after { background: linear-gradient(to right, color-mix(in srgb, var(--accent-text) 40%, var(--line)) calc(50% - 72px), transparent calc(50% - 72px) calc(50% + 72px), color-mix(in srgb, var(--accent-text) 40%, var(--line)) calc(50% + 72px)) center / 100% 1px no-repeat; }
}
`,
};

const sprockets =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 24'%3E%3Cpath fill-rule='evenodd' d='M0 0H18V24H0Z M5 6H13V16H5Z'/%3E%3C/svg%3E\")";
const ticketNotches =
  'radial-gradient(circle at 0 50%, #0000 9px, #000 9.5px) left / 51% 100% no-repeat, radial-gradient(circle at 100% 50%, #0000 9px, #000 9.5px) right / 51% 100% no-repeat';
export const cinematicTheme: ThemeDefinition = {
  title: '시네마틱',
  description: '가장자리로 스며드는 등장인물과 긴 이야기를 담은 장면',
  colors: colors('midnight'),
  assets: [
    builtinThemeAsset('title', 'GowunBatang-Regular.woff2'),
    builtinThemeAsset('display', 'DoHyeon-Regular.woff2'),
    builtinThemeAsset('corner', 'cinema-corner.webp'),
    builtinThemeAsset('wing', 'cinema-wing.webp'),
  ],
  appCss:
    commonApp +
    `
/* An art-deco movie palace: the portrait is a film frame with a lower-third name card. */
.scene-portraits { position: relative; display: block; }
.scene-portraits [data-uimori-part="bot-portrait"] { position: relative; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border: 0; border-radius: 0; background: transparent; }
.scene-portraits [data-uimori-part="bot-portrait"] img { width: 100%; height: auto; max-height: 640px; object-fit: cover; object-position: center 20%; mask-image: linear-gradient(to right, transparent, black 22%), linear-gradient(to bottom, black 65%, transparent 100%); mask-composite: intersect; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-empty { min-height: 280px; background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 18%, var(--panel)), var(--panel)); }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption {
  position: absolute;
  left: 20px;
  right: 34px;
  bottom: 26px;
  padding: 6px 12px 6px 14px;
  border-left: 3px solid var(--accent);
  background: linear-gradient(to right, color-mix(in srgb, var(--panel) 88%, transparent), transparent);
  pointer-events: none;
}
.scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-family: var(--theme-font-display), var(--theme-font-title), sans-serif; font-size: 18px; font-weight: 400; letter-spacing: 0.08em; }
.scene-portraits figcaption small { display: none; }
.scene-portraits [data-uimori-part="persona-portrait"] { position: absolute; right: 20px; bottom: 24px; gap: 8px; }
.scene-portraits [data-uimori-part="persona-portrait"] figcaption { display: none; }
.scene-portraits [data-uimori-part="persona-portrait"] .reader-portrait-button { border: var(--hairline) solid var(--line); }
.reader [data-uimori-part="heading"] .folio { font-family: var(--theme-font-display), var(--theme-font-title), sans-serif; font-size: 18px; font-weight: 400; letter-spacing: 0.12em; color: var(--accent-text); }
/* The request is an admission ticket: notched sides and a perforated stub. */
.reader .request-message:not(form) {
  position: relative;
  padding: 14px 72px 14px 24px;
  border: 0;
  border-radius: var(--radius-small);
  color: var(--text);
  background:
    repeating-linear-gradient(to bottom, color-mix(in srgb, var(--accent) 60%, transparent) 0 5px, transparent 5px 9px) calc(100% - 52px) 0 / 1.5px 100% no-repeat,
    linear-gradient(to right, transparent calc(100% - 52px), color-mix(in srgb, var(--accent) 22%, var(--panel)) calc(100% - 52px)),
    color-mix(in srgb, var(--accent) 10%, var(--panel));
  mask: ${ticketNotches};
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
}
:root[data-theme="dark"] .reader .request-message:not(form) { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent), inset 0 0 18px color-mix(in srgb, var(--accent) 12%, transparent); }
` +
    mobilePortrait +
    `
@container narrative-workspace (max-width: 850px) {
  .scene-portraits [data-uimori-part="bot-portrait"] img { height: 130px; object-fit: cover; object-position: center 22%; mask-image: linear-gradient(to bottom, black 65%, transparent); }
  .scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-empty { min-height: 130px; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { position: absolute; left: 16px; right: 16px; bottom: 14px; padding: 4px 10px; text-align: left; }
  .scene-portraits [data-uimori-part="persona-portrait"] { right: 18px; bottom: 12px; }
  .reader .request-message:not(form) { padding-right: 60px; }
}
`,
  messageCss:
    messageCss +
    `
:where(h1, h2, h3) { font-family: var(--theme-font-display), var(--theme-font-title), sans-serif; font-weight: 400; letter-spacing: 0.04em; }
`,
  templateHtml:
    '<div class="request-row"><slot name="request"></slot><aside class="request-persona"><slot name="request-persona"></slot></aside></div><section class="manuscript"><i class="corner top-left" aria-hidden="true"></i><i class="corner top-right" aria-hidden="true"></i><i class="corner bottom-left" aria-hidden="true"></i><i class="corner bottom-right" aria-hidden="true"></i><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body" data-uimori-body-scroll></slot><i class="wing" aria-hidden="true"></i><footer class="actions"><slot name="actions"></slot></footer></div><aside class="portrait"><slot name="portrait"></slot></aside></section>',
  templateCss:
    commonTemplate +
    `
/* Proscenium with deco corners, a marquee of bulbs, a projector beam and a film-strip edge. */
.manuscript {
  display: grid;
  grid-template-columns: minmax(0, 60%) minmax(0, 40%);
  gap: 0;
  padding: 26px 0 0;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
  box-shadow: inset 0 0 0 6px var(--panel), inset 0 0 0 7px color-mix(in srgb, var(--accent) 40%, var(--line));
  background:
    conic-gradient(from 200deg at 100% 0%, transparent 0deg, color-mix(in srgb, var(--accent) 9%, transparent) 14deg, transparent 32deg),
    radial-gradient(ellipse at 50% 30%, transparent 45%, color-mix(in srgb, var(--accent) 8%, transparent) 100%),
    ${paperGrain},
    var(--panel);
}
.manuscript::before {
  content: '';
  position: absolute;
  inset: 12px 40px auto;
  height: 8px;
  background: radial-gradient(circle, var(--accent) 2.5px, transparent 3px) center / 16px 8px repeat-x;
  pointer-events: none;
}
:host-context([data-theme="dark"]) .manuscript { background-color: color-mix(in srgb, var(--panel), black 25%); }
:host-context([data-theme="dark"]) .manuscript::before { filter: drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 60%, transparent)); }
.corner { position: absolute; z-index: 2; width: 64px; height: 64px; background: var(--accent-text); mask: var(--theme-image-corner) no-repeat center / contain; pointer-events: none; }
.corner.top-left { top: 4px; left: 4px; }
.corner.top-right { top: 4px; right: 4px; transform: scaleX(-1); }
.corner.bottom-left { bottom: 4px; left: 4px; transform: scaleY(-1); }
.corner.bottom-right { bottom: 4px; right: 4px; transform: scale(-1); }
.copy { position: relative; z-index: 1; padding: 24px 24px 28px 40px; }
/* A clapperboard hinge above the scene heading. */
.heading { position: relative; padding-top: 18px; border-bottom-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.heading::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 10px;
  background: repeating-linear-gradient(-60deg, var(--text) 0 12px, var(--panel) 12px 24px);
  border: 1px solid var(--text);
  opacity: 0.85;
}
.wing { display: block; height: 28px; margin: 18px auto 0; width: min(100%, 320px); background: var(--accent-text); mask: var(--theme-image-wing) no-repeat center / contain; }
.actions { margin-top: 8px; border-top: 0; }
.portrait { position: relative; align-self: start; padding: 0 22px 0 0; }
.portrait::after {
  content: '';
  position: absolute;
  inset: 0 0 0 auto;
  width: 18px;
  background: color-mix(in srgb, var(--text) 82%, var(--panel));
  mask: ${sprockets} center top / 18px 24px repeat-y;
}
@container narrative-scene (max-width: 680px) {
  .manuscript { display: flex; flex-direction: column; padding: 20px 0 0; }
  .manuscript::before { inset: 8px 28px auto; }
  .corner { width: 40px; height: 40px; }
  .corner.bottom-left, .corner.bottom-right { display: none; }
  .copy { padding: 12px 18px 24px; }
  .portrait { order: -1; width: 100%; padding: 0 0 18px; }
  .portrait::after { inset: auto 0 0 0; width: auto; height: 18px; mask: ${sprockets} left center / 24px 18px repeat-x; }
}
`,
};
