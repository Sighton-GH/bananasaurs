import { ProviderError } from './errors.js';

export const NET_ERROR_CODES = [
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
] as const;

export type NetErrorCode = (typeof NET_ERROR_CODES)[number];

const NET_ERROR_SET: ReadonlySet<string> = new Set<string>(NET_ERROR_CODES);

const isNetErrorCode = (value: unknown): value is NetErrorCode =>
  typeof value === 'string' && NET_ERROR_SET.has(value);

/**
 * Walks err, err.cause, err.cause.cause … (max depth 5); returns the first
 * `code` in the allowlist, else undefined.
 */
export const netCodeOf: (err: unknown) => NetErrorCode | undefined = (err: unknown) => {
  let current: unknown = err;
  for (let depth = 0; depth <= 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (isNetErrorCode(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

export type ProviderFailureCode =
  | 'provider-connect-timeout'
  | 'provider-dns'
  | 'provider-connection-refused'
  | 'provider-network-unreachable'
  | 'provider-tls'
  | 'provider-network-error'
  | 'provider-timeout'
  | 'provider-auth'
  | 'provider-bad-model'
  | 'provider-rate-limit'
  | 'provider-daily-quota'
  | 'provider-credits'
  | 'provider-outage'
  | 'provider-invalid-response'
  | 'provider-empty-answer'
  | 'provider-safety-refusal'
  | 'provider-error'
  | 'local-rpm-limit'
  | 'local-rpd-limit';

export interface FailureText {
  readonly title: string;
  readonly explanation: string;
  readonly hint: string;
}

export const PROVIDER_FAILURE_TEXT: Readonly<Record<ProviderFailureCode, FailureText>> = {
  'provider-connect-timeout': {
    title: 'Could not connect to the AI provider',
    explanation:
      "The connection to the provider's server timed out before it was established. This is almost always the network on the Bananasaurs host: a VPN, a firewall, or broken IPv6.",
    hint: 'Check the host’s VPN and network. If a VPN is on, raise AI tuning → Network → Connect fallback wait, or turn the VPN off.',
  },
  'provider-dns': {
    title: "The provider's address could not be looked up",
    explanation: "DNS did not return an address for the provider's host.",
    hint: "Check the host's DNS and internet connection.",
  },
  'provider-connection-refused': {
    title: 'The provider refused or dropped the connection',
    explanation: 'The connection was refused or reset before a response arrived.',
    hint: 'Usually brief. If it persists, check any proxy or firewall on the host.',
  },
  'provider-network-unreachable': {
    title: "The provider's network is unreachable",
    explanation: 'The host has no route to the provider.',
    hint: "Check the host's network connection and any VPN.",
  },
  'provider-tls': {
    title: 'The secure connection to the provider failed',
    explanation: "The provider's certificate could not be verified.",
    hint: "Check the host's clock, and whether a proxy is intercepting HTTPS.",
  },
  'provider-network-error': {
    title: 'The request to the provider failed',
    explanation: 'The request failed before any response arrived.',
    hint: 'Check the host’s network. The daemon log has the detail.',
  },
  'provider-timeout': {
    title: 'The provider did not answer in time',
    explanation:
      'The request was sent but no answer came back within the provider request timeout.',
    hint: 'Raise AI tuning → Provider request timeout, or choose a faster model.',
  },
  'provider-auth': {
    title: 'The provider rejected the API key',
    explanation: 'The provider answered 401 or 403 for this key.',
    hint: "Re-paste the key in AI setup, and check that it is active in the provider's console.",
  },
  'provider-bad-model': {
    title: 'This model is not available on this key',
    explanation: 'The provider did not accept this model name for this key.',
    hint: "Check the model name in AI setup against the provider's model list.",
  },
  'provider-rate-limit': {
    title: "The provider's rate limit was reached",
    explanation: 'The provider answered 429: too many requests in a short time.',
    hint: 'Set an RPM limit on this chain entry in AI setup, so Bananasaurs stops before the provider does.',
  },
  'provider-daily-quota': {
    title: "The provider's daily allowance is used up",
    explanation: "The provider refused because this key's daily free allowance is spent.",
    hint: 'It resets on its own. Set an RPD limit on this chain entry, or add a fallback model.',
  },
  'provider-credits': {
    title: 'The provider account has no credit',
    explanation: 'The provider answered that the account is out of credit or quota.',
    hint: "Add credit in the provider's console, or move this entry down the chain.",
  },
  'provider-outage': {
    title: 'The provider had a server problem',
    explanation: 'The provider answered with a 5xx error.',
    hint: "Usually brief; the next chain entry is tried. Check the provider's status page if it persists.",
  },
  'provider-invalid-response': {
    title: "The provider's answer was unusable",
    explanation: 'The provider answered, but with nothing Bananasaurs could use.',
    hint: 'Try again, or choose a different model.',
  },
  'provider-empty-answer': {
    title: 'The model returned an empty answer',
    explanation:
      'The provider answered, but the answer had no text. Reasoning models often do this when their thinking uses up the whole output budget.',
    hint: 'Check the finish reason and reasoning tokens on this attempt. If the finish reason is length, raise AI tuning → Max output tokens, or move this model down the chain.',
  },
  'provider-safety-refusal': {
    title: 'The provider refused on safety grounds',
    explanation: "The provider's safety filter blocked the request or the answer.",
    hint: 'Rephrase the question, or choose a different model.',
  },
  'provider-error': {
    title: 'The provider request failed',
    explanation: 'The request failed for a reason Bananasaurs does not recognise.',
    hint: "The daemon log has the detail. Search for this model's name.",
  },
  'local-rpm-limit': {
    title: 'This model reached its per-minute limit',
    explanation: "Bananasaurs did not call it, because this chain entry's RPM limit is used up.",
    hint: 'It frees up within a minute. Raise the RPM limit in AI setup if the provider allows more.',
  },
  'local-rpd-limit': {
    title: 'This model reached its daily limit',
    explanation:
      "Bananasaurs did not call it, because this chain entry's RPD limit is used up for the provider's day.",
    hint: "It frees up at the provider's next day start. Raise the RPD limit in AI setup if the provider allows more.",
  },
};

/** All 19 codes, in the order above. */
export const PROVIDER_FAILURE_CODES: readonly ProviderFailureCode[] = [
  'provider-connect-timeout',
  'provider-dns',
  'provider-connection-refused',
  'provider-network-unreachable',
  'provider-tls',
  'provider-network-error',
  'provider-timeout',
  'provider-auth',
  'provider-bad-model',
  'provider-rate-limit',
  'provider-daily-quota',
  'provider-credits',
  'provider-outage',
  'provider-invalid-response',
  'provider-empty-answer',
  'provider-safety-refusal',
  'provider-error',
  'local-rpm-limit',
  'local-rpd-limit',
];

export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly provider: string;
  readonly model: string;
  readonly host?: string;
  readonly httpStatus?: number;
  readonly netCode?: NetErrorCode;
  readonly finishReason?: string;
  readonly upstream?: string;
  readonly retryable: boolean;
  readonly resetAt?: number;
}

const netCodeToFailureCode = (netCode: NetErrorCode): ProviderFailureCode => {
  if (netCode === 'UND_ERR_CONNECT_TIMEOUT' || netCode === 'ETIMEDOUT')
    return 'provider-connect-timeout';
  if (netCode === 'ENOTFOUND' || netCode === 'EAI_AGAIN') return 'provider-dns';
  if (
    netCode === 'ECONNREFUSED' ||
    netCode === 'ECONNRESET' ||
    netCode === 'EPIPE' ||
    netCode === 'UND_ERR_SOCKET'
  )
    return 'provider-connection-refused';
  if (netCode === 'EHOSTUNREACH' || netCode === 'ENETUNREACH')
    return 'provider-network-unreachable';
  if (
    netCode === 'CERT_HAS_EXPIRED' ||
    netCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    netCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    netCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    netCode === 'ERR_TLS_CERT_ALTNAME_INVALID'
  )
    return 'provider-tls';
  return 'provider-timeout';
};

const optionalFieldsOf = (
  err: unknown,
): {
  readonly host?: string;
  readonly httpStatus?: number;
  readonly netCode?: NetErrorCode;
  readonly finishReason?: string;
  readonly upstream?: string;
  readonly resetAt?: number;
} => {
  if (typeof err !== 'object' || err === null) return {};
  const record = err as {
    host?: unknown;
    status?: unknown;
    netCode?: unknown;
    finishReason?: unknown;
    upstream?: unknown;
    resetAt?: unknown;
  };
  const host = typeof record.host === 'string' ? record.host : undefined;
  const httpStatus = typeof record.status === 'number' ? record.status : undefined;
  const netCode = isNetErrorCode(record.netCode) ? record.netCode : undefined;
  const finishReason = typeof record.finishReason === 'string' ? record.finishReason : undefined;
  const upstream = typeof record.upstream === 'string' ? record.upstream : undefined;
  const resetAt = typeof record.resetAt === 'number' ? record.resetAt : undefined;
  return {
    ...(host === undefined ? {} : { host }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(netCode === undefined ? {} : { netCode }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(upstream === undefined ? {} : { upstream }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
};

export const classifyProviderFailure: (
  err: unknown,
  ctx: { provider: string; model: string },
) => ProviderFailure = (err, ctx) => {
  const fields = optionalFieldsOf(err);
  const retryable = err instanceof ProviderError ? err.retryable : false;
  const base = {
    provider: ctx.provider,
    model: ctx.model,
    ...(fields.host === undefined ? {} : { host: fields.host }),
    ...(fields.httpStatus === undefined ? {} : { httpStatus: fields.httpStatus }),
    ...(fields.netCode === undefined ? {} : { netCode: fields.netCode }),
    ...(fields.finishReason === undefined ? {} : { finishReason: fields.finishReason }),
    ...(fields.upstream === undefined ? {} : { upstream: fields.upstream }),
    retryable,
  } as const;

  // Rule 1: daily free-model allowance.
  if (err instanceof ProviderError && err.quotaScope === 'daily-free') {
    return {
      code: 'provider-daily-quota',
      ...base,
      ...(fields.resetAt === undefined ? {} : { resetAt: fields.resetAt }),
    };
  }

  // Rule 2: network error code, from the error itself or its cause chain.
  const netCode = fields.netCode ?? netCodeOf(err);
  if (netCode !== undefined) {
    return {
      code: netCodeToFailureCode(netCode),
      ...base,
      netCode,
    };
  }

  // Rule 3: client-side timeout.
  if (err instanceof ProviderError && err.kind === 'timeout') {
    return { code: 'provider-timeout', ...base };
  }

  // Rule 3b: defence in depth for an adapter that leaks the raw abort
  // reason: a bare DOMException TimeoutError is a client-side timeout too,
  // and retrying is safe.
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return { code: 'provider-timeout', ...base, retryable: true };
  }

  // Rule 4: by status, or by kind when no status arrived.
  const status = fields.httpStatus;
  if (status !== undefined) {
    if (status === 401 || status === 403) return { code: 'provider-auth', ...base };
    if (status === 402) return { code: 'provider-credits', ...base };
    if (status === 429) return { code: 'provider-rate-limit', ...base };
    if (status === 400 || status === 404) return { code: 'provider-bad-model', ...base };
    if (status >= 500) return { code: 'provider-outage', ...base };
  } else if (err instanceof ProviderError) {
    if (err.kind === 'authentication') return { code: 'provider-auth', ...base };
    if (err.kind === 'rate-limit') return { code: 'provider-rate-limit', ...base };
    if (err.kind === 'invalid-request' || err.kind === 'capability-mismatch')
      return { code: 'provider-bad-model', ...base };
  }

  // Rule 5: account credit exhaustion.
  if (err instanceof ProviderError && err.kind === 'quota') {
    return { code: 'provider-credits', ...base };
  }

  // Rule 6: an empty answer explains itself; other unusable answers stay invalid-response.
  if (
    err instanceof ProviderError &&
    err.kind === 'invalid-response' &&
    err.emptyAnswer !== undefined
  ) {
    return { code: 'provider-empty-answer', ...base };
  }
  if (err instanceof ProviderError && err.kind === 'invalid-response') {
    return { code: 'provider-invalid-response', ...base };
  }
  if (err instanceof ProviderError && err.kind === 'safety-refusal') {
    return { code: 'provider-safety-refusal', ...base };
  }

  // Rule 7: the request never reached the provider.
  if (err instanceof ProviderError && err.kind === 'outage' && fields.httpStatus === undefined) {
    return { code: 'provider-network-error', ...base };
  }

  // Rule 8: anything else.
  return { code: 'provider-error', ...base };
};
