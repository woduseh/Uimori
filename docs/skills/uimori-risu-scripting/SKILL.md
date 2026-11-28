---
name: uimori-risu-scripting
description: Write, fix and explain Risu CBS templates, Lua trigger scripts, regex scripts, triggers and variables in the bots, modules and prompt presets saved in Uimori, checking them without running a model. Use it for any CBS, Lua, regex or variable task through the Uimori MCP tools.
---

# CBS, Lua, regex and triggers in Uimori

Uimori runs Risu content natively: CBS (`{{...}}`) in card, lore and prompt text, Lua triggers, structured triggers and regex scripts, all stored in the native card, module or preset. The tools below check that code without a model call.

## Working loop

1. Survey. `code_diagnose` on the resource reports every problem with its `resource_patch` path, line and column: CBS syntax and unknown functions, asset tags without an image, malformed regex, triggers Uimori refuses, Lua syntax and unsupported features. Page with `offset`.
2. Trace variables. `code_references` lists where each variable and toggle is read and written, in CBS, Lua and triggers, with findings such as a variable read but never written. Run it before renaming or removing one; it indexes only this resource, so attached modules or the preset can still provide a value.
3. Edit. Read the field with `resource_read`, then `resource_patch` at the `revision` you read, with every related change in one `changes[]` call.
4. Check the edit. `code_cbs` checks one text or field, `code_regex` traces a text through the regex scripts, and `code_preview` renders a first message or a draft the way the reader would. `chat_variables_read` shows the live variable values of a chat.

## Traps

- A clean `code_diagnose` does not prove behaviour; confirm with `code_preview` or `code_regex`.
- CBS function names come from Uimori's evaluator: `guide_read name=CBS-REFERENCE` lists them with their aliases.
- `REVISION_CONFLICT`: read again and rebuild the change. `resource_undo` keeps one step per resource.
- Nothing here sends a request to a model; previews run scripts read-only.

## Guides

- [Risu Lua trigger API](../../RISU-LUA-API.md): the Lua functions Uimori provides and their limits.
- [Execution order of CBS, Lua, triggers and regex](../../RISU-RUNTIME-INTEROP.md): shared state, one request from start to finish, and which code runs again.
