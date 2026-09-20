# UI recovery v3 — representative screen review

Review date: 2026-09-20. Scope: native preset editor, native bot editor, and reader first-message presentation. This is the agreed representative-screen checkpoint before extending the remaining v3 screens. It is not completion of the entire 36-screen set or human aesthetic acceptance.

The sections before **Follow-up: user feedback on density and native editing** record the earlier `4c85abc` checkpoint. Its follow-up records `5e1bd1a`. Those test totals are historical; the final follow-up section owns the current result.

## Visual truth and capture conditions

Source folder: `C:/Users/wodus/Downloads/Uimori_UI_Recovery_v3`.

- Preset composition: `screens/03_prompt_blocks.png`, `pages/03_prompt_blocks.html`.
- Bot basic information: `screens/12_bot_basic.png`, `pages/12_bot_basic.html`.
- Reader: `screens/18_chat_opening.png`, `pages/18_chat_opening.html`.
- Mobile adaptation: `screens/30_mobile_chat.png`, `screens/31_mobile_editor.png`.

The separate generated mood-image folder supplies atmosphere only; its unagreed features and copy are not requirements. The app's existing logo, icon library, font stack, tokens, and saved reading preferences remain the product design system. The supplied library image is used only in the isolated visual fixture, not added as a built-in user bot.

Source desktop PNGs are 2880 × 1800 pixels at 1440 × 900 CSS px, 2× density. The requested test viewport is 2560 × 1440 CSS px, with a 412 px mobile width; 915 px is the selected mobile test height. Requested-size browser evidence uses 1× density. Additional 1440 × 900 captures use 2× density, matching the source PNG dimensions exactly. Reference-size captures supplement, rather than replace, the requested dimensions.

The source mobile PNGs are 1170 × 2532 at 390 × 844 CSS px (3×), as recorded in the supplied README. Mobile evidence at the user-requested 412 px width is an adaptation review; it is not a same-viewport pixel comparison. Exact density-normalized source comparisons use the desktop states described above.

Implementation: `http://127.0.0.1:4317/`, isolated `output/ui-recovery-preview/preview.sqlite`. No operating database or source card is modified. Editor screenshots use saved synthetic native documents; actual private cards are covered separately. The reader fixture contains a first message only, while source screen 18 also shows a later generated scene. Compare the common first-message region; do not infer pixel equivalence from different text or scene counts.

## Resolved findings and comparison history

| Severity | Earlier finding | Implemented fix | Post-fix evidence |
| --- | --- | --- | --- |
| P1 | Library heading, editor heading, and draft strip repeated the same context above the form. | One editor header with back, title, draft status, save, more, and helper; detailed draft controls remain in a dialog. | Final bot/preset captures and browser save/export flows. |
| P2 | The bot header was centered inside an inherited narrow container. | Full-width editor header; readable basic form width is independent. | Final desktop bot capture. |
| P2 | Mobile header controls and negative margins caused horizontal overflow. | 44 px icon save control, accessible label, compact draft control, and explicit editor padding. | Both editor sizes assert no horizontal overflow and save remains in the viewport. |
| P2 | A real preset's long block list made the whole page excessively tall. | Desktop list and detail scroll independently; mobile uses an item picker. | Real Phémē inspection and final preset captures. |
| P2 | A plain native first message gained an unnecessary internal scrollbar from collapsed final-paragraph margins. | Frame body establishes a flow root and measures content with its bottom spacing. | Short-message/frame tests at both sizes, including 18 → 26 → 14 px resizing; final reader capture. |
| P2 | Native message defaults did not track app font size and theme. | Trusted appearance updates inherit reading defaults without resetting authored controls or overriding explicit card CSS. | Appearance/browser tests and manual dark reader inspection. |

## Required fidelity surfaces

- Typography: preserve the existing app font stack; ordinary prose inputs use readable proportional text and raw JSON retains its code treatment. Mobile inputs are 16 px. Reader default text is 18 px with user-selected line height and width. Long titles truncate to preserve persistent actions; accessible button names remain available.
- Spacing/layout: one header and one tab row, desktop list/detail split, compact mobile picker, limited-width bot basic form, and unboxed reader prose. Long lists and long documents scroll without hiding save/navigation controls.
- Colors/tokens: dark olive/neutral surfaces, muted dividers, green selection/save emphasis use existing theme tokens. Light-theme regression screenshots are separate coverage, not a color match to the dark source.
- Assets/icons: retain supplied card images and the existing product icon library. No invented raster decoration or substitute CSS artwork. Real-card CHARX export/reimport preserves all checked image hashes: Cheongwon 134, Hinano 114, Vela 3.
- Copy/content: labels follow native Risu data. Retired personality/scenario/system-prompt fields and memory-extraction controls are absent. No invented short-introduction field is added solely to imitate the mock. First authored message is labelled separately; generated scenes start at 1.

## Intentional constraints and follow-up

- The source's sample documents and sidebar contents differ from real imported documents. Raw CBS, unknown fields, and authored image/control content are preserved rather than rewritten for screenshot similarity.
- Native preset/body editors save current Risu documents and export CHARX/RISUP. Standalone RISUM export and flattening externally linked library modules into CHARX are outside the accepted implementation scope.
- Existing composer actions and navigation remain functional. Extending every remaining v3 screen is deferred until the representative layout/density review.
- Author-authored fixed-position mobile content is not automatically redesigned. Cheongwon's internal right icon rail overlaps some Settings labels at 412 px; this is a source-card layout limitation, distinct from host overflow checks. Vela's default greeting has no buttons; its two alternate greetings are covered by runtime tests.
- P3: mobile portrait editing currently exposes upload, selection from existing images, and removal as separate actions. All basic fields remain accessible, but this uses more vertical space than the simplified mock. Condensing these actions is an optional density refinement.
- P3: the mobile save control is a labelled 44 px header icon, instead of the mock's bottom text button. Additional bot tabs use horizontal scrolling, whose discoverability could be strengthened. These controls pass the interaction/visibility checks; user visual review should settle the preferred presentation before expansion.
- P3: finer spacing/color preferences and the preferred overall editor density remain a user visual-review question. No claim is made about live-provider creative quality, physical-device IME, or every script/scenario.

## Interaction and regression evidence

- `npm run quality`: Biome and TypeScript passed.
- `npm test`: 200 files passed, 2 skipped; 2062 tests passed, 8 skipped. Log: `output/ui-recovery-preview/unit.log`. Actual-data tests are opt-in and separately exercised below.
- `npm run verify:ui-recovery`: 26/26 passed. Receipt: `output/playwright/ui-recovery-2026-09-20T01-35-48-173Z-62585201/summary.json`. Covers tabs, draft preservation, invalid inputs, save/export revision gating, downloaded CHARX/RISUP reimport, retired import UX, iframe isolation and appearance. Light-theme editor PNGs are under that run's `browser/` directory.
- Actual-card runner: 3/3 passed for Cheongwon, Hinano, Vela with local Phémē preset at both requested widths. Receipt: `output/playwright/risu-native-samples-2026-09-20T01-36-12-345Z-5e196cf5/summary.json`. Initial controls where present, local images, selection variables, reload, branch isolation and a loopback-model next turn were tested; original SHA values were unchanged and no external requests occurred.
- Both browser receipts identify build `3cda80f938c69b55ce12c23de2196ac257b59631080ecb77bf3a0445f20b57e5` and passed final identity checks. Later edits are documentation only.
- Real CHARX export/reimport: `output/ui-recovery-preview/actual-roundtrip.json`; three cards passed preserved supported source fields and image hashes.
- IAB manual preview: primary editor navigation, longer real preset, first-message rendering, settings changes and dark theme inspected. No console warning/error observed in the final inspection.

## Final visual comparison

Final implementation screenshot folder: `output/ui-recovery-preview/captures/`.

- Requested-size dark captures: `dark-{bot,preset,chat}-2560x1440.png` and `dark-{bot,preset,chat}-412x915.png`.
- Same-density reference captures: `dark-{bot,preset,chat}-1440x900-2x.png` (2880 × 1800 pixels).
- Full-view comparison inputs: `compare-{bot,preset,chat}-full.png`. Each contains the source on the left and implementation on the right; both are downsampled from 2880 × 1800 to 1440 × 900 using the same procedure. Reviewed together, not inferred from separate filenames.
- Focused typography/header/tab inputs: `compare-{bot,preset,chat}-header.png`. Source is above implementation, with identical crop and 2× → 1× normalization. These make text, icons, saved/disabled state and tab spacing readable without full-page reduction.
- Each dark capture has a corresponding JSON containing CSS viewport, DPR, theme, horizontal overflow and save bounds. All 9 captures have zero document overflow; editor captures have zero editor overflow and save inside the viewport. The screenshot-only run passed all 3 viewport cases with no page errors.
- Full-view and focused comparisons show the intended single-header hierarchy, native list/detail composition, readable description/first-message content and retained image subject/crop. The preset save button is disabled in its unchanged saved state; the mock shows a dirty enabled state, and the separate editor regression verifies enabled-save behavior. Sidebar contents, sample prose, omitted unsupported fields, user-configurable reader width and later-scene count are expected differences, not pixel-match assertions.
- No actionable P0/P1/P2 remains within the representative-screen scope. The P3 density/discoverability choices above and the source-card mobile limitation remain explicit follow-up items.

Implementation checklist: foundation/native cleanup complete; three representative screens implemented; desktop/mobile interactions and visual comparisons complete; user aesthetic checkpoint pending before remaining-screen expansion.

Previous representative-screen result: passed. Superseded by the user feedback and follow-up review below; the earlier overflow checks did not establish comfortable density or long-list legibility.

## Follow-up: user feedback on density and native editing

The current visual authority is the user's nine supplied screenshots and explicit request to use Codex/ChatGPT-like centered working widths, native regex form editing, simpler scene navigation and less information in the new-chat dialog. These instructions supersede the earlier full-width/left-aligned interpretation of v3.

Reference images: `output/ui-recovery-preview/user-feedback-refs/01.png` through `09.png` are exact copies of the supplied screenshots. Images 01–03 show the editor issues; 04–05 show RisuAI/RisuToki regex forms; 06 establishes the centered-workspace reference; 07–09 show scene navigation, translation editing and new-chat issues. They include browser chrome and do not identify CSS viewport/DPR, so no pixel-equality claim is made against them.

Confirmed findings resolved in the follow-up:

- P1: 48-item/real long block lists compress item boxes and overlap titles/subtitles. Preserve each row's intrinsic height and scroll the list.
- P1: composition fills the entire large window while single forms align left. Center a bounded working area in the space beside the app sidebar, keeping text left aligned.
- P1: regex editing requires whole-array JSON, exposing serialization rather than the author's task. Supply named fields and list operations while preserving native ownership, unknown values and unapplied raw drafts.
- P2: scene navigation repeats the first-message label and puts it into a number-width column. Simplify row hierarchy and use a suitable dialog width.
- P2: source/translation editing repeats the displayed text below the edit form and includes unnecessary always-visible implementation copy. Use one editable presentation with save/cancel; retain actionable conflict/error feedback.
- P2: the new-chat dialog is too narrow and shows an entire greeting inside a nested scrolling fieldset. Use a normal section, compact excerpt and explicit full-preview disclosure.

Implementation uses a 1248 px centered editor workspace (including padding), 880 px centered single-form sections, and compact non-shrinking list rows. Text stays left aligned within those workspaces. Regex forms share the native list/detail editor, with 120 px IN and 250 px OUT fields, explicit custom flags and a collapsed advanced JSON fallback. Bot/module ownership, existing aliases and unknown fields are preserved. Applied raw buffers follow parent-document changes, while local unapplied and restored remote drafts retain their text.

The new-chat dialog is 680 px on desktop and full width on mobile. Its creation button has a separate footer, the first message uses a three-line excerpt, and the full authored preview loads only when expanded. The scene list is 640 px on desktop and full width on mobile; the first message has one title. Source/translation editing hides the duplicate reading body without unmounting its native frame.

Visual iteration found and fixed additional concrete issues: inherited 440 px regex fields, checkbox-driven mobile overflow, a clipped creation button, and the mobile dialog's unused right strip. Reading regression exposed delayed native frame growth moving an explicit scene/end target. Navigation now retains its target through asynchronous layout and yields to user input or direct scrolling; epoch/query checks prevent stale navigation from moving a different view.

Follow-up dark screenshots and viewport/overflow JSON are in `output/ui-recovery-preview/review-captures/`: `preset-composition`, `preset-variables`, `preset-regex`, `scene-list`, `translation-edit`, and `new-chat`, each at 2560 × 1440 and 412 × 915, DPR 1. The actual 45-block Phémē preset supplies editor evidence; the synthetic library opening supplies popup/edit evidence. The supplied before screenshots and these after screenshots were reviewed for relative widths, centering, density, hierarchy, wrapping and clipping. The screenshots have different browser chrome/DPR contexts, so this is a layout comparison, not a pixel-difference claim.

Current follow-up verification:

- `npm run quality`: Biome checked 835 files and TypeScript passed.
- Focused Vitest: 35 tests passed across `native-risu-regex-editor`, `risu-export`, `reader`, and `edit-draft-session`. This covers flag/alias preservation, export, reader behavior and draft ownership. The earlier 2062-test full-suite result is not reused as proof of this follow-up.
- `npm run verify:ui-recovery -- --visual`: 41 tests passed. Receipt: `output/playwright/ui-recovery-2026-09-20T02-39-27-194Z-1a7cfb5b/summary.json`. Includes form editing and raw-draft recovery, long lists, CHARX/RISUP save/export/reimport, new-chat choices, source/translation edit focus and late frame navigation.
- Actual-app reader navigation: LOADUI06/07 passed (2 tests). Receipt: `output/playwright/loading-ui-2026-09-20T02-35-10-960Z-b5304ac4/summary.json`. The tests wait for actual native body/font/height readiness before manual scrolling; their scroll-position assertions are unchanged.
- Actual cards: Cheongwon, Hinano and Vela passed (3 tests, both requested widths) with the local Phémē preset. Receipt: `output/playwright/risu-native-samples-2026-09-20T02-39-27-855Z-017c8272/summary.json`. Source inputs remain read-only; the next-turn provider is a loopback fixture.
- All three successful receipts identify build/source `eb4d4fa37601e7b830a24f1360cf75d161c07b02c3aaf73440058442a3c8ead7` and pass final identity checks. Earlier runs invalidated by concurrent verification-file edits are not counted as successful receipts. Only documentation changed after these final runs.
- The 12 final dark screenshots were refreshed against that build. Their corresponding JSON records zero horizontal overflow; desktop workspaces are centered and bounded, mobile dialog footers remain reachable, and long titles no longer collide. The final desktop regex and mobile new-chat captures were inspected again after integration.

No actionable P0/P1/P2 remains within this follow-up scope. Cheongwon's authored icon overlap is accepted by the user and preserved. User aesthetic acceptance of the new density remains a separate checkpoint before expanding the remaining v3 screens. Live-provider output and physical-mobile behavior were not tested.

Previous density and native editing result: passed.

## Follow-up: input types and toggle definitions

The user accepted the editor density, removed the default first-message excerpt, requested distinct single-line/multiline fields and compact ON/OFF radio controls, and requested RisuToki-like structured toggle authoring in Uimori's own style. Their four new screenshots establish these requested changes. The user subsequently paused all six legacy-option removal/runtime changes pending their own review. Those controls and their execution behavior remain intact; the general input-width fix only corrects their layout.

Reviewed flow and findings:

1. **Basic options — passed:** native `text` uses an input and `textarea` uses a compact resizable textarea. Boolean-like toggle declarations use only OFF/ON radios with native keyboard behavior, scoped group names, and `"0"`/`"1"` storage. Existing unset values display OFF without being changed by viewing the screen. Native select declarations retain their authored choices. A shared 100%-width input selector previously affected checkboxes/radios; it now applies only to text-like controls.
2. **Toggle definitions — passed:** a Uimori list/detail editor supports eight native row types, add/remove/reorder and compatible type changes. Unknown rows, empty lines and unchanged line endings remain intact. Unapplied raw text survives tab changes and blocks saving until applied. This is a native string editor; no separate persisted AST is introduced.
3. **New chat — passed:** the opening selector and collapsed preview remain. The default three-line excerpt is removed. Expanding the preview still renders the authored greeting without generating a new turn.
4. **Legacy options — paused by user:** no removal or execution changes for `jailbreakToggle`, `chainOfThought`, `sendName`, `sendChatAsSystem`, `postEndInnerFormat` or `assistantPrefill` are included. Local RisuAI inspection found active runtime uses for the first five, so presumed obsolescence was not used to alter existing execution semantics.

Verification:

- `npm run quality`: 840 files checked and TypeScript passed.
- Focused Vitest: 9 toggle-editor preservation tests and 12 native-semantics tests passed. The original Windows sandbox `spawn EPERM` attempts were not counted as tests; the approved reruns passed.
- `npm run verify:ui-recovery -- --visual`: 43 tests passed. Receipt: `output/playwright/ui-recovery-2026-09-20T03-03-03-989Z-4ef0443d/summary.json`. The new desktop/mobile cases exercise input element types, radio keyboard selection, original string values, type changes, raw-draft retention and save persistence.
- Build/source identity: `57395ac2e6c9b5b0d002022960e6c8edc6f638440bc295f1e2633cda592ca803`; the successful browser receipt passes final identity checks. Documentation-only edits followed.
- Actual Phémē screen captures: `output/ui-recovery-preview/options-captures/{options,radios,toggle-editor,new-chat}-{2560,412}.png`, with matching viewport JSON. The two capture flows passed with zero page errors and zero horizontal overflow at 2560 × 1440 and 412 × 915, DPR 1. Desktop forms, mobile radio/input rows, mobile toggle details and preview-only new-chat layouts were visually inspected. The mobile toggle capture starts at the top of that screen rather than accepting an inherited scrolled position as its layout evidence.

No full unit-suite, live-provider or physical-mobile claim is made. The completed input/toggle/preview scope passes; the explicitly paused legacy-removal decision remains open. No original Risu material was edited.

Previous input/toggle/preview result: passed.

## Follow-up: switches for binary prompt options

The user replaced the radio-control preference with switches. Basic prompt options now reuse Uimori's existing labelled switch control. Native toggles still store `"0"` / `"1"`, unset values display off without a viewing-time write, and explicit select definitions keep their authored choices. The six legacy-option removals and execution changes remain paused.

- `npm run quality`: 840 files checked and TypeScript passed.
- `npm test -- tests/risu-native-semantics.test.ts`: 12 tests passed.
- `npm run verify:ui-recovery -- --grep "native toggle forms" --visual`: 2 focused cases passed at 2560 × 1440 and 412 × 915. They exercise click and Space-key toggling, switch sizing, saved native values, and the existing raw-draft flow.
- Receipt: `output/playwright/ui-recovery-2026-09-20T03-15-07-021Z-904b16e8/summary.json`; build/source identity `a11ad752b4b53cf8533f1747dac1de3a0f9348fb2791d06d602069480e4169de`. Final identity checks passed.
- Visually inspected `native-options-desktop.png` and `native-options-mobile.png` under that receipt's `browser/` directory. Labels and switches share a horizontal row, the switch retains its 44 px width, and the mobile form fits without horizontal overflow. The focused keyboard ring is visible in the captures.

This is focused local browser evidence; the earlier 43-case run was not repeated or treated as current full-suite evidence. No live-provider or physical-mobile validation was needed for this control substitution.

Previous switch follow-up result: passed.

## Follow-up: source-first toggle editing and missing captions

The user requested the raw toggle definition first, with the GUI editor collapsed below it, and reported missing `=caption` text in basic options. The GUI redesign remains deferred to their future references.

The missing captions were discarded by the control-only projection. The display now includes captions and dividers in authored order and groups, including standalone captions and groups containing only explanatory text. Stored option values and runtime variables still contain controls only. Captions render as text, not executable markup. Source-first editing retains the unapplied buffer, explicit apply action, save gating, and existing GUI operations.

Verification:

- `npm run quality` and the build passed. Focused Vitest passed 22 tests across native semantics and toggle-editor preservation, including a regression proving captions/dividers never become runtime variables.
- `npm run verify:ui-recovery -- --grep "native toggle forms|long block" --visual` passed 4 cases at 2560 × 1440 and 412 × 915. It checks caption visibility/order, source-first layout, initially collapsed GUI, long lists, pending-source retention, GUI edits and saved values.
- Final receipt: `output/playwright/ui-recovery-2026-09-20T03-24-42-871Z-8d615814/summary.json`; matching build/source `6ef722862acd36394326ddacf74211b1ef0de776a30782f26f6e99dd473cdee4`. The initial browser run failed because a caption locator also matched hidden GUI text; scoping it to the basic-options panel resolved the test ambiguity without weakening visibility or ordering assertions.
- Actual Phémē preset: two read-only capture flows passed at both sizes. Inspected `output/ui-recovery-preview/caption-captures/{raw-first,captions}-{2560,412}.png`: raw text appears before the closed GUI, captions follow their associated options, divider text is visible, and mobile text wraps within the available width. These captures preceded only the final React key namespace correction, which has no visual effect; the final browser receipt covers that correction.

The six legacy-option removals/runtime changes remain paused. No original material, live-provider behavior or physical device was changed or tested. This is focused verification, not a new full-suite result.

Previous source-first/caption result: passed.

## Follow-up: retire six legacy preset options

The user approved removing the UI and execution of `jailbreakToggle`, `chainOfThought`, `sendName`, `sendChatAsSystem`, `postEndInnerFormat`, and `assistantPrefill`, without notices on import. They explicitly declined historical-record compatibility work. No archive replay adapter or compatibility branch was added.

Imports, editable saves, exports, and new request snapshots discard these fields, `jailbreak`/`cot` blocks and the dependent `chatAsOriginalOnSystem` flag. The obsolete `type2: jailbreak` classification is removed without deleting an ordinary plain block's text. Neither compiler path executes the removed blocks or setting CBS, prefixes names, changes history roles, or creates a preset prefill. The old `jbtoggled` macro returns `0` without a diagnostic. Generic provider prefill serialization remains independent of these removed preset features.

Verification:

- `npm run quality` passed (840 files and TypeScript), and the current build passed.
- Nine focused unit suites passed 63 tests, with 2 opt-in private-material tests skipped in that run. Coverage includes silent import, direct API save, export, CBS side effects, history roles, and provider input preparation. An initial test-fixture import error was corrected before the successful run.
- The explicit actual-material test separately passed with Cheongwon, Hinano v2.4.3-test, Vela, and the Phémē preset; input file hashes stayed unchanged. The first attempt used an outdated Hinano path; the successful run used the file confirmed in the current local directory.
- `npm run verify:ui-recovery -- --grep "native toggle forms|RISUPRESETUI" --visual` passed 5 focused browser cases. Receipt: `output/playwright/ui-recovery-2026-09-20T03-46-14-011Z-e825b564/summary.json`. Build/source identity: `1616a4c8892bf00b8d53412e148a073ea75659ec640ed7f1ede5efa64de53807`; final identity checks passed.
- Inspected that run's `native-options-desktop.png` and `native-options-mobile.png` at 2560 × 1440 and 412 × 915. Authored input types, captions and switches remain visible, the removed controls are absent, and editing/saving and raw-first toggle authoring pass.
- Restarted the existing local preview against the new build while retaining its database. Both actual Phémē read-only capture flows passed; the refreshed mobile caption screen was inspected under `output/ui-recovery-preview/caption-captures/`.

This is focused local verification. No full-suite, live-provider, physical-device or historical fork/backup compatibility claim is made.

Previous legacy-option retirement result: passed.

## Follow-up: toggle editor v2

The user supplied `C:/Users/wodus/Downloads/uimori-toggle-editor-v2` as the new GUI reference. Its grouped inline editor replaces the temporary raw-first/collapsed-GUI arrangement. The source HTML, README, editor styles/scripts and supplied screenshots were inspected; prototype content and its JSON/localStorage storage mechanism are not production requirements.

### Implemented experience

- **Toggle configuration:** group-only desktop navigation, a mobile group selector, in-place item editing, whole-document search, group/item menus, captions travelling with their control, select indices and confirmation before index-changing actions.
- **Default variables:** a separate key/string document with editable rows. Values such as `001`, `false`, JSON text and embedded `=` remain strings.
- **Preview:** selected-group controls with captions beside their desktop input, isolated values and a reset action. It reuses the production native-control renderer without changing source, defaults or saved options.
- **Source:** explicit apply, two independent pending buffers, invalid-input save gating and draft retention across upper-level editor tabs. Switching views does not serialize either document. Unknown lines, blank lines and unchanged EOLs remain intact; malformed group boundaries block structural changes.
- **Undo/redo:** bounded local document history with a typing transaction, including both toggle declarations and variable defaults. Existing preset save, draft/conflict controls and RISUP export remain the production integration.

### Matched visual review

Source and implementation were rendered at **2560 × 1440** and **412 × 915**, DPR 1, dark theme. Paired editor/inline screenshots were inspected together, followed by paired preview and variable-table captures. Evidence lives under `output/ui-recovery-preview/toggle-v2-captures/`:

- `source-editor-{2560,412}.png` / `app-editor-{2560,412}.png`
- `source-inline-{2560,412}.png` / `app-inline-{2560,412}.png`
- `source-preview-{2560,412}.png` / `app-preview-{2560,412}.png`
- `source-variables-{2560,412}.png` / `app-variables-{2560,412}.png`
- `app-raw-{2560,412}.png`

The implementation retains Uimori's accepted 1248 px editor workspace, app shell, typography, Lucide icons and semantic theme tokens. The source sample contains 3 groups/18 settings, while the actual Phémē preset contains 4 groups/45 settings. These are intentional content differences. Default variables and raw forms keep the centered, narrower form width. At 412 px, long keys and preview captions use vertically stacked fields and 16 px inputs for legibility instead of compressing a two-column desktop row. No artwork or generated assets were necessary. Prototype-only sidebar entries, sample copy, floating export/status chrome and separate theme controls were not copied into the production editor.

Findings fixed during implementation:

- **P1:** applying one raw document could overwrite the other document's pending input. Independent source buffers now retain that input; the browser regression applies one document while the other remains pending, then applies the retained document.
- **P1:** shared form CSS made inline type/group selectors stack vertically and displaced their labels. Scoped layout and flex direction now keep desktop labels horizontal and mobile fields within the viewport.
- **P2:** source-index changes could reset the selected group after item operations. Structural actions retain group identity and select the explicit destination on a move.
- **P2:** the first preview used all groups in full-width disclosure forms. It now retains group navigation and displays the selected group in compact rows, matching the reference hierarchy.
- **P2:** the search icon inherited an incorrect vertical position. It is centered within its input.

### Final verification

- `npm run quality`: 842 files and TypeScript passed.
- `npm test -- tests/native-risu-toggle-editor.test.ts tests/native-toggle-document.test.ts tests/risu-native-semantics.test.ts`: **37 tests passed**. The 12 new document-helper cases include caption ownership, unknown lines, empty options, structural operations, preserved string values and original line endings.
- Current build passed: `output/build/build-2026-09-20T04-22-54-140Z-0f01e859/summary.json`.
- `npm run verify:ui-recovery -- --grep "native basic options|native toggle editor"`: **4 cases passed**, covering both viewport sizes, existing basic-option captions/switches and retired-control absence, group navigation, inline changes, preview isolation, original-source preservation, independent pending documents, invalid drafts, undo/redo, variable strings and persisted saves.
- Browser receipt: `output/playwright/ui-recovery-2026-09-20T04-23-20-032Z-aac72355/summary.json`; matching build/source hash `5832e7720c7877a6251bea93c6679656f509ddeee7792789b83cd24280ce1fce`. Final identity, artifact scan and cleanup passed. Only documentation changed after the final product build/test run.
- Two additional read-only actual-Phémē capture flows passed against the same build at both requested sizes, with zero page errors and zero page horizontal overflow. View changes left preset save disabled. The initial source-capture locator timed out; the corrected exact accessible name was used for the final successful 2-case run, and the failed capture was not counted as evidence.
- The existing in-app preview was refreshed and left on Phémē's new variable/toggle editor with the temporary viewport override reset.

No actionable P0/P1/P2 remains in this implementation scope. This is focused local browser and source-unit evidence, not a new full-suite, live-provider, physical-phone, or IME acceptance claim. Original external Risu files were not edited. Remaining aesthetic adjustments can be evaluated on the working screen.

final result: passed

## Follow-up: recovery design expanded to remaining screens

The requested recovery folder resolves locally to `C:/Users/wodus/Downloads/Uimori_UI_Recovery_v3`. Its 36 HTML/image references were used alongside the later approved centered editor density and toggle-editor-v2 design. The source's full-width/left-aligned forms and broken three-column mobile library were not reintroduced. Existing Risu-native data, retired-option removal, captions and switches remain authoritative.

### Implemented scope

- Library and prompt import entry points, compact import review/success, and the native bot's desktop side navigation/mobile horizontal advanced navigation.
- Chat settings grouped into conversation contents, prompt/model, memory/lore, images, automatic work and card variables. Shared profile drafts remain mounted across sections. Variable strings support rows/search/origin/reset and JSON, with invalid draft and conflict retention.
- Mobile previous/current/next scene navigation, using the existing source IDs and reading-position behavior.
- General/reading settings, grouped data management, actual Codex connection status and steps, and app/build/license information from repository notices.
- Collapsible collaboration agents, a searchable shared-option picker, and a compact helper-session toolbar. Mock-only helper lore proposals were not added.
- Validated save-and-leave and bot-scoped transcript/backup import. Transcript confirmation chooses the bot; backups retain their original owner. Uncertain import results retain the same request key.

### Matched visual review and intentional differences

References and implementation were rendered at **2560 × 1440** and **412 × 915**, DPR 1. Main paired screenshots are in `output/ui-recovery-preview/expansion-captures/`: `source-*`/`app-*` for 01, 11–17, 20–23, 30, 35–36; `source-*`/`actual-*` for 06, 07, 33; and `settings-source-*`/`settings-actual-*` for 25, 26, 28, 29. The existing opening, scene-list and source-edit flows were also exercised by the recovery suite. Capture flows perform no provider requests or external file edits. The stable preview uses its existing isolated database and literal `ui-recovery-review` server ID; the verification runners separately validate fresh source/build identity.

Source/implementation pairs were opened together. Full desktop views established composition, while 412 px captures and focused import/control views made typography, spacing, controls and text wrapping readable. Final captures wait for the Risu message frame rather than accepting its loading placeholder.

| Required fidelity surface | Review result |
| --- | --- |
| Fonts and typography | Existing Uimori typography and monospace code/keys retained. Labels, multiline names and long variable keys wrap within their columns. |
| Spacing and layout | Centered bounded desktop workspaces; full-width mobile forms, compact variable rows and clear disclosure hierarchy. Existing mobile settings list/detail navigation is retained. |
| Colors and tokens | Existing semantic surface, line, text and muted-green accent tokens used; no new palette. Light settings states are covered by SCUI04 in addition to dark preview comparisons. |
| Images and assets | Existing card images and Lucide icons reused; no generated artwork or replacement brand assets. Actual sample data differs from the prototype. |
| Copy and content | Current product capabilities and native ownership are retained. Real connection states, actual build IDs and license documents replace mock status. Advanced raw HTML/Lua remains editable without introducing prototype-only preview features. |

The source's sample bot/variables/agent rows are not identical to the installed materials. The option picker remains a real dialog, and image management is a disclosure around the existing form rather than a new route. These are intentional product constraints. The accepted editor workspace and narrower forms remain centered even where the original recovery mock was left-aligned.

### Findings fixed

- **P1:** changing a malformed variable JSON draft into valid JSON closed the editor. Raw-edit mode now remains explicit.
- **P1:** backup result loss could discard its request identity when the import dialog closed. Pending/uncertain imports now keep the dialog and selection until the same request resolves.
- **P1:** save-and-leave could leave other cached role drafts unsaved. It now refuses that navigation and identifies the remaining drafts before saving.
- **P1:** data import completion/failure removed the disclosure's controlled `open` attribute and hid its result. Native disclosure state now survives both outcomes.
- **P2:** mobile variable rows and the owner-bot block were excessively tall. Keys/origins, fields and reset icons now share compact rows; avatar/title/lore count share a line.
- **P2:** agent templates and image-upload fields displaced primary settings. Both now open on demand without unmounting drafts.
- **P2:** native advanced textareas used their intrinsic width and editor diagnostics sat outside the centered form. Scoped widths now fill the available form and align the footer.
- **P2:** full restore forms and empty Codex action rows consumed unnecessary space. Restore starts collapsed; empty actions do not occupy a row.
- **P2:** a shared `align-self: flex-end` rule offset the restore file-clear button. A scoped override reduced the measured center difference from 3.195 px to 0.0078 px, retaining the existing 1 px check.

Final screenshots after these fixes were compared again; no actionable P0/P1/P2 remains in the reviewed visual scope.

### Verification and limits

- `npm run quality`: 850 files and TypeScript passed. Six focused unit suites passed **60 tests**, covering variables, transcript/backup and collaboration contracts.
- `verify:ui-recovery -- --visual`: **67 passed** on build `9744584e3209a4e41201016510d81f8c2b756c08ea4bae0024bf9c6c2f7bd4db`; receipt `output/playwright/ui-recovery-2026-09-20T05-05-20-006Z-1b3e491d/summary.json`. This includes native authoring/downloads, captions/switches, import ownership/retry, shared drafts, JSON recovery, scene navigation and save-and-leave. Mobile editor leave uses the actual list-back path; the desktop-only global sidebar path is not claimed as mobile coverage.
- The last product change after that run is only the archive file-clear selector. Final build: `output/build/build-2026-09-20T05-10-01-254Z-03c81ca0/summary.json`, build ID `5e48c9b8ede86c8dd07a23cb82624fdad10318d3d393269d5e496799123aefd8`.
- Expanded regression first exposed both genuine issues above and outdated navigation/native fixtures. The corrected broad selection passed 47 cases, with 4 unresolved cases retained in its FAIL receipt. A subsequent focused run passed ACOM01, two SICON01 cases, SCUI04 and RACOM01 (5 cases), including the final archive alignment. It still reported P01's old numeric/string DOM expectation; its final follow-up result is recorded below. Failed receipts are not presented as successful runs.
- A separately discovered **pre-existing failure**, TURNUI05, still expects the removed `hasPackageIssues` legacy projection. Baseline `f110109` already lacks that contract. The test/source was not changed and legacy execution was not restored; the focused final selection excludes it explicitly. This does not establish a clean full regression suite or native issue-badge coverage.
- The main final source/implementation capture flow passed at both requested sizes with zero page errors/overflow; settings passed two capture flows; collaboration/helper paired review passed. Synthetic fixtures created for ad hoc preview checks were moved through the normal reversible trash API, preserving the four sample materials and every chat.

This is local browser, source-unit and visual evidence. It does not establish live-provider, physical-phone/IME or production acceptance. No external Risu source file, push or deployment was performed.

Final functional follow-up: **P01 passed 1/1** with the correct JSON-encoded select expectation. Receipt `output/playwright/redesign-2026-09-20T05-12-24-388Z-ba2af20a/summary.json` matches final build/source `5e48c9b8ede86c8dd07a23cb82624fdad10318d3d393269d5e496799123aefd8`; cleanup passed. Combined relevant results cover all 51 cases in the corrected focused regression selection, while the separate pre-existing TURNUI05 failure remains disclosed above. The follow-up changed tests only.

final result: passed
