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

Use the current components and styles as the starting point. [Library](LIBRARY.md) and [usage](USAGE.md) describe feature behavior; [DEVELOPMENT](DEVELOPMENT.md#verification) covers verification selection.

Detailed editor behavior is in [LIBRARY](LIBRARY.md#저장과-취소); helper sessions are in [READING](READING.md#helper-sessions).
