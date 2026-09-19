# Manual Risu porting

Use the [built-in importer](RISU-IMPORT.md) first. Manual conversion is useful when a requested behavior needs a native Uimori representation beyond the importer's support. Inspect the relevant source behavior and dependencies; consult the source runtime when its semantics are unclear.

## Native representations

| Source behavior | Uimori reference |
| --- | --- |
| Preset messages, roles, options, conditions, and history placement | [PromptProgram](PROMPT-AUTHORING.md) |
| Character, persona, module text, instructions, and lore | [ContentPackage](PACKAGES.md) and [lore](LORE-CONTEXT.md) |
| Expressions, variables, triggers, state changes, and random choices | [Prompt runtime](PROMPT-RUNTIME.md) and [package behavior](PACKAGE-BEHAVIOR.md) |
| Regex replacements and conditional output display | [Text transforms](PROMPT-TRANSFORMS.md) and [source segments](SOURCE-SEGMENTS.md) |
| Scripted behavior and custom controls or views | [Extension programs](EXTENSION-PROGRAMS.md) and [package panels](PACKAGE-PANELS.md) |

Preserve the behavior the user needs, using common APIs. Pay attention to execution order and timing: sequential source writes may differ from effects that all read the same prior state, and source random choices may differ from recorded Uimori draws. Explain meaningful differences or unsupported behavior instead of claiming automatic equivalence.

## Check and register

Validate native data with `validateContentPackage` or `validatePromptProgram`. Check the relevant options and behavior through existing tests, `compilePackageAttachment` / `compilePromptProgram`, or the app's request preview. Choose checks for the conversion; a separate manifest, report, or test runner is unnecessary unless it helps deliver the result. Request preview checks request construction without calling a provider or exercising state changes; it does not establish model quality.

Import `ContentPackage` JSON in the library editor or `PromptProgram` JSON in the prompt editor, then save. For API registration:

- `POST /api/content` takes `{kind:"module", title:pkg.title, description:pkg.description, text:pkg.body ?? "", loading:"pinned", relatedIds:[], package:pkg}`. Select the appropriate content kind. Use the returned content ID and revision when attaching the package; the file's ID is not its registered content ID.
- `POST /api/prompt-presets` takes `{title, role:"main", text:"", program}`. Select the intended prompt role. Saving a preset does not select it for a chat.
- Updates use `PUT /api/content/:id` or `PUT /api/prompt-presets/:id` with the current `expectedRevision`.

The request wrappers and save behavior are defined in [product routes](../server/product-routes.ts) and [product store](../server/product-store.ts). Include any remaining conversion limitations with the delivered artifact.
