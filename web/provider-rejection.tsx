import { t, useI18n } from './i18n.js';
import type { ProviderRejection, RejectedOption } from '../core/provider-rejection.js';

/** User-facing names for the option groups a provider can reject. */
const rejectedOptionLabels: Record<RejectedOption, string> = {
  thinking: 'errors.option.thinking',
  temperature: 'Temperature',
  topP: 'Top-p',
  maxOutputTokens: 'errors.option.maxOutputTokens',
  stopSequences: 'errors.option.stopSequences',
  serviceTier: 'errors.option.serviceTier',
  cache: 'errors.option.cache',
  structuredOutput: 'errors.option.structuredOutput',
  verbosity: 'Verbosity',
  reasoningMode: 'Reasoning Mode',
  reasoningContext: 'Reasoning Context',
  model: 'errors.option.model',
  tools: 'errors.option.tools',
  input: 'errors.option.input',
};
export function rejectionMessage(rejection: ProviderRejection): string {
  const names = [
    ...rejection.options.map((option) =>
      rejectedOptionLabels[option].startsWith('errors.')
        ? t(rejectedOptionLabels[option])
        : rejectedOptionLabels[option]
    ),
    ...(rejection.unmappedFields ?? []),
  ];
  return names.length
    ? t('errors.rejectionNamed', { options: names.join(', ') })
    : rejection.message
      ? t('errors.rejectionDetails')
      : t('errors.rejectionUnspecified');
}
/** The provider's verdict on saved options; the app never rewrites the option on its own. */
export function ProviderRejectionNotice({ rejection }: { rejection: ProviderRejection }) {
  useI18n();
  const optionNamed = rejection.options.some((option) => option !== 'input');
  return (
    <div className="provider-rejection" role="status">
      <p>
        {rejectionMessage(rejection)}{' '}
        {optionNamed ? t('errors.rejectionAction') : t('errors.rejectionInputAction')}
        {rejection.providerCode && (
          <small> {t('errors.providerCode', { code: rejection.providerCode })}</small>
        )}
      </p>
      {rejection.message && (
        <details>
          <summary>{t('errors.providerDetails')}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {rejection.message}
          </pre>
          <small>{t('errors.providerPrivacy')}</small>
        </details>
      )}
    </div>
  );
}
