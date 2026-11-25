import { isDeepStrictEqual } from 'node:util';
import type { Connection } from '../core/product.js';
import type { WireRecord } from '../core/transport.js';
import {
  isJudgmentConnection,
  judgmentPriceFor,
  judgmentPriceTarget,
  judgmentPricingSnapshot,
} from '../core/judgment-settings.js';
import {
  DEFAULT_JUDGMENT_TARGET,
  JudgmentError,
  targetFromJudgmentWire,
  type JudgmentHooks,
} from './judgment.js';
import { JevCredentialStore } from './jev-credentials.js';
import { jevSettings } from './jev-settings.js';
import { judgmentSettings } from './prompt-workspace.js';
import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

export function judgmentRuntime(
  store: Store,
  legacyCredential?: JudgmentHooks['credential']
): Pick<JudgmentHooks, 'target' | 'credential' | 'settings' | 'pricingSnapshot'> {
  const { selection, prices } = judgmentSettings(store);
  const target = judgmentPriceTarget(selection);
  const pricingSnapshot = judgmentPricingSnapshot(target, judgmentPriceFor(prices, target));
  const pricing = pricingSnapshot ? { pricingSnapshot } : {};
  if (selection.provider === 'typesafe')
    return {
      ...pricing,
      credential: legacyCredential ?? new JevCredentialStore(store.db).resolve,
      settings: jevSettings(store.db),
    };
  let connection: Connection | undefined;
  try {
    connection = store.product.get<Connection>('connection', selection.connectionId);
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
  }
  const captured = connection;
  const suffix = selection.provider === 'typesafe-compatible' ? 'systemone' : 'decisions';
  return {
    ...pricing,
    target: {
      provider: selection.provider,
      connectionId: selection.connectionId,
      modelId: selection.modelId,
      endpoint: captured ? `${captured.endpoint.replace(/\/+$/u, '')}/${suffix}` : '',
    },
    settings: { images: selection.images, longContext: false },
    credential: () => {
      if (!captured || !isJudgmentConnection(selection.provider, captured))
        throw new JudgmentError('JUDGMENT_CONNECTION_UNAVAILABLE');
      try {
        store.product.authorize(captured);
      } catch (error) {
        if (error instanceof HttpError && (error.statusCode === 403 || error.statusCode === 404))
          throw new JudgmentError('JUDGMENT_CONNECTION_UNAVAILABLE');
        throw error;
      }
      return captured.credentialRef ? store.credentials.get(captured.credentialRef) : undefined;
    },
  };
}

export function assertJudgmentRuntimeWire(
  wire: WireRecord,
  runtime: Pick<JudgmentHooks, 'target'>
) {
  const expected = runtime.target ?? DEFAULT_JUDGMENT_TARGET;
  if (!isDeepStrictEqual(targetFromJudgmentWire(wire), expected))
    throw new JudgmentError('JUDGMENT_ATTEMPT_MISMATCH');
}
