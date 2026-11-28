---
name: uimori-prompt-presets
description: Edit the prompt presets saved in Uimori, such as prompt template blocks, their order, toggles, variables and saved values, and find out what a preset actually sends. Use it for any prompt preset task through the Uimori MCP tools.
---

# Prompt presets in Uimori

A prompt preset is a library resource of `kind=prompt-preset`: a native Risu preset with a prompt template, toggle declarations and saved values. The display title and the native preset name are separate fields.

## Working loop

1. Find and read. `data_search` with `kinds=["prompt"]`, or `db_query` over `agent_resources`. `resource_read` at the `promptTemplate` path lists each block's id, name, type, roles and text lengths; pass `includeBodies` for the text.
2. Edit. `resource_patch` at the `revision` you read: `move` reorders blocks, `insert` and `remove` add and drop them, `replaceText` and `set` change their text. Editing toggle definitions resets or removes saved values that became invalid and lists them in `resetKeys`. Batch related changes in one `changes[]` call.
3. Validate. `preset_validate` reports toggle declaration and value problems and option changes since the previous save. `code_diagnose` and `code_cbs` check the CBS in the blocks.
4. See the result. `chat_preview` assembles the next request of a chat with its preset, lore and history, lists the prompt messages in order and says which blocks were left out and why.

## Traps

- `resource_clone` copies a preset when the user wants a variant; it keeps blocks, toggles and current values.
- `REVISION_CONFLICT`: read again and rebuild the change. `resource_undo` keeps one step per resource.
- Nothing here sends a request to a model. `chat_preview` estimates tokens without sending.

## Guides

- [Risu prompt preset fields](../../RISU-PRESET-FIELDS.md): what each native preset field does in Uimori.
- [Native prompt runtime](../../PROMPT-RUNTIME.md): how a preset becomes the messages of one request.
- [Built-in prompts](../../BUILTIN-PROMPTS.md): the presets Uimori ships with.
