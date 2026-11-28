---
name: uimori-lorebooks
description: Read, write and reorganize lorebook entries of the bots and modules saved in Uimori, including their keys, content and order, and explain why an entry reached or missed the writer. Use it for any lorebook or world-info task through the Uimori MCP tools.
---

# Lorebooks in Uimori

Lore entries belong to a bot (`/package/nativeRisu/card/character_book/entries`) or a module (`/package/nativeRisu/module/lorebook`). Pinned entries always load; the others are selected per request, so finding an entry in the card does not prove the writer received it. A chat can also override lore for that chat only; that is chat state, not part of the card, and these tools do not change it.

## Working loop

1. Locate entries. `data_search` with `patterns` for a name or phrase returns excerpts with refs and an `editTarget`. `paths` limits the search to the lorebook path.
2. Read the array. `resource_read` at the lorebook path pages the entries with `offset` and `limit`; each editable entry carries a `target` anchor for this revision.
3. Edit. One `resource_patch` call with the `revision` you read: `insert` and `remove` at an indexed position, `set` or `replaceText` on a field. Address an existing entry by its `target` anchor with a relative `path` such as `/content`, so earlier inserts or removals in the same call do not shift it. Batch the whole reorganization into one `changes[]`.
4. Check. `code_diagnose` with `sections=["lore"]` lists empty or repeated key fragments and entries without keys; entry content that uses CBS is covered by the `cbs` section.
5. Explain selection. `scene_lore` shows what the writer actually received for a saved scene, and `chat_preview` shows the lore the next request would carry. Both read a chat only.

## Traps

- `REVISION_CONFLICT`: read again and rebuild the change from the new array; indexes may have moved.
- `resource_undo` keeps one step per resource, so one batched patch can be taken back in full and five small ones cannot.
- Nothing here generates text or runs a paid model call; `chat_preview` assembles the next request without sending it.

## Guides

- [Lore selection and context](../../LORE-CONTEXT.md): pinned and selected lore, folders, budgets and retention.
- [Editing and saving](../../EDITING.md): how the editor saves and restores a resource.
