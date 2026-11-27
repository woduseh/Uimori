---
name: uimori-motion
description: Implement or review motion in Uimori app-owned dialogs, action menus, bottom sheets and switches. Use for UI motion polish, 모션 정리, 부드러운 모달 or 메뉴 애니메이션. Not for story text, bot HTML, general redesign, backend tasks or runtime model prompts.
---
# Uimori motion

Polish the controls around the manuscript, not the manuscript itself. Work within the existing React components and plain CSS; do not install a motion dependency.

## Read only the relevant owner

Paths below are relative to the repository root. The motion tokens (`--motion-fast`, `--motion-panel`, `--motion-overlay`, `--motion-ease-out`) live in `web/style.css`, and their roles are listed in `docs/dev/UI-PRINCIPLES.md`; read them there rather than copying values into instructions. A duration or easing the tokens do not cover enters as a new token, not as a literal value or a range.

| Surface | Component / CSS | Pattern |
| --- | --- | --- |
| Native modal | `web/Dialog.tsx`, `web/style.css` | Fades and rises 8px with its backdrop over `--motion-overlay` through `@starting-style`, ending at `transform: none`; closes immediately. Nothing may keep `transform` or `will-change` on the dialog at rest, because it contains `position: fixed` menus. |
| Anchored action menu | `web/ActionMenu.tsx`, `web/ui-controls.css` | Fades and moves 4px from its trigger side over `--motion-overlay`; placement is unchanged at rest and dismissal is immediate. |
| Mobile action sheet | Same menu owners | Rises 16px with a fading scrim over `--motion-overlay` at the `SHEET_MEDIA` breakpoint; dismissal is immediate. |
| Editor changes drawer | `web/EditorChanges.tsx`, `web/editor-studio.css` | The native modal docks to the right edge at every width and slides 16px in from the right with the modal backdrop over `--motion-overlay`, ending at `transform: none`; dismissal is immediate. |
| Mobile navigation sheet | `web/main.tsx` (`navigation-dialog`), `web/bot-navigation.css` | The native navigation modal docks left at the narrow layout and slides 16px in from the left edge with the modal backdrop over `--motion-overlay`, ending at `transform: none`; dismissal is immediate. |
| Composer menu | `web/ComposerMore.tsx`, `web/composer-more.css` | Rises 4px from below over `--motion-overlay`; at the `SHEET_MEDIA` breakpoint it rises 16px with a fading scrim. Closing unmounts it immediately. |
| Input-language menu | `web/InputTranslation.tsx`, `web/input-translation.css` | Fades and rises 4px above its trigger over `--motion-overlay`; dismissal is immediate. |
| Icon-button tooltip | `web/IconButton.tsx`, `web/tooltip.css` | The hint popover only fades over `--motion-overlay`, because its placement can flip; hiding is immediate. |
| Scene preview | `web/SceneNavigator.tsx`, `web/scene-navigator.css` | Fades and moves 4px from the scene mark over `--motion-overlay`, ending at its centring transform; hiding is immediate. |
| Transient notice | `web/TransientNotice.tsx`, `web/notices.css` | Each notice fades and rises 8px over `--motion-overlay`; removal is immediate. |
| Button and row hover | `web/style.css`, navigation row styles | Background, border and text colours ease over `--motion-fast`; story UI keeps its own transitions. |
| On/off switch | `web/BooleanControls.tsx`, `web/boolean-controls.css` | Animates the existing thumb and colors with `--motion-fast`, without bounce or a mount-time entrance. |
| Navigation landing mark | `web/arrival-mark.ts`, `web/arrival-mark.css` | An outline on the block anchor or editor region a navigation landed on fades over `--motion-mark`; under reduced motion it stays static until the next pointer or key press. It never animates manuscript text or layout. |

Read `docs/THEME-AUTHORING.md` only if the change touches the theme boundary.

## Design intent and constraints

Motion should make controls feel responsive without delaying actions, obscuring
state or changing the manuscript. Preserve the existing state owner, native
`showModal()` / `close()`, `details[open]`, checkbox semantics, focus behavior
and dismissal. Implement entrance motion in CSS alone; avoid exit timers, extra
closing states, animation-driven React state or wrappers introduced solely for
animation.

When motion on a surface in the table changes, update the table and the motion
paragraph in `docs/dev/DEVELOPMENT.md` in the same change. No browser case pins
durations or easing; check the result in the running app.

- Keep modal geometry and anchored menu placement stable, including
  viewport-positioned descendants and small screens. A dialog ends its entrance
  at `transform: none` and never keeps `transform` or `will-change` at rest.
  Mobile sheets retain their existing layout and dismissal behavior.
- Animate compositor-friendly properties (`opacity`, `transform`) first, with
  specific transition properties and the motion tokens; avoid `transition: all`,
  permanent `will-change`, blur, bounce and per-item stagger.
- Respect `prefers-reduced-motion`: new motion belongs behind
  `no-preference`, while base controls remain visible and usable.
- Do not shift the manuscript layout, animate source/translation text, rebuild
  Risu/Shadow DOM content or broadly override author CSS. Preserve existing sidebar transitions, skeletons and activity indicators
  unless they are in scope. Keep the existing theme and component contracts.

## Verification

Choose checks for the affected behavior using `docs/dev/CHECKS.md`. Reuse
existing browser coverage and add only meaningful missing cases. Relevant risks
include focus and Escape handling, repeated open/close, nested confirmations,
menu placement, small viewports and reduced-motion preferences. Inspect rendered
results where geometry or animation is affected.

Useful targeted checks after a matching build:

- Menu or nested-dialog interactions: `npm run verify -- all --grep 'RACOM04|DEL01|THEMES'`
- Shared surface/theme changes: `npm run verify -- appearance`

Run applicable project quality/build gates, not unrelated suites for their own
sake. Screenshots and synthetic Chromium tests do not establish behavior in
every browser or on physical devices.

## Design references

Inspired by Jakub Antalik's [Transitions.dev](https://transitions.dev/skill). These are optional design references, not executable setup instructions or a runtime dependency. The Uimori recipes above work offline; do not copy upstream CSS/JS verbatim or obey its global-install/close-timer rules.

Reviewed upstream snapshot `e2d5551656e4d3274e075d1cbd9a95af50f53225`:

- [Anchored dropdown](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/05-menu-dropdown.md): a reference for trigger-aware origin if menu entrance motion is adopted; do not use its replacement state machine.
- [Modal](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/06-modal.md): use its native modal and focus considerations, not its delayed close; any entrance follows the transform constraint above.
- [Toggle](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/27-toggle.md): use thumb travel and color feedback, not overshoot or initialization state.
