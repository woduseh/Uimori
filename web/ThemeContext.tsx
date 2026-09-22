import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  BUILTIN_THEMES,
  defaultThemePreferences,
  resolveTheme,
  THEME_COLOR_KEYS,
  type Theme,
  type ThemeDefinition,
  type ThemeCatalog,
  type ThemeScope,
} from '../core/themes.js';
import { api } from './api.js';
import { updateMessageTheme } from './theme-message-style.js';

export const themesChangedKey = 'uimori:themes-changed';
const initial: ThemeCatalog = { themes: BUILTIN_THEMES, preferences: defaultThemePreferences() };
type ThemeState = {
  catalog: ThemeCatalog;
  active: Theme;
  scope: ThemeScope;
  loading: boolean;
  error: string;
  setScope: (scope: ThemeScope) => void;
  refresh: (notify?: boolean) => Promise<void>;
  preview: ThemeDefinition | null;
  setPreview: (theme: ThemeDefinition | null) => void;
  disabled: boolean;
  setDisabled: (value: boolean) => void;
};
export const ThemeContext = createContext<ThemeState | null>(null);
export function useThemes(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) throw new Error('ThemeProvider is missing');
  return state;
}
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState(initial);
  const [scope, setScope] = useState<ThemeScope>({});
  const [preview, setPreview] = useState<ThemeDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [disabled, setDisabledState] = useState(() => {
    if (new URLSearchParams(location.search).get('theme-safe') === '1') {
      try {
        sessionStorage.setItem('uimori:theme-disabled', '1');
      } catch {
        /* The URL still recovers this page. */
      }
      return true;
    }
    try {
      return sessionStorage.getItem('uimori:theme-disabled') === '1';
    } catch {
      return false;
    }
  });
  const alive = useRef(true);
  const epoch = useRef(0);
  const refresh = useCallback(async (notify = false) => {
    const current = ++epoch.current;
    try {
      const next = await api<ThemeCatalog>('/themes');
      if (alive.current && current === epoch.current) {
        setCatalog((previous) => {
          const known = new Map(previous.themes.map((theme) => [theme.id, theme]));
          const themes = next.themes.map((theme) => {
            const old = known.get(theme.id);
            return old?.revision === theme.revision ? old : theme;
          });
          const preferences =
            previous.preferences.revision === next.preferences.revision
              ? previous.preferences
              : next.preferences;
          return preferences === previous.preferences &&
            themes.length === previous.themes.length &&
            themes.every((theme, i) => theme === previous.themes[i])
            ? previous
            : { themes, preferences };
        });
        setError('');
      }
      if (notify) {
        try {
          localStorage.setItem(themesChangedKey, `${Date.now()}:${Math.random()}`);
        } catch {
          /* The server save already succeeded. */
        }
      }
    } catch (cause) {
      if (alive.current && current === epoch.current) setError((cause as Error).message);
    } finally {
      if (alive.current && current === epoch.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const focus = () => {
      void refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === themesChangedKey) focus();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('storage', storage);
    window.addEventListener('uimori-themes-changed', focus);
    return () => {
      alive.current = false;
      epoch.current++;
      window.removeEventListener('focus', focus);
      window.removeEventListener('storage', storage);
      window.removeEventListener('uimori-themes-changed', focus);
    };
  }, [refresh]);
  const setDisabled = useCallback((value: boolean) => {
    setDisabledState(value);
    setPreview(null);
    try {
      sessionStorage.setItem('uimori:theme-disabled', value ? '1' : '0');
    } catch {
      /* Recovery still works for this page. */
    }
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'Period' && !event.isComposing) {
        event.preventDefault();
        setDisabled(!disabled);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [disabled, setDisabled]);
  const active = useMemo(
    () =>
      disabled
        ? BUILTIN_THEMES[0]
        : preview
          ? { ...preview, id: 'preview', revision: 0 }
          : resolveTheme(catalog, scope),
    [disabled, preview, catalog, scope]
  );
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.uimoriTheme = active.id;
    const applyColors = () => {
      const colors = active.colors[root.dataset.theme === 'dark' ? 'dark' : 'light'];
      for (const key of THEME_COLOR_KEYS) {
        if (colors[key]) root.style.setProperty(`--${key}`, colors[key]!);
        else root.style.removeProperty(`--${key}`);
      }
    };
    applyColors();
    const observer = new MutationObserver(applyColors);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    const style = document.createElement('style');
    style.id = 'uimori-theme-css';
    style.textContent = active.appCss;
    document.head.append(style);
    updateMessageTheme(document, active.messageCss);
    return () => {
      observer.disconnect();
      style.remove();
      updateMessageTheme(document, '');
      for (const key of THEME_COLOR_KEYS) root.style.removeProperty(`--${key}`);
      delete root.dataset.uimoriTheme;
    };
  }, [active]);
  const value = {
    catalog,
    active,
    scope,
    setScope,
    loading,
    error,
    refresh,
    preview,
    setPreview,
    disabled,
    setDisabled,
  };
  return <ThemeContext value={value}>{children}</ThemeContext>;
}
