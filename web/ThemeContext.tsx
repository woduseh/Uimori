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
import { BUILTIN_PALETTES } from '../core/theme-palettes.js';
import { appearanceEndpoints, type AppearanceTarget } from '#contracts';
import { callEndpoint } from './api.js';
import { updateMessageTheme } from './theme-message-style.js';
import { applyThemeAssets } from './theme-assets.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';
import { useShortcut } from './shortcuts.js';
import { storageKeys } from './storage-keys.js';
import { presentationFrame } from './live-frames.js';
import { watchLive } from './live-stream.js';

const initial: ThemeCatalog = {
  themes: BUILTIN_THEMES,
  palettes: BUILTIN_PALETTES,
  preferences: defaultThemePreferences(),
};
type ThemeState = {
  catalog: ThemeCatalog;
  active: Theme;
  scope: ThemeScope;
  loading: boolean;
  error: string;
  setScope: (scope: ThemeScope) => void;
  refresh: () => Promise<void>;
  preview: ThemeDefinition | null;
  setPreview: (theme: ThemeDefinition | null) => void;
  disabled: boolean;
  setDisabled: (value: boolean) => void;
};
export const ThemeContext = createContext<ThemeState | null>(null);
export function appearanceTarget(
  scope: AppearanceTarget['scope'],
  { botId, chatId }: ThemeScope
): AppearanceTarget {
  const targetId = scope === 'bot' ? botId : scope === 'chat' ? chatId : undefined;
  return scope !== 'global' && targetId ? { scope, targetId } : { scope: 'global' };
}
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
      writeOptionalStorage('session', storageKeys.themeDisabled, '1');
      return true;
    }
    return readOptionalStorage('session', storageKeys.themeDisabled) === '1';
  });
  const alive = useRef(true);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const next = await callEndpoint(appearanceEndpoints.readThemes);
      if (alive.current && current === epoch.current) {
        setCatalog((previous) => {
          const known = new Map(previous.themes.map((theme) => [theme.id, theme]));
          const themes = next.themes.map((theme) => {
            const old = known.get(theme.id);
            return old?.revision === theme.revision ? old : theme;
          });
          const palettes = next.palettes;
          const palettesUnchanged = JSON.stringify(previous.palettes) === JSON.stringify(palettes);
          const preferences =
            previous.preferences.revision === next.preferences.revision
              ? previous.preferences
              : next.preferences;
          return palettesUnchanged &&
            preferences === previous.preferences &&
            themes.length === previous.themes.length &&
            themes.every((theme, i) => theme === previous.themes[i])
            ? previous
            : { themes, preferences, palettes: palettesUnchanged ? previous.palettes : palettes };
        });
        setError('');
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
    const live = watchLive({ match: presentationFrame('themes'), refresh });
    return () => {
      alive.current = false;
      epoch.current++;
      live.dispose();
    };
  }, [refresh]);
  const setDisabled = useCallback((value: boolean) => {
    setDisabledState(value);
    setPreview(null);
    writeOptionalStorage('session', storageKeys.themeDisabled, value ? '1' : '0');
  }, []);
  useShortcut('theme.safeMode', () => setDisabled(!disabled));
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
    const syncBrowserThemeColor = () => {
      const background = getComputedStyle(document.body).backgroundColor;
      if (background !== 'rgba(0, 0, 0, 0)')
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
    };
    applyColors();
    const observer = new MutationObserver(() => {
      applyColors();
      syncBrowserThemeColor();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    const style = document.createElement('style');
    style.id = 'uimori-theme-css';
    style.textContent = active.appCss;
    document.head.append(style);
    syncBrowserThemeColor();
    updateMessageTheme(document, active.messageCss);
    const removeAssets = applyThemeAssets(root, active.assets);
    return () => {
      removeAssets();
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
