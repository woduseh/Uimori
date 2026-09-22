// Fallback swatches mirror the app's baseline palette; theme styles are still inherited at runtime.
export const baselineThemeColors: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    bg: '#fafbf8',
    nav: '#f0f2ec',
    panel: '#fff',
    surface: '#e9ede5',
    'surface-raised': '#f3f5ef',
    hover: '#e0e7da',
    line: '#cbd3c4',
    'input-border': '#76836e',
    text: '#232c22',
    muted: '#586451',
    faint: '#66735f',
    accent: '#355b39',
    'accent-ink': '#fff',
    'accent-soft': '#e0e9db',
    user: '#edf1e8',
    error: '#9d3022',
    'error-ink': '#fff',
    'error-bg': '#fcf0ed',
    shade: '#14201459',
  },
  dark: {
    bg: '#1a1d1b',
    nav: '#141715',
    panel: '#222623',
    surface: '#292e2a',
    'surface-raised': '#222623',
    hover: '#303831',
    line: '#394039',
    'input-border': '#74816f',
    text: '#eef1eb',
    muted: '#adb6aa',
    faint: '#9ba694',
    accent: '#bdd4b7',
    'accent-ink': '#20341e',
    'accent-soft': '#303b30',
    user: '#2a312b',
    error: '#f3b3a9',
    'error-ink': '#3d1a14',
    'error-bg': '#372726',
    shade: '#0008',
  },
};
export function colorInputValue(value: string): string {
  if (value.length === 4 || value.length === 5)
    return '#' + [...value.slice(1, 4)].map((c) => c + c).join('');
  return value.slice(0, 7);
}
