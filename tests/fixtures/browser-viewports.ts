import widths from '../../fixtures/browser-viewports.json' with { type: 'json' };

export const MOBILE_WIDTH = widths.mobile;
export const DESKTOP_WIDTH = widths.desktop;
export const DEFAULT_WIDTHS = [MOBILE_WIDTH, DESKTOP_WIDTH] as const;

export const MOBILE_HEIGHT = widths.mobileHeight;
export const DESKTOP_HEIGHT = widths.desktopHeight;
