import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import {
  classifyProviderFailure,
  netCodeOf,
  PROVIDER_FAILURE_CODES,
  PROVIDER_FAILURE_TEXT,
} from './failure.js';

const connectTimeoutError = (): ProviderError =>
  new ProviderError('outage', 'openrouter request failed', true, {
    cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      }),
    }),
    host: 'openrouter.ai',
  });

const codedCause = (code: string): TypeError =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('boom'), { code }),
  });

describe('classifyProviderFailure', () => {
  it('classifies the connect-timeout case', () => {
    const failure = classifyProviderFailure(connectTimeoutError(), {
      provider: 'openrouter',
      model: 'm',
    });
    expect(failure).toMatchObject({
      code: 'provider-connect-timeout',
      netCode: 'UND_ERR_CONNECT_TIMEOUT',
      host: 'openrouter.ai',
      retryable: true,
    });
  });

  it.each([
    ['ENOTFOUND', 'provider-dns'],
    ['EAI_AGAIN', 'provider-dns'],
    ['ECONNREFUSED', 'provider-connection-refused'],
    ['ECONNRESET', 'provider-connection-refused'],
    ['EPIPE', 'provider-connection-refused'],
    ['UND_ERR_SOCKET', 'provider-connection-refused'],
    ['EHOSTUNREACH', 'provider-network-unreachable'],
    ['ENETUNREACH', 'provider-network-unreachable'],
    ['CERT_HAS_EXPIRED', 'provider-tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'provider-tls'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'provider-tls'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'provider-tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'provider-tls'],
    ['UND_ERR_HEADERS_TIMEOUT', 'provider-timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'provider-timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'provider-connect-timeout'],
    ['ETIMEDOUT', 'provider-connect-timeout'],
  ] as const)('maps net code %s to %s', (netCode, code) => {
    const err = new ProviderError('outage', 'x', true, {
      cause: codedCause(netCode),
      host: 'example.com',
    });
    const failure = classifyProviderFailure(err, { provider: 'p', model: 'm' });
    expect(failure.code).toBe(code);
    expect(failure.netCode).toBe(netCode);
  });

  it("maps kind 'timeout' to provider-timeout", () => {
    const failure = classifyProviderFailure(new ProviderError('timeout', 'x', true), {
      provider: 'p',
      model: 'm',
    });
    expect(failure.code).toBe('provider-timeout');
    expect(failure.retryable).toBe(true);
  });

  it.each([
    [401, 'authentication', false, 'provider-auth'],
    [403, 'authentication', false, 'provider-auth'],
    [402, 'quota', false, 'provider-credits'],
    [429, 'rate-limit', true, 'provider-rate-limit'],
    [400, 'invalid-request', false, 'provider-bad-model'],
    [404, 'invalid-request', false, 'provider-bad-model'],
    [503, 'outage', true, 'provider-outage'],
    [500, 'outage', true, 'provider-outage'],
  ] as const)('maps status %s to %s', (status, kind, retryable, code) => {
    const failure = classifyProviderFailure(new ProviderError(kind, 'x', retryable, { status }), {
      provider: 'p',
      model: 'm',
    });
    expect(failure.code).toBe(code);
    expect(failure.httpStatus).toBe(status);
  });

  it('maps kind-only errors without status', () => {
    expect(
      classifyProviderFailure(new ProviderError('authentication', 'x', false), {
        provider: 'p',
        model: 'm',
      }).code,
    ).toBe('provider-auth');
    expect(
      classifyProviderFailure(new ProviderError('rate-limit', 'x', true), {
        provider: 'p',
        model: 'm',
      }).code,
    ).toBe('provider-rate-limit');
    expect(
      classifyProviderFailure(new ProviderError('invalid-request', 'x', false), {
        provider: 'p',
        model: 'm',
      }).code,
    ).toBe('provider-bad-model');
    expect(
      classifyProviderFailure(new ProviderError('capability-mismatch', 'x', false), {
        provider: 'p',
        model: 'm',
      }).code,
    ).toBe('provider-bad-model');
  });

  it("maps kind 'quota' without scope to provider-credits", () => {
    const failure = classifyProviderFailure(new ProviderError('quota', 'x', false), {
      provider: 'p',
      model: 'm',
    });
    expect(failure.code).toBe('provider-credits');
  });

  it('maps daily-free quota to provider-daily-quota with resetAt', () => {
    const failure = classifyProviderFailure(
      new ProviderError('quota', 'x', false, { quotaScope: 'daily-free', resetAt: 123 }),
      { provider: 'p', model: 'm' },
    );
    expect(failure.code).toBe('provider-daily-quota');
    expect(failure.resetAt).toBe(123);
  });

  it('maps invalid-response and safety-refusal', () => {
    expect(
      classifyProviderFailure(new ProviderError('invalid-response', 'x', false), {
        provider: 'p',
        model: 'm',
      }).code,
    ).toBe('provider-invalid-response');
    expect(
      classifyProviderFailure(new ProviderError('safety-refusal', 'x', false), {
        provider: 'p',
        model: 'm',
      }).code,
    ).toBe('provider-safety-refusal');
  });

  it("maps a bare outage to provider-network-error", () => {
    const failure = classifyProviderFailure(new ProviderError('outage', 'x', true), {
      provider: 'p',
      model: 'm',
    });
    expect(failure.code).toBe('provider-network-error');
    expect(failure.retryable).toBe(true);
  });

  it('maps a plain error to provider-error with retryable false', () => {
    const failure = classifyProviderFailure(new Error('x'), { provider: 'p', model: 'm' });
    expect(failure.code).toBe('provider-error');
    expect(failure.retryable).toBe(false);
  });
});

describe('netCodeOf', () => {
  it('returns undefined for an unknown code', () => {
    expect(netCodeOf(Object.assign(new Error('x'), { code: 'EWHATEVER' }))).toBeUndefined();
  });

  it('stops at depth 5', () => {
    let err: unknown = Object.assign(new Error('deep'), { code: 'ENOTFOUND' });
    for (let i = 0; i < 7; i += 1) err = new Error('wrap', { cause: err });
    expect(netCodeOf(err)).toBeUndefined();
    let shallow: unknown = Object.assign(new Error('deep'), { code: 'ENOTFOUND' });
    for (let i = 0; i < 3; i += 1) shallow = new Error('wrap', { cause: shallow });
    expect(netCodeOf(shallow)).toBe('ENOTFOUND');
  });
});

describe('PROVIDER_FAILURE_TEXT', () => {
  it('has 18 codes each with non-empty title, explanation and hint', () => {
    expect(PROVIDER_FAILURE_CODES).toHaveLength(18);
    for (const code of PROVIDER_FAILURE_CODES) {
      const text = PROVIDER_FAILURE_TEXT[code];
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.explanation.length).toBeGreaterThan(0);
      expect(text.hint.length).toBeGreaterThan(0);
    }
  });
});
