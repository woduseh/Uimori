# UI gallery

`npm run verify:gallery` captures the built app with synthetic data on an isolated test server. It covers the configured screens in light and dark themes, then follows the first-chat journey in light mode. Viewport widths come from [`fixtures/browser-viewports.json`](../fixtures/browser-viewports.json).

Use it for a broad visual review when useful. Gallery success means capture, journey execution, and cleanup succeeded; it does not mean every layout metric passed or that the product works on a physical device.

## Output and configuration

Results are under `output/playwright/gallery-<timestamp>-<id>/`: screenshots, the `index.html` contact sheet, `metrics.json`, `journey.json`, `captures.json`, and `summary.json`. The summary records execution status, build identity, and metric results. `npm run cleanup` handles owned artifacts.

- [Screens](../scripts/gallery/screens.mjs) define routes, readiness, actions, themes, viewports, and measurements.
- [Journeys](../scripts/gallery/journey.mjs) define interaction sequences and count clicks, fills, menu opens, and key presses.
- [Steps](../scripts/gallery/steps.mjs) define locator and action syntax; [seed data](../scripts/gallery/seed.mjs) supplies route placeholders.
- [Panel deep links](../web/usePanelDeepLink.ts) open otherwise inaccessible screens on test-mode servers.

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
