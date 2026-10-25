# UI principles

Uimori is a writing and reading workspace. Keep the manuscript and composer prominent, frequent actions nearby, and occasional controls in contextual menus.

## Working checklist

1. State the user's task, the screen's primary action, and the observable result before implementation. Resolve routine layout choices from existing patterns.
2. Inspect the current screen and a relevant existing example. Keep the manuscript and composer prominent; put occasional actions in contextual menus and internal diagnostics in disclosures.
3. Reuse the app's shared controls, Lucide icons, and style tokens. Review an external UI kit against a concrete missing behavior or pattern; preserve app themes and authored-content boundaries.
4. Group settings by task: section title, related controls, then actions. Keep names and short explanations together, align values/actions, and stack the same order on narrow screens. Show each useful explanation once.
5. Distinguish initial loading, background refresh, inline work, empty collections/folders, no search results, failure, unsaved work, and completion. Place feedback in the region it describes; follow the detailed state contracts below and keep already-useful content visible.
6. Preserve drafts, selections, reading position, and focus across menus, panels, responsive changes, and failures. Make essential actions available to keyboard and touch users without requiring hover. Respect [reading preferences](READING.md).
7. Check the changed flow with realistic Korean text and relevant data/state variations at the affected widths and themes. Inspect actual screenshots as well as interaction results; capture success alone is not design acceptance. Use [DEVELOPMENT](DEVELOPMENT.md#verification) to select checks.
8. Update the owning component/style and this document only for adopted conventions. Keep investigation history, temporary proposals, and duplicate token/verification tables out of standing instructions.

## Layout and state contracts

Avoid a menu or disclosure around a single action or around a dialog's only content. Helper history opens directly from its icon; the last-scene lore dialog shows its records directly. Request preview waits for text or a prepared image at its originating control. Keep recovery states and retry beside the content they load.

Fieldsets provide semantic grouping without browser-default borders or padding; add a boundary only when the owning layout needs one. On compact screens, native switches have a 44px hit area around their 26px visual track. Keep keyboard focus and the actual checked state on the native input.

Use familiar navigation and consistent names across desktop and mobile. Adapt the layout to available space; avoid stretching prose and long forms across wide screens. Give icon buttons accessible names and make each screen's primary action easy to find. Keep internal implementation terms out of ordinary product copy.

App chrome uses three font sizes: 12px for metadata, 14px for controls and body copy, and 16px for headings. Use weight and spacing for further hierarchy. Reading preferences and authored Markdown/Risu content keep their independent typography. Use the shared 0.5px hairline for borders, dividers and focus outlines; a high-contrast focus color and offset keep keyboard focus visible. Icon strokes and checkbox glyphs retain their legible symbol geometry. Prefer flat groups over nested cards, reserve shadows for floating surfaces, and use the shared 4px, 6px and 10px corner tokens with inner radii reduced by their padding.

Named built-in palettes use the official Radix scales through semantic theme tokens: steps 1–2 for page backgrounds, 3–5 for control states, 6–8 for boundaries, 9–10 for solid actions, and 11–12 for text. The default layout uses halo cream and blue-black ink: dark mode pairs the favicon background `#14141b` with cream `#ffe5c8`, while light mode uses warm paper and slate ink. The six named palettes and explicit palette selections retain their colors. Use `accent-text` for text and `accent` with its matching ink for solid controls; hover uses both hover background and hover ink. Preserve user-authored theme colors. Menus and dialogs appear immediately. Necessary state transitions use 250ms ease-out and become immediate with reduced motion; activity indicators retain their separate purpose.

Selected labels use the neutral text color over a restrained accent fill; checks and icons may retain the accent. Check actual selected and hovered backgrounds as well as the page when evaluating text contrast. Disabled action buttons neutralize their accent and destructive colors while retaining their dimensions and pending indicators. In dark mode, dialogs and utility panels use the panel surface above the manuscript background. Keep decorative dividers subtle and use the stronger input boundary for editable controls.

App-owned labels follow the independent [UI language](I18N.md). Allow translated scene badges and representation controls to wrap without overlap; do not reserve a fixed width based on Korean text. Retained notices carry message identity to the shared notice host, which translates at render time without restarting the completion timer. Authored manuscript and card HTML remain content boundaries.

The header model control opens a searchable picker and changes only the current chat's main model pin. Restoring the default removes only that model pin. The helper header uses the same picker presentation for the global helper role, with that scope and next-request timing stated once. Keep prompt pins, other profile fields and unrelated role assignments intact. Acknowledged saves remain successful if the following read fails; failed or uncertain writes are not automatically repeated.

Mobile app and chat settings open their last available section directly, with a single header selector showing the current section. Explicit destinations take priority; unavailable conditional sections fall back safely. Remember only section identifiers. Keep the full list/search accessible and preserve draft, focus and scroll state between sections. The generation page owns one save action for its profile and execution editors: validate both before writing, keep each independent revision, and preserve unsaved input after a partial failure.

Starting a chat from a known bot uses saved defaults directly when the selected materials are ready and no opening choice remains. Keep an explicit configure-first action in the bot and resource menus. Multiple openings, unavailable configuration and read failures open the normal form. Capture the original choices before admission, preserve pending profile recovery, never retry unknown creation automatically, and do not redirect after the user leaves the creation flow.

The latest scene retains its direct editing and representation controls. Earlier scenes keep a bookmark and a menu, with the current representation shown compactly. Copy, editing and representation changes remain keyboard/touch accessible in that menu. Translation admission, active work and recoverable failures keep their immediate status and retry controls visible.

In settings, place section titles above flat groups of related controls. Use one divider between rows, without extra lines at the start or end of a group or another card around the group. Keep selection cards and status summaries where they communicate a real choice or state. On compact screens, fold desktop panel sizing behind its own heading. Give image selection its own row and group related effect sliders below it. Reversible settings such as enabling a provider or model apply immediately without a second confirmation step.

Let titles, values and nearby actions explain the layout. Omit navigation subtitles that repeat a title, repeated scope lines, missing-description filler and empty-state instructions that repeat visible actions. Keep a single identity area in resource details. Name navigation destinations for their actual contents instead of adding subtitles. Search fields may use a search icon and a concise placeholder while retaining an accessible name. Show selection with a check mark or another shape as well as color; preserve nonvisual descriptions of color choices. Search-empty states offer search recovery; first-use guidance belongs only to genuinely empty collections. Preserve authored descriptions, accessible names, application timing, cost, data preservation and recovery meaning. Place desktop-only panel settings together, and name a setting's actual effect rather than compensating for an ambiguous name with a paragraph.

Creative options use one editor with a next-generation-only scope switch. Changing scope preserves edits and makes no write; saved one-off reservations remain visible with their own cancellation action. Saving fixed values and reserving one-off values stay distinct, including during conflicts or an uncertain response.

The card-variable editor keeps an uncertain save's exact request available for explicit result confirmation during background refreshes. Acknowledgement ends the superseded read's loading state; a late read cannot replace the saved result or a newer draft.

Keep settings action groups aligned to the right below their content, and toggle names on the left with switches on the right. Repeated usage meters share the same column boundaries regardless of adjacent text length.

Apply the same grouping to chat settings and helper settings. Picker dialogs own their filter layout; compact controls in the surrounding composer must not shrink or restyle the dialog's search and folder fields.

Loading feedback has three presentations in the shared LoadingState: a region that fills and centers within the available destination or panel, a centered placeholder inside response/translation content, and an inline icon/message for a small operation. Initial panel loading keeps the header and navigation available and uses the same region while its module and data arrive. Keep the 200ms quiet window and existing read/retry/cancellation owners. Manuscript loading follows its separate skeleton contract below.

Refreshing a loaded result keeps the matching result visible with a small progress indicator. A refresh failure keeps that result and shows a nearby error with retry; changing the query must not present a previous query's result as current. Section-local empty lists use compact spacing, without the viewport-sized padding of a whole-screen empty state.

Primary form saves show a short visible action (normally 저장), the full accessible action name, and a spinner with pending text inside the same button during that save. New-resource registration uses 등록. The accessible name includes the visible action in each UI language. Keep its size stable and prevent duplicate submission. Other operations such as reload, backup, or connection tests must not appear as saving. Existing narrow icon toolbars remain icon-only and use the same pending icon without adding a second action row.

Non-modal notices follow their purpose. Save and other completed-action feedback uses the shared bottom notice for four seconds without moving content or taking focus; it can remain visible after its settings panel closes. Unsaved drafts, conflicts, uncertain admission and failures stay near their affected operation until resolved or explicitly dismissed. Persistent reading and maintenance banners share message and action spacing, while execution progress keeps its compact activity bar. Maintenance details are available through a disclosure.

Settings failures and warnings use `NoticeBanner`, with retry or review actions kept beside the message. Library saves use the same completion notice as settings; classification or list-refresh failures after a successful save remain in a separate persistent banner. Changes that still need the parent resource to be saved remain near the edited field. Important change and deletion confirmations use the shared confirmation dialog and name the action on the confirm button.

A missing manuscript page stays quiet for the first 200 milliseconds, then shows a compact status and static paragraph-shaped placeholders aligned to the manuscript column (without simulating real text). After three seconds it adds a gentle slow-loading notice, not an invented percent or automatic retry. The progress icon uses the shared rotation and stays still when reduced motion is requested. Failed initial reads replace the placeholders with a vertically centered error and retry action; retrying keeps the error visible while showing a pending indicator and disabling duplicate clicks. Refresh failures keep the already-visible manuscript. Loading and error state follow the selected reader query and navigation epoch so stale responses cannot change the new page's status. Composer drafts remain editable, but sending waits for a ready reader. Missing-model warnings wait until reader, library, and role-model settings have loaded; a failed initial role-model lookup instead offers a retry.

Response waiting, empty response streams, translation preparation and input translation reuse that centered spinner and message. Already-visible response text and translations remain readable while work continues; empty, failed or cancelled results do not keep a loading spinner. Composer-menu actions share left alignment, icon spacing and normal text color; disabled actions retain their disabled appearance.

Check vertical centers as well as horizontal alignment: icon/text pairs, switch labels and neighboring action buttons keep consistent centers when text wraps. Empty helper conversations occupy the conversation area centrally; populated conversations retain their normal reading flow. A usage period with no calls keeps the totals and period controls, then shows one compact empty message in place of empty charts and breakdowns. Calls with zero known cost or unknown/partial cost still show their records. Keep coverage and undated-call evidence available. Completed task-history rows prioritize the request, status and result actions; their existing usage and execution disclosures share a compact row and expand to full width. Detailed token/context summaries stay inside those disclosures. Pending context, failures, partial output and recovery actions remain visible. Compact-screen navigation and translation controls keep the shared touch height. Identical completion messages replace the previous notice and renew its four-second lifetime.

On phones, resource editors keep the title and helper action in the first header row, with save and other editing actions in a second row. Their sticky section navigation follows the actual header height, including wrapped actions. Opening uploaded-image metadata gives its form the available width and releases the thumbnail grid's height limit; closing it restores the compact gallery. Scene-navigation page labels remain on one line so the navigation cannot cover nearby actions. Compact readers open the scene list from the title with the current position alongside the chat context. Latest-position actions reuse the compact composer's tool row without reserving a new line, disappear during composer input or source editing, and never overlay prose. Hiding the navigator's visual controls must not disable the header scene-list shortcut. While the composer has focus, hide the latest-position control while preserving its row space so moving focus to a reader action cannot move that action between pointer press and release. Image-less bot/persona cards use a compact mobile identity row while portrait cards and saved card/list preferences retain their layout. When no selectable models exist, place the setup action beside the primary model choices.

Explicitly reloading role-model settings asks before discarding a draft; failed reads preserve the draft and its revision. Settings tabs that depend on the library use the same loading, failure and retry surface. A mobile input-language menu closes on outside interaction or Escape and restores its opener's focus after Escape or selection.

Reloading edited execution settings also asks before discarding their draft. A failed refresh keeps already loaded choices and shows a retry banner; pending reads do not claim that a collection is empty. New-chat workspace reads and bot-default reads expose failure and retry separately from missing configuration. Export failures remain visible after their action menu closes. Collaboration controls follow the same order visually and by keyboard.

An acknowledged execution-settings save remains successful when the subsequent reader refresh fails; show that refresh failure separately. Successful deletion-scope reads clear only their own read error, preserving a failed stop or delete operation for review.

On Android, the viewport requests `interactive-widget=resizes-content` so the keyboard reduces the content area and the main composer stays at the bottom of the frame; the existing visual-viewport height logic remains for browsers that do not honor this option.

The application frame stays fixed when opening menus and panels from a long manuscript. Reading and dialog content scroll within their own surfaces; focusing a menu item must not move the header or sidebar outside the viewport.

Manuscript search uses independent pressed-state filter buttons for original text, translation and requests; multiple kinds can be selected. Filter buttons retain the shared control height. Empty-query title browsing remains available. With a query, matching chat titles are shown compactly in batches of five above a separate manuscript-results section. Global search stays open with its query, filters and results when the navigation changes between desktop, collapsed rail and mobile layouts.

Use the current components and styles as the starting point. [Library](LIBRARY.md) and [usage](USAGE.md) describe feature behavior; [DEVELOPMENT](DEVELOPMENT.md#verification) covers verification selection.

Detailed editor behavior is in [LIBRARY](LIBRARY.md#저장과-취소); helper sessions are in [READING](READING.md#helper-sessions).

Chat option editing refreshes automatically when idle and preserves drafts when settings change elsewhere. Keep read retries next to read failures; do not expose separate manual refresh/rebase controls. Saving, reserving or cancelling with a conflict opens the existing saved-version review. Closing the review changes no input or revision. Only an explicit choice adopts the reviewed state, either retaining compatible local edits or discarding drafts. Name excluded inputs before the choice, preserve unrelated saved edits, and require a separate save/reservation afterward. Unknown write outcomes keep the original operation for acknowledgement.

## Korean terminology

Settings navigation may show short current-value summaries from already loaded state. Keep destination names stable, omit unknown values, and show unsaved changes instead of presenting a saved value as the current draft. Font previews follow the selected app or manuscript target; font registration and deletion stay in a collapsible management area without losing input. Show unlinked-memory review only when records exist, with its count before expansion and read errors outside the disclosure.

Group mixed-purpose action menus by task, with common editing actions first, supporting information later, and destructive actions separated at the end. Use short headings for long menus; compact menus can use dividers alone. Keep homogeneous choice lists ungrouped. Conditional actions must not leave empty groups, and nested export/delete controls retain the same mobile touch height as other items.

Use the same terms in visible copy, accessible names and user documentation.

Write guidance in plain Korean 해요체 and use short action labels for controls. Name the affected object, observable result and next action; remove decorative encouragement and explanations that repeat a nearby label or button. Keep familiar domain terms such as 봇, 페르소나 and 로어, but explain internal execution terms in ordinary controls. Technical identifiers can remain in diagnostics where they help interpretation.

Write for an experienced individual using a personal workspace: concise, neutral labels without chatter or invented terminology. Do not use middle dots as text separators. Arrange related metadata as separate aligned items, and use ordinary punctuation only where a single string is required. Familiar secondary actions may use Lucide icons with accessible names; keep primary actions and unfamiliar destinations named. Do not alter authored text or old saved names to enforce copy conventions.

Avoid permanent refresh controls when an ordinary view already refreshes on entry or relevant changes; offer retry beside failed or stale reads. Resolve option-save conflicts through the shared review dialog, preserving drafts and save revisions until an explicit decision. Keep developer-only setup in the existing test mode, and hide mode-inapplicable fields without clearing their saved values.

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
