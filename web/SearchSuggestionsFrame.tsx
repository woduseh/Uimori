import { t, useI18n } from './i18n.js';
import './search-suggestions-frame.css';

export function SearchSuggestionsFrame({ html }: { html: string }) {
  useI18n();
  return (
    <iframe
      className="search-suggestions-frame"
      title={t('prompts.uiStoryGuideSearchSuggestions')}
      srcDoc={html}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
    />
  );
}
