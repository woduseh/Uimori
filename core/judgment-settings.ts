import type { Connection } from './product.js';

export const OFFICIAL_JUDGMENT_MODELS = {
  openai: 'gpt-6-luna',
  gemini: 'gemini-decision-1',
} as const;

export type ExternalJudgmentProvider =
  | keyof typeof OFFICIAL_JUDGMENT_MODELS
  | 'openai-compatible'
  | 'typesafe-compatible';

export type JudgmentSelection =
  | { provider: 'typesafe' }
  | { provider: ExternalJudgmentProvider; connectionId: string; modelId: string; images: boolean };

export const DEFAULT_JUDGMENT_SELECTION = { provider: 'typesafe' } as const;

export function isJudgmentConnection(
  provider: ExternalJudgmentProvider,
  connection: Pick<Connection, 'enabled' | 'protocol' | 'endpoint'>
): boolean {
  if (!connection.enabled) return false;
  const endpoint = connection.endpoint.replace(/\/+$/u, '');
  const openAIProtocol =
    connection.protocol === 'openai-responses-v1' || connection.protocol === 'openai-chat-v1';
  if (provider === 'openai') return openAIProtocol && endpoint === 'https://api.openai.com/v1';
  if (provider === 'gemini')
    return (
      connection.protocol === 'google-gemini-v1' &&
      endpoint === 'https://generativelanguage.googleapis.com/v1beta'
    );
  return openAIProtocol || connection.protocol === 'vercel-chat-v1';
}
