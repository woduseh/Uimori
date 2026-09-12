import widths from '../../fixtures/browser-viewports.json' with { type: 'json' };

/** CSS viewport widths selected for the user's phone and desktop; each test keeps its own height. */
export const MOBILE_WIDTH = widths.mobile;
export const DESKTOP_WIDTH = widths.desktop;
export const DEFAULT_WIDTHS = [MOBILE_WIDTH, DESKTOP_WIDTH] as const;
