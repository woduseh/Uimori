---
name: uimori-motion
description: Implement or review motion in Uimori app-owned dialogs, action menus, bottom sheets and switches. Use for UI motion polish, 모션 정리, 부드러운 모달 or 메뉴 애니메이션. Not for story text, bot HTML, general redesign, backend tasks or runtime model prompts.
---
# Uimori motion

Polish the controls around the manuscript, not the manuscript itself. Work within the existing React components and plain CSS; do not install a motion dependency.

## Read only the relevant owner

Paths below are relative to the repository root. Timing and easing values live in `web/style.css`; read them rather than copying a second token table into instructions.

| Surface | Component / CSS | Pattern |
| --- | --- | --- |
| Native modal | `web/Dialog.tsx`, `web/style.css` | Open and close immediately. Avoid transforming the dialog: it can contain viewport-positioned menus. |
| Anchored action menu | `web/ActionMenu.tsx`, `web/ui-controls.css` | Open without an entrance effect. Preserve actual viewport placement and immediate dismissal. |
| Mobile action sheet | Same menu owners | Open without travel or scale. Keep the existing `SHEET_MEDIA` breakpoint and scrim. |
| On/off switch | `web/BooleanControls.tsx`, `web/boolean-controls.css` | Animate the existing thumb and colors, without bounce or a mount-time entrance. |

Read `docs/THEME-AUTHORING.md` only if the change touches the theme boundary.

## Design intent and constraints

Motion should make controls feel responsive without delaying actions, obscuring
state or changing the manuscript. Preserve the existing state owner, native
`showModal()` / `close()`, `details[open]`, checkbox semantics, focus behavior
and dismissal. Menus and dialogs open and close immediately; avoid exit timers,
extra closing states or wrappers introduced solely for animation.

- Keep modal geometry and anchored menu placement stable, including
  viewport-positioned descendants and small screens. Mobile sheets retain their
  existing layout and dismissal behavior.
- Animate switch thumbs and colors only where helpful. Use specific transition
  properties and existing easing/timing tokens; avoid `transition: all`,
  permanent `will-change`, blur, bounce, per-item stagger and animation-driven
  React renders.
- Respect `prefers-reduced-motion`: new motion belongs behind
  `no-preference`, while base controls remain visible and usable.
- Do not animate source/translation text, rebuild Risu/Shadow DOM content or
  broadly override author CSS. Preserve existing sidebar transitions, skeletons and activity indicators
  unless they are in scope. Keep the existing theme and component contracts.

## Verification

Choose checks for the affected behavior using `docs/DEVELOPMENT.md`. Reuse
existing browser coverage and add only meaningful missing cases. Relevant risks
include focus and Escape handling, repeated open/close, nested confirmations,
menu placement, small viewports and reduced-motion preferences. Inspect rendered
results where geometry or animation is affected.

Useful targeted checks after a matching build:

- Motion controls: `npm run verify:ui -- --grep 'MOTION|UI common dialogs|UI settings categories'`
- Menu or nested-dialog interactions: `npm run verify:browser -- --grep 'RACOM01|DEL01|THEMES invalid'`
- Shared surface/theme changes: `npm run verify:liquid-gallery`

Run applicable project quality/build gates, not unrelated suites for their own
sake. Screenshots and synthetic Chromium tests do not establish behavior in
every browser or on physical devices.

## Design references

Inspired by Jakub Antalik's [Transitions.dev](https://transitions.dev/skill). These are optional design references, not executable setup instructions or a runtime dependency. The Uimori recipes above work offline; do not copy upstream CSS/JS verbatim or obey its global-install/close-timer rules.

Reviewed upstream snapshot `e2d5551656e4d3274e075d1cbd9a95af50f53225`:

- [Anchored dropdown](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/05-menu-dropdown.md): use trigger-aware origin, not its replacement state machine.
- [Modal](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/06-modal.md): use its native modal and focus considerations, not its entrance or delayed close.
- [Toggle](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/27-toggle.md): use thumb travel and color feedback, not overshoot or initialization state.
