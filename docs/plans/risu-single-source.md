# Risu source consolidation

Risu cards/modules and RISUP prompts are the authored content. Uimori stores original JSON, Lua, CBS, regular expressions and assets, then creates frozen projections for each execution. There is no second Uimori content language or legacy execution path.

Implementation boundaries:

- Keep server scheduling, concurrent chats, branches, story memory, provider connections and illustration generation.
- Use one configured TypeSafe AI / JEV connection for lore relevance, main/translation refusal and existing asset selection. Translation, summaries, image generation and original Lua model calls remain generative operations.
- Remove obsolete content/prompt ASTs, converters, behavior engines and their editors/tests.
- Initialize a fresh current database or reopen that same schema. Reject other schemas before mutation; never delete or migrate existing data automatically.
- Use Uimori naming for owned configuration and persisted identifiers; retain Risu and external specification names.

Completion evidence must cover type/lint checks, retained runtime/integrity tests, current export/import, JEV connection and attribution, and real-card browser flows. Synthetic transport checks do not establish live JEV judgment quality. Work ends with local commits; publishing and deployment are out of scope.

## Completed implementation and verification

- Authored content is `RisuContent.nativeRisu`; authored prompts are `RisuPrompt.nativeRisuPreset`. Removed Uimori content/prompt ASTs, behavior/extension engines, state extraction, editors and old-data migration paths. Card variables remain Lua-owned; notes, summaries, branch history and server jobs remain Uimori-owned.
- TypeSafe AI and JEV use the existing provider/model screens. Lore relevance, main/translation refusal and existing image selection use JEV; generative work and original Lua model calls keep their own routes. Failed or uncertain main judgment retains the candidate without automatic regeneration. Pre-generation Lua calls reserve the remaining main and judgment calls.
- Renamed owned configuration and runtime identifiers to Uimori without old aliases. Fresh/current schema 21 and current export formats are supported; existing files were not deleted or migrated.
- Final `npm run quality`, build and `git diff --check` passed. Final build: `37ae0b838ba5fb7f53b9084426039290e91b7884a62521e19dd3501f1a67e928`.
- The initial broad test run exposed obsolete fixtures. Those failures were corrected and rerun in their affected groups, including context, branches, backups, editing, model routing, collaborative calls and judgments. The entire suite was not repeated. Targeted tooling: 13 passed. Final Lua/main/JEV budget cases: 2 passed.
- TypeSafe/JEV browser flow: 3 cases passed, including credential save/delete, revision conflict and connection-test receipt. Requests were mocked; no real JEV account or paid call was used.
- Actual local Cheongwon High School, Harper and Fujimiya Hinano CHARX browser flows: 3 passed. Verified original first-message controls, variable changes, reload, branch isolation and a local synthetic writing turn. Screenshots were inspected. Receipt: `output/playwright/risu-native-samples-2026-09-19T15-32-14-716Z-45b38110/summary.json` (build `29bf4cf5`). The later Lua budget adjustment was covered by its two focused app tests and the final build, without repeating card/browser checks.
- These checks do not establish every Risu script's compatibility, live JEV classification quality, literary quality or production behavior. No push, deployment or existing-data deletion was performed.
