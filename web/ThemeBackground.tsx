import type { CSSProperties } from 'react';
import {
  resolveThemeBackground,
  type ThemeBackground as Background,
} from '../core/theme-background.js';
import { useThemes } from './ThemeContext.js';
import './theme-background.css';

export function backgroundStyle(value: Background): CSSProperties {
  return {
    '--theme-background-image': value.imageHash
      ? `url("/api/package-image-blobs/${value.imageHash}")`
      : 'none',
    '--theme-background-blur': `${value.blur}px`,
    '--theme-background-light': String(value.lightOverlay / 100),
    '--theme-background-dark': String(value.darkOverlay / 100),
  } as CSSProperties;
}
/** Decorative sibling of the reader, never a parent/filter of manuscript content. */
export function ThemeBackground() {
  const { catalog, scope, disabled } = useThemes();
  const value = resolveThemeBackground(catalog.preferences, scope);
  if (disabled || !value.imageHash) return null;
  return <div className="theme-background" aria-hidden="true" style={backgroundStyle(value)} />;
}
