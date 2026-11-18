import type { IllustrationDiagnostic } from './illustration.js';

export class IllustrationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly diagnostic: Partial<Omit<IllustrationDiagnostic, 'attempts' | 'retries'>>;
  constructor(
    code: string,
    retryable = false,
    diagnostic: Partial<Omit<IllustrationDiagnostic, 'attempts' | 'retries'>> = {}
  ) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
    this.name = 'IllustrationError';
  }
}
