# UI gallery

`npm run verify:gallery` captures the built app with synthetic data on an isolated test server. It covers the configured screens in light and dark themes, then follows the first-chat journey in light mode. Viewport widths come from [`fixtures/browser-viewports.json`](../fixtures/browser-viewports.json).

Use it for a broad visual review when useful. Gallery success means capture, journey execution, and cleanup succeeded; it does not mean every layout metric passed or that the product works on a physical device.

The screen list includes all global settings categories, the chat settings categories present in the fixture, and the composer lore, manual-compaction, empty-request preview, and manuscript-export dialogs. The dialogs are opened without invoking compression, generation, or downloads. Conditional card variables, populated editors, provider failures, and other recovery states still need their feature-specific browser checks; the gallery is not an inventory of every possible UI state.

## Output and configuration

Results are under `output/playwright/gallery-<timestamp>-<id>/`: screenshots, the `index.html` contact sheet, `metrics.json`, `journey.json`, `captures.json`, and `summary.json`. The summary records execution status, build identity, and metric results. `npm run cleanup` handles owned artifacts.

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

Run `npm run verify:copy` from the repository root, or `npm run verify:copy -- --json` for structured output. [The scanner](../scripts/check-ui-copy.mjs) reads `.tsx` and `.jsx` files under `web/` using the existing JSX parser. It does not modify the files, render the app, call a model, or judge the quality of prose.

It reports a small set of source candidates:

- Fully static explanatory `p`/`small` text of 100 or more characters.
- Exact explanations of 20 or more characters repeated under the same local JSX parent and conditional branch.
- Static explanations of 15 or more characters inside a `map` callback, where the same help may repeat on every row.
- A field's placeholder repeated in a nearby explanation, using either the same static text (20 or more characters) or the same expression syntax. Expressions are compared, never evaluated.

These thresholds help find text to review; they are not design rules or instructions to delete the text. Source candidates can belong to mutually exclusive states, an unmounted component, or a useful explanation. Verify the actual screen before changing them. Meaning-level repetition, unclear labels, action ordering, layout overlap, and accessibility still require human review and relevant browser checks.

The scanner excludes collapsed `details`, lazy diagnostics, recognized prose/raw-content containers, hidden or accessibility-only content, alerts/status notices, and text inside controls. It does not resolve component props, variables, CSS, or application state. Dynamic paragraphs are excluded from length and exact-text rules. Required warnings and user-authored manuscripts must not be shortened merely to clear a report.

Warnings exit successfully and are not part of `quality` or a CI gate. Read/parse failures and an empty source set are reported as an incomplete scan with a nonzero exit code, so an unsuccessful inspection cannot look like a clean result. The scanner's own behavior is covered by `node --test scripts/check-ui-copy.test.mjs`, also discovered by the existing tooling test runner.
