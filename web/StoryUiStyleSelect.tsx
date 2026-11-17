import { storyUiStyles, type StoryUiStyleSetting } from '../core/story-ui-style.js';
import { t, useI18n } from './i18n.js';
import { useThemes } from './ThemeContext.js';

export function StoryUiStyleSelect({
  value,
  onChange,
  'aria-label': label,
}: {
  value: StoryUiStyleSetting;
  onChange: (value: StoryUiStyleSetting) => void;
  'aria-label'?: string;
}) {
  useI18n();
  const { catalog } = useThemes();
  const themes = catalog.themes.filter((theme) => theme.storyUi);
  const unavailable =
    value.startsWith('theme:') && !themes.some((theme) => `theme:${theme.id}` === value);
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as StoryUiStyleSetting)}
    >
      {unavailable && <option value={value}>{t('storyUi.unavailableTheme')}</option>}
      {(['auto', ...storyUiStyles] as const).map((style) => (
        <option key={style} value={style}>
          {t(`storyUi.style.${style}`)}
        </option>
      ))}
      {themes.map((theme) => (
        <option key={theme.id} value={`theme:${theme.id}`}>
          {theme.title}
        </option>
      ))}
    </select>
  );
}
