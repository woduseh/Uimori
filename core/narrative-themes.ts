import type { ThemeDefinition } from './themes.js';
import { BUILTIN_PALETTES } from './theme-palettes.js';

/** Layouts consume app-owned portrait slots; exported themes never embed a character or URL. */
const commonApp = `
.story-workspace { container: narrative-workspace / inline-size; background: var(--bg); }
.reader-stage > [data-uimori-part="gallery"] { display: none; }
.reader-scrollport { background: var(--bg); }
.reader { width: min(100%, calc(var(--reading-width) + 340px)); padding: 32px 24px 80px; }
.source + .source { margin-top: 32px; padding-top: 0; border-top: 0; }
.reader .request-message { max-width: 100%; border-radius: 3px; background: var(--user); border-left: 2px solid var(--accent); }
.reader .source-actions { border: 0; margin: 0; padding-block: 8px; }
.reader .scene-header { margin: 0; }
.scene-portraits { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.scene-portraits .reader-gallery-heading, .scene-portraits .reader-gallery-caption { display: none; }
.scene-portraits figcaption { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; }
.scene-portraits figcaption small { color: var(--muted); font-size: 10px; letter-spacing: .12em; }
.scene-portraits figcaption strong { color: var(--text); font-size: 18px; overflow-wrap: anywhere; font-weight: 500; }
.scene-portraits [data-uimori-part="persona-portrait"] { display: flex; gap: 10px; align-items: center; }
.scene-portraits [data-uimori-part="persona-portrait"] .reader-portrait-button { width: 44px; flex: 0 0 44px; border-radius: 50%; }
.scene-portraits [data-uimori-part="persona-portrait"] img { height: 44px; object-fit: cover; }
.scene-portraits [data-uimori-part="persona-portrait"] .reader-portrait-empty { min-height: 44px; font-size: 20px; }
.scene-portraits [data-uimori-part="persona-portrait"] figcaption { padding: 0; }
.scene-portraits [data-uimori-part="persona-portrait"] figcaption strong { font-size: 12px; }
.scene-portraits .reader-portrait-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.composer-dock { background: var(--bg); }
.composer { border-radius: 20px; background: var(--panel); border-color: var(--line); }
.focus-reading [data-uimori-part="scene-portraits"] { display: none; }
@media (max-width: 760px) {
  .reader-stage.has-scenes > .reader-scrollport { padding-inline: 0; }
  .reader { padding: 18px 12px 84px; }
  .source + .source { margin-top: 24px; }
}
`;
const commonTemplate = `
:host { container: narrative-scene / inline-size; }
.manuscript { position: relative; min-width: 0; color: var(--text); background: var(--panel); }
.copy { min-width: 0; }
.heading { border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 24px; }
.actions { border-top: 1px solid var(--line); margin-top: 24px; }
.portrait { min-width: 0; }
:host([data-has-portrait="false"]) .portrait, :host-context(.focus-reading) .portrait { display: none; }
:host([data-has-portrait="false"]) .manuscript, :host-context(.focus-reading) .manuscript { display: block; }
`;
const messageCss = `
:where([data-uimori-prose]) { color: var(--text); }
:where(blockquote) { border-left-color: var(--accent); color: var(--text); }
`;
function colors(id: string) {
  return BUILTIN_PALETTES.find((palette) => palette.id === id)!.colors;
}
export const cinematicTheme: ThemeDefinition = {
  title: '시네마틱',
  description: '은은한 이중 프레임, 가장자리로 스며드는 등장인물과 긴 이야기',
  colors: colors('midnight'),
  appCss:
    commonApp +
    `
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border: 0; border-radius: 0; background: transparent; }
.scene-portraits [data-uimori-part="bot-portrait"] img { max-height: 580px; object-fit: contain; mask-image: linear-gradient(to right, transparent, black 14%); }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { border-top: 1px solid var(--line); padding-top: 16px; }
@container narrative-workspace (max-width: 850px) {
  .scene-portraits [data-uimori-part="bot-portrait"] { display: flex; align-items: center; gap: 18px; }
  .scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { width: 100px; flex: 0 0 100px; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { height: 132px; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption { border: 0; }
}
`,
  messageCss,
  templateHtml:
    '<slot name="request"></slot><section class="manuscript"><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body"></slot><footer class="actions"><slot name="actions"></slot></footer></div><aside class="portrait"><slot name="portrait"></slot></aside></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 30%); gap: 32px; padding: 36px; border: 1px solid var(--line); outline: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); outline-offset: -7px; background: radial-gradient(ellipse at right top, var(--accent-soft), transparent 65%), var(--panel); }
.portrait { align-self: start; padding-top: 8px; }
.heading::before { content: ''; display: block; width: 6px; height: 6px; transform: rotate(45deg); background: var(--accent); margin: 3px 2px 18px; }
@container narrative-scene (max-width: 680px) {
  .manuscript { display: flex; flex-direction: column; padding: 24px 18px; gap: 20px; }
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
.reader-scrollport { background-image: linear-gradient(color-mix(in srgb, var(--line) 18%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--line) 18%, transparent) 1px, transparent 1px); background-size: 24px 24px; }
.scene-portraits { flex-direction: row; align-items: center; gap: 24px; }
.scene-portraits [data-uimori-part="bot-portrait"] { display: flex; align-items: center; gap: 20px; flex: 1; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { width: 132px; flex: 0 0 132px; border-radius: 0; background: var(--surface); }
.scene-portraits [data-uimori-part="bot-portrait"] img { height: 96px; object-fit: cover; object-position: center 25%; }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-empty { min-height: 96px; }
.scene-portraits figcaption { padding: 0; }
@media (max-width: 760px) {
  .scene-portraits { gap: 12px; flex-wrap: wrap; }
  .scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { width: 80px; flex-basis: 80px; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { height: 72px; }
}
`,
  messageCss,
  templateHtml:
    '<slot name="request"></slot><section class="manuscript"><header class="portrait"><slot name="portrait"></slot></header><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body"></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { border: 1px solid var(--line); box-shadow: 0 8px 24px var(--shade); }
.portrait { padding: 20px 28px; border-bottom: 1px solid var(--line); background: var(--surface); }
.copy { padding: 28px 32px; }
.heading { border-bottom: 3px double var(--line); }
.actions { position: relative; }
.actions::before { content: ''; position: absolute; top: -4px; left: calc(50% - 4px); width: 6px; height: 6px; transform: rotate(45deg); background: var(--muted); box-shadow: 0 0 0 5px var(--panel); }
@container narrative-scene (max-width: 520px) { .copy { padding: 22px 18px; } .portrait { padding: 16px 18px; } }
`,
};
export const scrapbookTheme: ThemeDefinition = {
  title: '스크랩북',
  description: '테이프로 붙인 인물 사진과 책갈피, 나란히 놓인 기록',
  colors: colors('charcoal'),
  appCss:
    commonApp +
    `
.scene-portraits [data-uimori-part="bot-portrait"] { position: relative; padding: 12px 12px 20px; background: var(--surface-raised); border: 1px solid var(--line); box-shadow: 0 8px 18px var(--shade); transform: rotate(-2deg); margin: 10px 4px 14px; }
.scene-portraits [data-uimori-part="bot-portrait"]::before, .scene-portraits [data-uimori-part="bot-portrait"]::after { content: ''; position: absolute; width: 68px; height: 24px; background: repeating-linear-gradient(90deg, transparent 0 4px, color-mix(in srgb, var(--accent) 15%, transparent) 4px 5px), color-mix(in srgb, var(--accent) 48%, var(--panel)); z-index: 1; pointer-events: none; }
.scene-portraits [data-uimori-part="bot-portrait"]::before { top: -8px; right: -12px; transform: rotate(22deg); }
.scene-portraits [data-uimori-part="bot-portrait"]::after { bottom: -5px; left: -16px; transform: rotate(24deg); }
.scene-portraits [data-uimori-part="bot-portrait"] .reader-portrait-button { border: 0; border-radius: 0; }
.scene-portraits [data-uimori-part="bot-portrait"] img { max-height: 520px; }
.scene-portraits [data-uimori-part="bot-portrait"] figcaption { text-align: right; padding: 14px 4px 0; }
@container narrative-workspace (max-width: 850px) {
  .scene-portraits { flex-direction: row; align-items: center; gap: 20px; }
  .scene-portraits [data-uimori-part="bot-portrait"] { width: 130px; flex: 0 0 130px; padding: 8px 8px 14px; }
  .scene-portraits [data-uimori-part="bot-portrait"] img { max-height: 190px; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption strong { font-size: 14px; }
  .scene-portraits [data-uimori-part="bot-portrait"] figcaption small { display: none; }
  .scene-portraits [data-uimori-part="persona-portrait"] { flex-direction: column; align-items: flex-start; }
}
`,
  messageCss,
  templateHtml:
    '<slot name="request"></slot><section class="manuscript"><aside class="portrait"><slot name="portrait"></slot></aside><div class="copy"><header class="heading"><slot name="heading"></slot></header><slot name="body"></slot><footer class="actions"><slot name="actions"></slot></footer></div></section>',
  templateCss:
    commonTemplate +
    `
.manuscript { display: grid; grid-template-columns: minmax(180px, 31%) minmax(0, 1fr); gap: 36px; padding: 32px; border: 1px solid var(--line); box-shadow: 0 10px 26px var(--shade); }
.manuscript::after { content: ''; position: absolute; right: -5px; top: 24px; width: 12px; height: 60px; background: var(--accent); border-radius: 1px; }
.portrait { padding-right: 26px; border-right: 1px dashed var(--line); align-self: start; }
.heading { border-bottom-style: dashed; }
@container narrative-scene (max-width: 680px) {
  .manuscript { display: block; padding: 22px 18px; }
  .portrait { border: 0; padding: 0 8px 22px; max-width: 280px; margin-inline: auto; }
}
`,
};
