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
| Native modal | `web/Dialog.tsx`, `web/style.css` | Brief opacity-only entrance; close immediately. Avoid transforming the dialog: it can contain viewport-positioned menus. |
| Anchored action menu | `web/ActionMenu.tsx`, `web/ui-controls.css` | Small fade/scale from the actual opening edge. Viewport placement can flip the preferred direction. |
| Mobile action sheet | Same menu owners | Small upward entrance, not the desktop scale. Keep the existing `SHEET_MEDIA` breakpoint and scrim. |
| On/off switch | `web/BooleanControls.tsx`, `web/boolean-controls.css` | Animate the existing thumb and colors, without bounce or a mount-time entrance. |

Read `docs/DEVELOPMENT.md` for verification. Read `docs/THEME-AUTHORING.md` only if the change touches the theme boundary.

## Workflow

1. Identify the requested control, its existing state owner, and the smallest shared styling change. For a review-only request, report findings without editing.
2. Before changing behavior, list plausible failures: immediate re-open, conditional unmount, nested confirmation, focus restoration, menu edge flipping, small viewports and reduced motion. Reuse existing browser coverage; add only missing cases.
3. Preserve native `showModal()` / `close()`, `details[open]`, checkbox state and existing event handling. CSS follows those states. Do not add exit timers, closing states, delayed unmounts or new wrappers just for animation.
4. Reuse `--motion-fast` for small state changes and menus, `--motion-panel` for larger surfaces, and `--motion-ease-out` for non-bouncing entrance/travel. Choose tokens by purpose, not the nearest numeric value.
5. Gate new animation and transition rules on `prefers-reduced-motion: no-preference`. Keep stable, visible, usable styles outside that block. Existing reduced-motion token overrides remain in place.
6. Verify the affected flows on the real synthetic app, then inspect the captured screens. Report the exact checks, limitations and artifact paths, not just that screenshots were produced.

## Boundaries and pitfalls

- Existing component structure, theme contract and focus behavior take priority over reference snippets. Do not import `t-*` wrappers or the entire upstream token catalog.
- Use explicit transition properties. Avoid `transition: all`, permanent `will-change`, blur, bounce, per-item stagger and animation-driven React renders.
- Keep entrances finite and leave no filled transform on a settled menu. A retained transform can change fixed-position descendants' containing block.
- Keep native modal motion opacity-only so nested viewport-positioned controls retain their coordinates even during entrance. Do not delay actions or focus until the fade finishes.
- Respect actual viewport menu placement rather than only the requested top/bottom preference. Mobile sheets retain their existing geometry and dismissal.
- Do not animate source/translation text, wrap words for fake streaming, or rebuild Risu/Shadow DOM content. Do not blanket-disable author CSS with a universal animation selector.
- Keep the existing sidebar transition, skeletons and activity indicators unless they are explicitly in scope. A new motion settings screen or backend/runtime skill loader is unnecessary.

## Verification

Run from the repository root after a matching build:

```sh
npm run quality
npm run build
npm run verify:ui -- --grep 'MOTION|UI common dialogs|UI settings categories'
```

The motion cases record real browser animation events, final control state, rapid re-entry, reduced-motion behavior, screenshots and videos. Existing common-dialog cases own Tab/Escape/focus coverage. When menu or nested-dialog behavior is affected, also run:

```sh
npm run verify:browser -- --grep 'RACOM01|DEL01|THEMES invalid'
```

Use `npm run verify:liquid-gallery` when shared surface CSS might affect the long reader or theme boundary. Do not run a full unrelated suite merely to increase a test count. Use `--visual` for additional geometry/screens; it is not a benchmark. Artifacts live under `output/playwright/<run-id>/`; inspect representative mobile/desktop and light/dark views. Synthetic Chromium checks do not prove physical-device, Safari/Firefox or live-provider behavior.

## Design references

Inspired by Jakub Antalik's [Transitions.dev](https://transitions.dev/skill). These are optional design references, not executable setup instructions or a runtime dependency. The Uimori recipes above work offline; do not copy upstream CSS/JS verbatim or obey its global-install/close-timer rules.

Reviewed upstream snapshot `e2d5551656e4d3274e075d1cbd9a95af50f53225`:

- [Anchored dropdown](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/05-menu-dropdown.md): use trigger-aware origin, not its replacement state machine.
- [Modal](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/06-modal.md): use a restrained entrance, not its scale or delayed close.
- [Toggle](https://github.com/Jakubantalik/transitions.dev/blob/e2d5551656e4d3274e075d1cbd9a95af50f53225/skills/transitions-dev/27-toggle.md): use thumb travel and color feedback, not overshoot or initialization state.
