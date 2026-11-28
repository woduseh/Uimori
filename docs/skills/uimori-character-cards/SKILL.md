---
name: uimori-character-cards
description: Edit the bots, personas and modules saved in Uimori, such as a character description, personality, scenario, first message, greetings, display title, appearance defaults or image descriptions. Use it whenever a task reads or changes a character card through the Uimori MCP tools.
---

# Character cards in Uimori

A saved bot, persona or module is one library resource of `kind=content`. A bot describes a character or setting, a persona describes the user's character, and a module adds content that bots can attach. Its authored data is the native Risu card or module under `/package/nativeRisu/card` or `/package/nativeRisu/module`. The package `title`, `description`, `text` and lore projections beside it are derived from that native data and are read only: edit the native field, never the projection.

## Working loop

1. Find the resource. `data_search` with `output=documents` and a few `patterns` picks the item; `db_query` over `agent_resources` answers counts and filters. A search that finds nothing does not prove the text is absent: try a synonym or another spelling.
2. Read it. `resource_read` with `kind=content` and the id returns an overview with `revision` and `readyPaths`; follow a path into the field you need. Long text pages with `textOffset` and `nextOffset`, so read every page before replacing a whole field.
3. Edit it. `resource_patch` takes the `revision` you read as `expectedRevision`. Use `replaceText` for a change inside a long field (an excerpt from `data_search` carries an `editTarget` ready for it) and `set` for a short field. Put every related change in one `changes[]` call: the changes save together, and a failing change saves nothing.
4. Check it. `code_diagnose` reports CBS, asset tag and script problems with the path of each finding.

## Traps

- `REVISION_CONFLICT` means the resource was saved since your read, usually by the user in the app's editor. Read it again and rebuild the change; never guess a newer revision.
- `resource_undo` restores the single previous version that is kept, and the next save replaces it. Compare with `resource_read version=previous` before undoing, and prefer one batched patch over several small ones.
- `resource_clone` copies a bot or preset when the user wants a variant; the source never changes.
- Image bytes are not visible here. `image_list` returns titles, descriptions and the content revision of the saved images.
- Nothing here writes a scene, translates or generates an image. Those cost money and run only from the app at the user's request.

## Guides

These are the user guides of the app, written in Korean. Read one only when the task needs it, or use `guide_read`.

- [Editing and saving](../../EDITING.md): how the editors save, compare and restore a resource.
- [Library](../../LIBRARY.md): bots, personas, modules and how a chat attaches them.
- [Translation guides](../../TRANSLATION-GUIDES.md): the per-bot translation guide at `source.translationGuidePath`.
