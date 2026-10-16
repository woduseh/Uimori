# UI principles

Uimori is a writing and reading workspace. Keep the manuscript and composer prominent, frequent actions nearby, and occasional controls in contextual menus.

- Use familiar navigation and consistent names across desktop and mobile. Adapt the layout to available space; avoid stretching prose and long forms across wide screens.
- Reuse shared controls and icons. Give icon buttons accessible names, keep essential actions available without hover, and support keyboard and touch input.
- Show useful progress, errors, and unsaved changes without making execution logs the default view. Keep internal implementation terms out of ordinary product copy. Reversible settings such as enabling a provider or model apply immediately; do not add a second confirmation step.
- Preserve the user's place and unfinished work when opening panels, changing layouts, or returning from an editor. Respect [reading preferences](READING.md).
- Make each screen's primary action easy to find. Distinguish an empty collection, an empty folder, no search results, and a loading or failed request.
- In settings, place section titles above their panels and keep related controls in one group. Put names and short explanations together, with values and actions alongside; stack them on narrow screens. Use one divider between rows, without extra lines at the start or end of a group. Keep selection cards and status summaries where they communicate a real choice or state. Give image selection its own row and group related effect sliders below it.

Keep settings action groups aligned to the right below their content, and toggle names on the left with switches on the right. Repeated usage meters share the same column boundaries regardless of adjacent text length.

Apply the same grouping to chat settings and helper settings. Picker dialogs own their filter layout; compact controls in the surrounding composer must not shrink or restyle the dialog's search and folder fields.

Non-modal notices follow their purpose. Save and other completed-action feedback uses the shared bottom notice for four seconds without moving content or taking focus; it can remain visible after its settings panel closes. Unsaved drafts, conflicts, uncertain admission and failures stay near their affected operation until resolved or explicitly dismissed. Persistent reading and maintenance banners share message and action spacing, while execution progress keeps its compact activity bar. Maintenance details are available through a disclosure.

Settings failures and warnings use `NoticeBanner`, with retry or review actions kept beside the message. Library saves use the same completion notice as settings; classification or list-refresh failures after a successful save remain in a separate persistent banner. Changes that still need the parent resource to be saved remain near the edited field. Important change and deletion confirmations use the shared confirmation dialog and name the action on the confirm button.

A missing manuscript page stays quiet for the first 200 milliseconds, then shows a compact status and static paragraph-shaped placeholders aligned to the manuscript column (without simulating real text). After three seconds it adds a gentle slow-loading notice, not an invented percent or automatic retry. The progress icon uses the shared rotation and stays still when reduced motion is requested. Failed initial reads replace the placeholders with a vertically centered error and retry action; retrying keeps the error visible while showing a pending indicator and disabling duplicate clicks. Refresh failures keep the already-visible manuscript. Loading and error state follow the selected reader query and navigation epoch so stale responses cannot change the new page's status. Composer drafts remain editable, but sending waits for a ready reader. Missing-model warnings wait until reader, library, and role-model settings have loaded; a failed initial role-model lookup instead offers a retry.

Response waiting, empty response streams, translation preparation and input translation reuse that centered spinner and message. Already-visible response text and translations remain readable while work continues; empty, failed or cancelled results do not keep a loading spinner. Composer-menu actions share left alignment, icon spacing and normal text color; disabled actions retain their disabled appearance.

Check vertical centers as well as horizontal alignment: icon/text pairs, switch labels and neighboring action buttons keep consistent centers when text wraps. Empty helper conversations occupy the conversation area centrally; populated conversations retain their normal reading flow. A usage chart with no calls shows an empty-state message instead of instructions to select absent bars. Compact-screen navigation and translation controls keep the shared touch height. Identical completion messages replace the previous notice and renew its four-second lifetime.

On phones, resource editors keep the title and helper action in the first header row, with save and other editing actions in a second row. Their sticky section navigation follows the actual header height, including wrapped actions. Opening uploaded-image metadata gives its form the available width and releases the thumbnail grid's height limit; closing it restores the compact gallery. Scene-navigation page labels remain on one line so the navigation cannot cover nearby actions.

Explicitly reloading role-model settings asks before discarding a draft; failed reads preserve the draft and its revision. Settings tabs that depend on the library use the same loading, failure and retry surface. A mobile input-language menu closes on outside interaction or Escape and restores its opener's focus after Escape or selection.

Reloading edited execution settings also asks before discarding their draft. A failed refresh keeps already loaded choices and shows a retry banner; pending reads do not claim that a collection is empty. New-chat workspace reads and bot-default reads expose failure and retry separately from missing configuration. Export failures remain visible after their action menu closes. Collaboration controls follow the same order visually and by keyboard.

An acknowledged execution-settings save remains successful when the subsequent reader refresh fails; show that refresh failure separately. Successful deletion-scope reads clear only their own read error, preserving a failed stop or delete operation for review.

On Android, the viewport requests `interactive-widget=resizes-content` so the keyboard reduces the content area and the main composer stays at the bottom of the frame; the existing visual-viewport height logic remains for browsers that do not honor this option.

The application frame stays fixed when opening menus and panels from a long manuscript. Reading and dialog content scroll within their own surfaces; focusing a menu item must not move the header or sidebar outside the viewport.

Manuscript search uses independent pressed-state filter buttons for original text, translation and requests; multiple kinds can be selected. Filter buttons retain the shared control height. Empty-query title browsing remains available. With a query, matching chat titles are shown compactly in batches of five above a separate manuscript-results section. Global search stays open with its query, filters and results when the navigation changes between desktop, collapsed rail and mobile layouts.

Use the current components and styles as the starting point. [Library](LIBRARY.md) and [usage](USAGE.md) describe feature behavior; [DEVELOPMENT](DEVELOPMENT.md#verification) covers verification selection.

Detailed editor behavior is in [LIBRARY](LIBRARY.md#저장과-취소); helper sessions are in [READING](READING.md#helper-sessions).

## Korean terminology

Use the same terms in visible copy, accessible names and user documentation.

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
