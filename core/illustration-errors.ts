import type { IllustrationDiagnostic } from './illustration.js';

export class IllustrationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly diagnostic: Partial<Omit<IllustrationDiagnostic, 'attempts' | 'retries'>> = {}
  ) {
    super(code);
    this.name = 'IllustrationError';
  }
}
