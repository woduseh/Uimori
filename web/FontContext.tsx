import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { appearanceEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { useThemes } from './ThemeContext.js';

import { fontFamily, type FontCatalog } from '../core/fonts.js';
export {
  fontFamily,
  type FontAsset,
  type FontPreferences,
  type FontCatalog,
} from '../core/fonts.js';
import { presentationFrame } from './live-frames.js';
import { watchLive } from './live-stream.js';
type FontState = {
  catalog: FontCatalog | null;
  loading: boolean;
  error: string;
  runtimeError: boolean;
  appFamily: string | null;
  readerFamily: string | null;
  refresh: () => Promise<void>;
  accept: (catalog: FontCatalog) => void;
};
const FontContext = createContext<FontState | null>(null);
export function useFonts() {
  const state = useContext(FontContext);
  if (!state) throw new Error('FontProvider is missing');
  return state;
}
export function FontProvider({ children }: { children: ReactNode }) {
  const { disabled } = useThemes();
  const [catalog, setCatalog] = useState<FontCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<string[]>([]);
  const [runtimeError, setRuntimeError] = useState(false);
  const epoch = useRef(0);
  const faces = useRef(new Map<string, FontFace>());
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const next = await callEndpoint(appearanceEndpoints.listFonts);
      if (current === epoch.current) {
        setCatalog((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
        setError('');
      }
    } catch (cause) {
      if (current === epoch.current) setError((cause as Error).message);
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  }, []);
  const accept = useCallback((next: FontCatalog) => {
    ++epoch.current;
    setCatalog(next);
    setError('');
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
    const live = watchLive({ match: presentationFrame('fonts'), refresh });
    return () => {
      ++epoch.current;
      live.dispose();
    };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const prune = requestAnimationFrame(() => {
      if (!catalog) return;
      const retained = new Set(catalog.fonts.map((font) => font.id));
      for (const [id, face] of faces.current) {
        if (retained.has(id)) continue;
        document.fonts.delete(face);
        faces.current.delete(id);
      }
    });
    setRuntimeError(false);
    if (!disabled && catalog) {
      for (const font of catalog.fonts) {
        const previous = faces.current.get(font.id);
        if (previous && previous.status !== 'error') continue;
        if (previous) document.fonts.delete(previous);
        const face = new FontFace(
          fontFamily(font.id),
          `url("/api/fonts/${encodeURIComponent(font.id)}/file")`
        );
        document.fonts.add(face);
        faces.current.set(font.id, face);
      }
      const selected = [
        ...new Set([catalog.preferences.appFontId, catalog.preferences.readerFontId]),
      ].filter((id): id is string => !!id);
      void Promise.all(
        selected.map(async (id) => {
          const face = faces.current.get(id);
          if (!face) return null;
          try {
            await face.load();
            if (active) return id;
          } catch {
            if (active) setRuntimeError(true);
          }
          return null;
        })
      ).then((ids) => {
        if (active) setLoaded(ids.filter((id): id is string => id !== null));
      });
    }
    return () => {
      active = false;
      cancelAnimationFrame(prune);
    };
  }, [catalog, disabled]);
  useEffect(
    () => () => {
      for (const face of faces.current.values()) document.fonts.delete(face);
    },
    []
  );
  const family = (id: string | null | undefined) =>
    !disabled && id && loaded.includes(id) ? `"${fontFamily(id)}"` : null;
  return (
    <FontContext
      value={{
        catalog,
        loading,
        error,
        runtimeError,
        refresh,
        accept,
        appFamily: family(catalog?.preferences.appFontId),
        readerFamily: family(catalog?.preferences.readerFontId),
      }}
    >
      {children}
    </FontContext>
  );
}
