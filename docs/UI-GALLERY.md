# UI gallery

`npm run verify:gallery` captures the built app with synthetic data on an isolated test server. It covers the configured screens in light and dark themes, then follows the first-chat journey in light mode. Viewport widths come from [`fixtures/browser-viewports.json`](../fixtures/browser-viewports.json).

Build the current app with `npm run build` before capturing. The gallery accepts no CLI arguments; change the screen/journey definitions below to adjust its selection. Use a feature's shared browser runner when you need `--grep` or `--visual`.

Use it for a broad visual review when useful. Gallery success means capture, journey execution, and cleanup succeeded; it does not mean every layout metric passed or that the product works on a physical device.

The screen list includes all global settings categories, the chat settings categories present in the fixture, and the composer lore, manual-compaction, empty-request preview, and manuscript-export dialogs. The dialogs are opened without invoking compression, generation, or downloads. Conditional card variables, populated editors, provider failures, and other recovery states still need their feature-specific browser checks; the gallery is not an inventory of every possible UI state.

## Output and configuration

Results are under `output/playwright/gallery-<timestamp>-<id>/`: screenshots, the `index.html` contact sheet, `metrics.json`, `journey.json`, `captures.json`, and `summary.json`. The summary records execution status, build identity, and metric results. After stopping its server, the runner also preserves the seeded SQLite under `evidence-db`, including on success. It does not run automatic retention itself. `npm run cleanup` lists owned runs; `npm run cleanup -- --run <run-id>` removes a selected inactive run and its evidence.

- [Screens](../scripts/gallery/screens.mjs) define routes, visible navigation steps, readiness, actions, themes, viewports, and measurements.
- [Journeys](../scripts/gallery/journey.mjs) define interaction sequences and count clicks, fills, menu opens, and key presses.
- [Steps](../scripts/gallery/steps.mjs) define locator and action syntax; [seed data](../scripts/gallery/seed.mjs) supplies route placeholders.

## Metrics

[`tests/fixtures/ui-metrics.ts`](../tests/fixtures/ui-metrics.ts) owns the calculations and targets shared by browser tests and the gallery. These are diagnostic measurements of selected elements, not universal UI design requirements. Update that implementation when intentionally changing a measurement; keep this reference consistent.

| Metric | Interpretation |
| --- | --- |
| `header-controls` | Visible header control count; measured without a fixed target |
| `composer-dock` | Empty dock height; measured without a fixed target |
| `body-share` | First source text's share of viewport height; measured without a fixed target |
| `menu-in-viewport` | Open action menus and their items remain in the viewport |
| `overflow` | Horizontal overflow at most 1px |
| `touch-44` | No visible controls below 44px in either dimension at compact widths, excluding source text |
| `min-font` | No visible text below 12px |
| `font-size-values` | Declared font-size count; measured without a fixed target |
| `border-radius-values` | Scalar radius count, excluding square, circle, and pill shapes; measured without a fixed target |

Compact means at most 760px. A `null` pass value means a measurement is recorded without scoring it. Control counts, layout proportions and token variety inform visual review without prescribing a design. Inspect selectors and the screenshot before interpreting a missing or unexpected value. Gallery metrics do not fail the capture run; browser tests choose which measurements to assert.

Measurements use DOM visibility, which does not establish that an element is inside the viewport or unobscured by a dialog. Background controls can therefore recur in several captures. Small switches may also have larger clickable labels. Do not count these raw results as independent confirmed usability defects.

## Copy review warnings

Run `npm run verify:copy` from the repository root for high-confidence source warnings, or `node scripts/check-ui-copy.mjs --json` for warnings **and** the full review inventory. The scanner reads `.tsx`/`.jsx` under `web/` and statically parses Korean (`ko`) messages in `web/locales/*.ts`; it never executes locale modules, modifies UI files, renders the app or makes model calls. It resolves literal `t('key')` calls and retains their keys and source locations in the JSON output. The existing `npm run check:i18n` separately verifies all four translations, missing keys and ICU syntax.

**Warnings** use conservative heuristics on text known at source level:

- Complete static `p`/`small` explanations 100 or more Unicode characters long, including translated messages with no runtime ICU interpolation.
- Exact explanations of 20 or more characters repeated under the same local JSX parent and conditional branch.
- Static explanations of 15 or more characters repeated for **unconditional** mapped list items (conditional state messages are not flagged as repetition).
- Nearby placeholders repeated in a static explanation (20 or more characters), or the same unresolved expression signature. Expressions are never evaluated.

The JSON **`review` inventory** also lists resolved explanatory copy that is too short to trigger a warning, and both alternatives of conditional `t('key')` branches. Each entry has the JSX source line, Korean text, optional locale keys and a `static` flag; conditional alternatives also have `conditional: true`. Entries are source locations/alternatives, **not** confirmed simultaneously visible elements or deletion instructions. Use the inventory to check short redundant labels that the warnings intentionally do not classify. Capturing all translated text or semantic repetition is not an objective of the automatic warnings.

The scanner excludes collapsed `details`, lazy diagnostics, recognized prose/raw-content containers, **definitely** hidden or accessibility-only content, alerts/status notices, and text inside buttons and similar controls. It inspects `small` helper text inside a form `label` while leaving other label/control text alone. Conditional `hidden={...}` panels are inspected because they can be visible; the result does not imply they are currently open. It does not expand custom components, resolve variable props, run computed translation keys, evaluate runtime conditions, examine CSS or reliably distinguish authored examples from help text. ICU patterns with values are retained for human review rather than exact-matched as fully static strings.

A warning is only a candidate: do not delete useful data-loss, scope, accessibility, model-cost, security, failure or status information merely to eliminate a warning. Confirm candidates in the rendered relevant screen, including compact widths and nonempty states, before editing UI copy. Warnings exit successfully and do not block `quality` or CI; locale/source parse failures and an empty JSX set mark the scan incomplete with a nonzero exit. Unit tests are in `scripts/check-ui-copy.test.mjs` and are included in `npm run test:tooling`.
