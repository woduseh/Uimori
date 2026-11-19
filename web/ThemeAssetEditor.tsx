import { Copy, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  MAX_THEME_ASSETS,
  themeAssetVariable,
  type ThemeAsset,
  type ThemeAssetKind,
} from '../core/themes.js';
import { IconButton } from './IconButton.js';
import { t, useI18n, message as uiMessage } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { readImportSource } from './import-source.js';
import { themeAssetUrl, themeFontFamily, uploadThemeAsset } from './theme-assets.js';
import './theme-asset-editor.css';

export function ThemeAssetEditor({
  assets,
  onChange,
  onError,
}: {
  assets: ThemeAsset[];
  onChange: (assets: ThemeAsset[]) => void;
  onError: (message: string) => void;
}) {
  useI18n();
  const [kind, setKind] = useState<ThemeAssetKind>('image');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [notice, setNotice] = useState('');
  async function copy(variable: string) {
    setNotice('');
    try {
      await navigator.clipboard.writeText(variable);
      onError('');
      setNotice(uiMessage('themeAssets.copied'));
    } catch {
      onError(uiMessage('helpers.m130'));
    }
  }
  const validName = /^[a-z][a-z0-9-]{0,31}$/u.test(name);
  async function add() {
    if (!file || !validName) return;
    if (assets.some((asset) => asset.kind === kind && asset.name === name)) {
      onError(t('themeAssets.duplicateName'));
      return;
    }
    if (assets.length >= MAX_THEME_ASSETS) {
      onError(t('themeAssets.limit', { count: MAX_THEME_ASSETS }));
      return;
    }
    setBusy(true);
    try {
      const { base64 } = await readImportSource(file);
      const stored = await uploadThemeAsset(kind, base64);
      onChange([...assets, { name, kind, hash: stored.hash }]);
      setName('');
      setFile(null);
      setInputKey((key) => key + 1);
      onError('');
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="theme-asset-editor" aria-label={t('themeAssets.title')}>
      <h4>{t('themeAssets.title')}</h4>
      <p className="muted">{t('themeAssets.help')}</p>
      {assets.length > 0 && (
        <ul>
          {assets.map((asset) => {
            const variable = `var(${themeAssetVariable(asset)})`;
            return (
              <li key={`${asset.kind}:${asset.name}`}>
                {asset.kind === 'image' ? (
                  <img src={themeAssetUrl(asset.hash)} alt="" />
                ) : (
                  <span
                    className="theme-asset-font-sample"
                    style={{ fontFamily: `"${themeFontFamily(asset.hash)}"` }}
                  >
                    {t('themeAssets.fontSample')}
                  </span>
                )}
                <code>{variable}</code>
                <IconButton
                  icon={Copy}
                  label={t('themeAssets.copy', { variable })}
                  onClick={() => void copy(variable)}
                />
                <IconButton
                  icon={Trash2}
                  label={t('themeAssets.remove', { name: asset.name })}
                  onClick={() => onChange(assets.filter((item) => item !== asset))}
                />
              </li>
            );
          })}
        </ul>
      )}
      <div className="theme-asset-add">
        <label>
          {t('themeAssets.kind')}
          <select
            aria-label={t('themeAssets.kind')}
            value={kind}
            onChange={(event) => setKind(event.target.value as ThemeAssetKind)}
          >
            <option value="image">{t('themeAssets.image')}</option>
            <option value="font">{t('themeAssets.font')}</option>
          </select>
        </label>
        <label>
          {t('themeAssets.name')}
          <input
            aria-label={t('themeAssets.name')}
            aria-invalid={name !== '' && !validName}
            placeholder={t('themeAssets.nameHint')}
            maxLength={32}
            value={name}
            onChange={(event) => setName(event.target.value.trim())}
          />
        </label>
        <label>
          {t('themeAssets.file')}
          <input
            key={inputKey}
            type="file"
            aria-label={t('themeAssets.file')}
            accept={kind === 'font' ? '.woff2,.woff,.ttf,.otf' : 'image/*'}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || !file || !validName}
          aria-busy={busy}
          onClick={() => void add()}
        >
          <Plus size={18} aria-hidden="true" /> {t('themeAssets.add')}
        </button>
      </div>
      <TransientNotice message={notice} />
    </section>
  );
}
