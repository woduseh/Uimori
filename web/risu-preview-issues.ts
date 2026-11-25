import { t } from './i18n.js';

export function previewIssueMessage(issue: string) {
  const [, kind, detail] = /^(asset|regex|regex-command):(.*)$/su.exec(issue) ?? [];
  if (kind === 'asset') return t('draftPreview.issueAsset', { name: detail! });
  if (kind && /^\d+$/u.test(detail!)) {
    const number = Number(detail) + 1;
    return kind === 'regex'
      ? t('draftPreview.issueRegex', { number })
      : t('draftPreview.issueRegexCommand', { number });
  }
  return t('draftPreview.issueFunction', { name: issue });
}
