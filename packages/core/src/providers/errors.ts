export type ProviderErrorKind =
  | 'authentication'
  | 'quota'
  | 'rate-limit'
  | 'timeout'
  | 'safety-refusal'
  | 'invalid-request'
  | 'outage'
  | 'capability-mismatch'
  | 'invalid-response';

export class ProviderError extends Error {
  public constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
