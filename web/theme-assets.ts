import { appearanceEndpoints, type StoredThemeAsset } from '#contracts';
import { callEndpoint, throwApiError } from './api.js';
import {
  themeAssetVariable,
  themeFile,
  type ThemeAsset,
  type ThemeAssetFile,
  type ThemeAssetKind,
  type ThemeDefinition,
} from '../core/themes.js';

export function themeAssetUrl(hash: string): string {
  return `/api/theme-assets/${hash}`;
}

export function uploadThemeAsset(kind: ThemeAssetKind, data: string): Promise<StoredThemeAsset> {
  return callEndpoint(appearanceEndpoints.uploadThemeAsset, { kind, data });
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const data = String(reader.result);
      resolve(data.slice(data.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export async function adoptThemeFile(theme: ThemeDefinition, files: ThemeAssetFile[]) {
  const stored = new Map<string, string>();
  for (const file of files) {
    if (stored.has(file.hash)) continue;
    stored.set(file.hash, (await uploadThemeAsset(file.kind, file.data)).hash);
  }
  const assets = theme.assets?.map((asset) => ({ ...asset, hash: stored.get(asset.hash)! }));
  return assets ? { ...theme, assets } : theme;
}

export async function exportThemeFile(theme: ThemeDefinition) {
  const files: ThemeAssetFile[] = [];
  for (const asset of theme.assets ?? []) {
    if (files.some((file) => file.hash === asset.hash)) continue;
    const response = await fetch(themeAssetUrl(asset.hash));
    if (!response.ok) await throwApiError(response);
    const blob = await response.blob();
    files.push({
      hash: asset.hash,
      kind: asset.kind,
      mime: blob.type,
      data: await blobBase64(blob),
    });
  }
  return themeFile(theme, files);
}

const faces = new Map<string, FontFace>();
export function themeFontFamily(hash: string): string {
  return `uimori-theme-${hash.slice(0, 24)}`;
}

function registerFont(hash: string) {
  if (faces.has(hash)) return;
  const face = new FontFace(themeFontFamily(hash), `url("${themeAssetUrl(hash)}")`, {
    display: 'swap',
  });
  document.fonts.add(face);
  faces.set(hash, face);
}

export function themeAssetDeclarations(assets: ThemeAsset[] = []): [string, string][] {
  return assets.map((asset) => [
    themeAssetVariable(asset),
    asset.kind === 'font'
      ? `"${themeFontFamily(asset.hash)}"`
      : `url("${themeAssetUrl(asset.hash)}")`,
  ]);
}

export function applyThemeAssets(root: HTMLElement, assets: ThemeAsset[] = []): () => void {
  for (const asset of assets) if (asset.kind === 'font') registerFont(asset.hash);
  const declarations = themeAssetDeclarations(assets);
  for (const [name, value] of declarations) root.style.setProperty(name, value);
  return () => {
    for (const [name] of declarations) root.style.removeProperty(name);
  };
}
