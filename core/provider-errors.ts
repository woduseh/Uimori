export class ProviderContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProviderContractError'; }
}
