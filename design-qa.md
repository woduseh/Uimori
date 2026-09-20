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

final result: passed
