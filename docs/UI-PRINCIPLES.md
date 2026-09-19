# UI principles

Uimori is a writing and reading workspace. Keep the manuscript and composer prominent, frequent actions nearby, and occasional controls in contextual menus.

- Use familiar navigation and consistent names across desktop and mobile. Adapt the layout to available space; avoid stretching prose and long forms across wide screens.
- Reuse shared controls and icons. Give icon buttons accessible names, keep essential actions available without hover, and support keyboard and touch input.
- Show useful progress, errors, and unsaved changes without making execution logs the default view. Keep internal implementation terms out of ordinary product copy.
- Preserve the user's place and unfinished work when opening panels, changing layouts, or returning from an editor. Respect [reading preferences](READING.md).
- Make each screen's primary action easy to find. Distinguish an empty collection, an empty folder, no search results, and a loading or failed request.

Use the current components and styles as the starting point. [Library](LIBRARY.md) and [usage](USAGE.md) describe feature behavior; [QUALITY](QUALITY.md#verification) covers verification selection.

## Helper sessions and branches

A chat branch can have multiple helper sessions, selected in one panel. Conversation history, drafts, context, and permissions belong to the session. The list includes sessions from other branches: users can read them, then navigate to the owning branch to send requests or make changes. Moving between branches restores that branch's session selection; switching sessions or closing the panel does not cancel work. Sessions use the global helper model.

Setting a branch as the default changes which branch opens when entering the chat. It does not merge or copy content, move running requests, or redirect an already open reader. A chat has one default branch; choose another before deleting it.
