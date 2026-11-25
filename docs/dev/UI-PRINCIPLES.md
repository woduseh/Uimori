# UI principles

Uimori is a writing and reading workspace. Keep the manuscript and composer prominent, frequent actions nearby, and occasional controls in contextual menus. This document keeps the app visually and behaviorally unified: the means of unity below, the contracts that protect the user's work, and the Korean terminology. Feature behavior lives in the feature documents and their tests; the current components and styles are the starting point for any change.

## Working checklist

1. State the user's task, the screen's primary action and the observable result before implementation. Resolve routine layout choices from existing patterns.
2. Inspect the current screen and a relevant existing example. Put occasional actions in contextual menus and internal diagnostics in disclosures.
3. Build from the shared controls, Lucide icons and style tokens. A value the tokens do not cover enters as a new token in `web/style.css`, not as an ad hoc number. Review an external UI kit only against a concrete missing behavior.
4. Distinguish the states listed under [states](#states-and-feedback) and place feedback in the region it describes.
5. Preserve drafts, selections, reading position and focus across menus, panels, responsive changes and failures. Respect [reading preferences](../READING.md).
6. Check the changed flow with realistic Korean text and relevant data and state variations at the affected widths and themes. Inspect actual screenshots as well as interaction results. Use [DEVELOPMENT](DEVELOPMENT.md#verification) to select checks.
7. Update the owning component, style or feature document for adopted conventions, and this document only for app-wide ones. Keep investigation history and temporary proposals out of standing instructions.

## Means of unity

### Tokens

`web/style.css` defines the tokens on `:root`; themes override them through the public contract in [THEME-AUTHORING](../THEME-AUTHORING.md).

- **Type**: app chrome uses `--font-small` (12px) for metadata, `--font-body` (14px) for controls and body copy, `--font-heading` (16px) for section and dialog headings, and `--font-title` (18px) for page titles, dialog titles and the titles of empty states that fill a whole screen or collection. Use weight and spacing for further hierarchy. Reading preferences and authored Markdown and Risu content keep their independent typography.
- **Spacing**: gaps, padding and margins up to 32px use 0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28 or 32px; `tests/style-spacing.test.ts` enforces the scale. Controls in one column share a left edge, and side-by-side switches share the columns of the row above them.
- **Corners and surfaces**: use `--radius-small`, `--radius-control` and `--radius-panel`, with inner radii reduced by their padding. A filled control inside a rounded container keeps an even inset on every side. Prefer flat groups over nested cards and reserve `--shadow-float` and `--shadow-dialog` for floating surfaces. Borders and dividers use `--hairline`. Keyboard focus on app-owned controls uses a `--focus-ring` outline `--focus-ring-width` (2px) wide with an offset, visible on every surface; a container that clips overflow leaves room for it.
- **Color**: use the semantic color tokens, never a palette step directly. Named built-in palettes map the official Radix scales onto them: steps 1 and 2 for page backgrounds, 3 to 5 for control states, 6 to 8 for boundaries, 9 and 10 for solid actions, and 11 and 12 for text. Use `--accent-text` for text and `--accent` with `--accent-ink` for solid controls; hover uses both the hover background and the hover ink. Selected labels use the neutral text color over a restrained accent fill. Disabled actions neutralize their accent and destructive colors to the neutral text and surface tokens and dim once through the shared opacity, keeping their dimensions and pending indicators. Destructive controls keep their error tint on hover. In dark mode, dialogs and utility panels use the panel surface above the manuscript background. Use the stronger input boundary for editable controls. Preserve user-authored theme colors.
- **Motion**: `--motion-fast` (250ms) for state changes of a control such as a switch thumb, `--motion-panel` (250ms) for panel resizing, `--motion-overlay` (150ms) for the entrance of dialogs, menus, sheets, notices, tooltips and previews, `--motion-mark` (1600ms) for the fading outline that marks where a navigation landed, and `--motion-ease-out` for their easing. Reduced motion sets the durations to 0ms, and the landing outline stays static until the next pointer or key press. Dialogs, menus, sheets, notices and previews enter with a short fade and rise, tooltips only fade, and all of them close immediately; shared buttons and navigation rows ease their hover colours over `--motion-fast`. Activity indicators keep their separate purpose.

Motion guards:

- New motion runs only under `prefers-reduced-motion: no-preference`; the base state stays visible and usable without it.
- Animate compositor-friendly properties (`opacity`, `transform`) first, with specific transition properties rather than `transition: all`.
- Motion never shifts the manuscript layout, and source or translation text does not animate.
- A dialog keeps neither `transform` nor `will-change` at rest. Menus inside a dialog are `position: fixed`, and a transformed ancestor would move them. Entrance motion must end at `transform: none`.

### Shared controls

Reuse these before writing a variant: `web/Dialog.tsx` for native modal dialogs, `web/ConfirmDialog.tsx` for important change and deletion confirmations (the confirm button names the action), `web/ActionMenu.tsx` for anchored menus and their compact bottom sheets, `web/SettingsDetail.tsx` for a drill-down inside a settings section, `web/BooleanControls.tsx` for switches, `web/IconButton.tsx` for icon buttons with hint popovers, `web/ScrollStrip.tsx` for a single row of tabs that may overflow, `web/LoadingState.tsx` for loading regions, `web/NoticeBanner.tsx` for retained failures and warnings, and `web/TransientNotice.tsx` for completed-action feedback. App-owned single-choice selects use the native customizable picker with theme surfaces; multiple and size listboxes and authored Shadow DOM controls keep their own presentation. File pickers reuse the secondary-button style.

Use shared icon buttons for familiar actions and concise text where an icon alone cannot identify the action or its consequence, such as destructive confirmations and destination names. Group mixed-purpose action menus by task: common editing actions first, supporting information later, destructive actions separated at the end; conditional actions must not leave empty groups.

### Layout

Use familiar navigation and the same names across desktop and mobile. Adapt the layout to available space and avoid stretching prose and long forms across wide screens. Avoid a menu or disclosure around a single action or around a dialog's only content.

In settings, place section titles above flat groups of related controls, with one divider between rows and no card around the group. Names and short explanations stay together; toggle names sit on the left with switches on the right, and action groups align right below their content. Narrow screens stack the same order. Reversible settings, such as enabling a provider or model, apply immediately without a second confirmation. Repeated usage meters share column boundaries regardless of adjacent text length. A form or editor opened from a settings section replaces that section's content as a drill-down with a back control and a one-line location; on narrow screens the dialog header's back control leaves the drill-down first and the location shows only the current item; `Esc` and the browser back step leave it before they close settings. A drill-down form whose unsaved input would be lost on leaving asks before `Esc`, the back step or closing settings discards it. Only confirmations, saved-version reviews and pickers open as dialogs above settings. Picker dialogs own their filter layout; surrounding compact controls must not restyle it.

The application frame stays fixed when menus and panels open from a long manuscript; reading and dialog content scroll within their own surfaces, and focusing a menu item must not move the header or sidebar out of the viewport. In short desktop windows the sidebar contents scroll together so fixed controls cannot squeeze the bot list out of view.

Screen notes that no feature document or test states:

- Resource and prompt editors share one studio frame (`web/EditorStudio.tsx`) that fills the destination height and width: a one-row header, then a vertical section rail of `--studio-rail-w` beside the canvas on wide screens, or one section picker that opens the compact section list in an `ActionMenu` sheet on narrow layouts. Sections a content kind does not use by default and that hold no data sit under a **more** disclosure after the tablist (and at the end of the picker); the current section and any section with data or a pending draft always stay in the rail, so an edit never hides itself. The page never scrolls; the rail, the canvas and the list and detail panes of list sections each scroll on their own, so selecting a late item keeps the canvas at its top. Single-column sections center at `--form-w` inside the canvas. Actions that apply to the whole resource, such as starting a chat, live in the header, not below a section's content. The library and prompt lists keep a stable scrollbar gutter so switching between pages with and without overflow does not shift centered content.
- The library and prompt lists share one top structure: a header with the primary actions, a category tab row and a toolbar row, so their search fields sit at the same height. Header actions carry text labels while the header's container query leaves room and collapse to icon buttons with tooltips below it; the tooltip is hidden while the label shows.
- On narrow layouts, the editor header stays one row of back, title, the changes count (an icon and a number whose accessible name stays the full count), the category's use action (chat start for a bot), save, the resource menu and the helper (plus the navigation opener above phone widths); the save state is announced but not shown, and discarding edits lives only at the foot of the change review. The change review and the previous-save comparison share one large centred dialog (`--review-dialog-w` by `--review-dialog-h`) with a change rail beside the canvas; at phone widths it fills the screen and the rail folds into a picker above the canvas. A retained alert in the header takes its own row below. Opening uploaded-image metadata gives its form the available width; closing it restores the compact gallery.
- Scene-navigation page labels stay on one line. While the composer has focus, the latest-position control is hidden but keeps its row space, so a reader action cannot move between pointer press and release.
- Empty helper conversations place the composer near the middle above phone widths, name the conversation's subject and offer a few starting requests that fill the draft without sending. Helper answer actions start at the answer's text edge; on fine pointers, request actions appear beside the request bubble; code blocks keep their copy control in the corner.
- On compact screens, input translation and its language choice live in the composer menu and a running translation keeps its cancel control in the composer tool row. On wider screens the input-language menu closes on outside interaction or Escape and restores its opener's focus.
- Image-less bot and persona cards use a compact mobile identity row. When no selectable models exist, the setup action sits beside the primary model choices.
- Settings navigation shows destination names only; current values and unsaved-change feedback stay in the owning content. Font registration and deletion stay in a collapsible management area without losing input. Unlinked-memory review appears only when records exist, with its count before expansion and read errors outside the disclosure.
- The generation page owns one save action for its profile and execution editors: validate both before writing, keep each revision, and preserve unsaved input after a partial failure.
- Native editors delete an empty block, rule or trigger immediately and confirm one with content; reordering moves immediately.
- In the composer menu, the creative-options action itself marks unapplied changes and opens their review. Applying a combination copies its values and confirms its name in the completion notice, not as a persistent binding.
- A helper turn's status and collapsed usage share one row below the answer, status first; while the task is the one the composer's activity bar summarizes, its status sentence, elapsed time and queue count show only in that bar; an opened disclosure takes the full width, and a failure names a known cause (timeout, connection, rejected credentials, provider server error) before the generic message. Completed task-history rows put the request, status and result actions first.
- Manuscript search filters for original text, translation and requests are independent pressed-state buttons. Global search keeps its query, filters and results when navigation changes between desktop, collapsed rail and mobile layouts.
- Chat and assistant share one navigation shell. Preserve the user's collapsed navigation choice; only a contextual side panel that needs room beside the manuscript, or an open library or prompt editor on desktop, may collapse navigation temporarily. The navigation toggle expands it for that time, and the temporary state is never saved as the user's choice. On desktop the helper, the outline, creative options and the Story UI status board are tabs of one right side panel with one draggable width; a new surface beside the manuscript joins those tabs instead of opening a second panel, and the manuscript keeps at least `MIN_CENTER_WIDTH` (`web/side-panel.ts`). The docked panel adds no browser history entry, so Back navigates the app; the compact helper sheet and the expanded helper close on Back, and switching tabs keeps focus on the tabs.
- Settings search covers localized section names and fixed keywords and never indexes manuscript text or user-entered values. Keep it out of single-purpose confirmation dialogs.
- A missing manuscript page stays quiet for 200ms, then shows a compact status with static paragraph-shaped placeholders, and after three seconds adds a slow-loading notice.

## Contracts that stay

### User work

- Drafts, selections, reading position and focus survive menus, panels, dialogs, section changes, responsive changes, language changes and failures. A change of scope or presentation makes no write.
- A late response never replaces a newer selection, query, draft or saved result. Loading and error state follow the current query and navigation epoch.
- A write with an unknown outcome is not repeated automatically. Keep the original operation available for acknowledgement or explicit confirmation, and keep an acknowledged save successful when the following read fails; show that read failure separately.
- Reloading or refreshing edited settings asks before discarding a draft, and a failed read keeps the draft and its revision. Conflicts open the existing saved-version review; only an explicit choice adopts the reviewed state.
- Native dialog light dismissal, including a click outside, goes through the existing cancel and save-discard guard. A drag that starts inside does not dismiss it.

### States and feedback

- Distinguish initial loading, background refresh, inline work, empty collections, no search results, failure, unsaved work and completion. Keep already useful content visible while work continues.
- Loading uses `LoadingState`: a region filling its destination, a centered placeholder inside response or translation content, or an inline icon and message for a small operation. Keep the 200ms quiet window. Do not invent percentages or retry automatically. Empty, failed or cancelled results do not keep a spinner.
- A refresh keeps the matching result with a small progress indicator; a refresh failure keeps it and shows a nearby error with retry. A pending read does not claim that a collection is empty. Search-empty states offer search recovery; first-use guidance belongs only to genuinely empty collections.
- Read-only, disabled and invalid fields are distinguishable without preventing selection or recovery; untouched required fields are not errors.
- Retry sits beside the read it retries. Avoid permanent refresh controls where a view already refreshes on entry or relevant changes.
- Primary form saves show a short visible action (normally 저장, or 등록 for a new resource), an accessible name that includes it, and a spinner with pending text inside the same button, with stable size and no duplicate submission. Other operations do not present themselves as saving.
- Completed-action feedback uses the shared four-second notice without moving content or taking focus; identical messages renew it. Unsaved drafts, conflicts, uncertain admission and failures stay near their operation until resolved or dismissed.

### Access

- Give icon buttons and icon-only controls accessible names; show selection with a check or another shape as well as color, and keep nonvisual descriptions of color choices.
- Make essential actions available to keyboard and touch without hover. Compact-screen controls keep the shared touch height, and native switches have a 44px hit area around their visual track. Keep focus and the checked state on the native input.
- Visual and keyboard order match. Inside an open action menu, the arrow keys, `Home` and `End` move between its items without changing the Tab order; the command palette keeps focus in its search field and moves the highlighted result instead.

### Composers and helper results

- The main and helper composers follow one app send-key setting: by default `Enter` inserts a newline and `Ctrl/Cmd+Enter` sends. Korean composition never sends. Outside compact layouts, both placeholders name the current send key, with `Cmd` on Apple platforms.
- Helper results identify confirmed changed targets and open their current destination; deleted targets remain recorded without an open action. A locally measured input is labelled as an estimate, and its budget meter may appear in the usage disclosure or near the composer. Missing values remain unknown. Review and undo of helper changes follow [EDITING](../EDITING.md).

### Theme and authored content

- Preserve the public theme markers (`data-uimori-part` and the rest of [THEME-AUTHORING](../THEME-AUTHORING.md)) and user-authored theme colors.
- Authored manuscript, card HTML, Risu and Shadow DOM content are content boundaries: app styles and copy conventions do not rewrite them, and authored selection and typography take precedence.

## Korean terminology

Use the same terms in visible copy, accessible names and user documentation. App-owned labels follow the independent [UI language](../I18N.md); translated labels may wrap and must not depend on a width reserved for Korean text.

Write guidance in plain Korean 해요체 and use short action labels for controls. Name the affected object, observable result and next action; remove decorative encouragement, standing introductions and explanations that repeat a nearby label or button. Explain a non-obvious scope or irreversible effect once, at its choice or confirmation. Keep familiar domain terms such as 봇, 페르소나 and 로어, but explain internal execution terms in ordinary controls. Technical identifiers can remain in diagnostics where they help interpretation.

Keep Korean app notices and confirmation text together by word where possible, while allowing long names and addresses to wrap. Authored text retains its own typography.

Write for an experienced individual using a personal workspace: concise, neutral labels without chatter or invented terminology. Do not use middle dots as text separators. Arrange related metadata as separate aligned items, and use ordinary punctuation only where a single string is required. Do not alter authored text or old saved names to enforce copy conventions.

Distinguish reading or refreshing from saving, applying, discarding and acknowledging an alert. Preserve the conditions that matter for drafts, stored data, cost, failures and scope. Describe instructions sent to a model as requests rather than guaranteed outcomes. Update visible text, accessible names and the relevant user documentation together.

| Meaning | Term |
| --- | --- |
| Provider connections and services | 프로바이더 |
| Model input context | 컨텍스트 |
| Input preview for writing from an outline | 입력 컨텍스트 |
| Chat title | 채팅 제목 |
| Creating a chat | 새 채팅 |
| Numeric revision | 수정 번호 |
| Saved text or resource contents | 저장본 |

Keep application, file-format and authored card versions distinct from revisions. Preserve protocol identifiers and existing data. Cancellation and server interruption, presets and templates, and source text and manuscripts retain their separate meanings.
