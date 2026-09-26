import { describe, expect, it } from 'vitest';
import { ApiError, OfflineError } from '../api.js';
import { describeError, fieldError } from './describe-error.js';

describe('describeError', () => {
  it('carries every field of a full ApiError body through', () => {
    const err = new ApiError(400, {
      error: 'bad-request',
      title: 'That value is not valid',
      message: 'rpmLimit must be a number.',
      hint: 'Fix the highlighted field and try again.',
      fields: [{ path: 'entries.0.rpmLimit', problem: 'invalid_type' }],
      requestId: 'req-0a1b2c3d',
    });
    expect(describeError(err)).toEqual({
      title: 'That value is not valid',
      message: 'rpmLimit must be a number.',
      hint: 'Fix the highlighted field and try again.',
      code: 'bad-request',
      status: 400,
      requestId: 'req-0a1b2c3d',
      fields: [{ path: 'entries.0.rpmLimit', problem: 'invalid_type' }],
    });
  });

  it('falls back to the generic title and message when the body has only a code', () => {
    const described = describeError(new ApiError(403, { error: 'x' }));
    expect(described.title).toBe('The request failed');
    expect(described.message).toBe('Bananasaurs refused the request (x).');
    expect(described.code).toBe('x');
    expect(described.status).toBe(403);
    expect(described.hint).toBeUndefined();
    expect(described.requestId).toBeUndefined();
    expect(described.fields).toEqual([]);
  });

  it('explains an unreadable response with the UNREADABLE title, message and hint', () => {
    const described = describeError(new ApiError(502, { error: 'unreadable-response' }));
    expect(described.title).toBe("The server's answer could not be read");
    expect(described.message).toBe(
      'Something between the browser and Bananasaurs answered with a page that is not JSON.',
    );
    expect(described.hint).toBe('Check that the daemon is running and the tunnel is up.');
    expect(described.code).toBe('unreadable-response');
  });

  it('maps an OfflineError to dashboard-offline', () => {
    expect(describeError(new OfflineError('TypeError: fetch failed'))).toEqual({
      code: 'dashboard-offline',
      title: 'Bananasaurs could not be reached',
      message: 'The browser could not reach the dashboard API. The daemon may be restarting.',
      hint: 'Wait a moment and try again.',
      fields: [],
    });
  });

  it('maps any other Error to dashboard-bug with its message', () => {
    const described = describeError(new Error('boom'));
    expect(described.code).toBe('dashboard-bug');
    expect(described.title).toBe('Something went wrong in this page');
    expect(described.message).toBe('boom');
    expect(described.fields).toEqual([]);
  });

  it('maps a non-Error throw to dashboard-bug with its string form', () => {
    const described = describeError('weird');
    expect(described.code).toBe('dashboard-bug');
    expect(described.message).toBe('weird');
  });
});

describe('fieldError', () => {
  const err = new ApiError(400, {
    error: 'bad-request',
    message: 'Validation failed.',
    fields: [
      { path: 'provider', problem: 'invalid_enum_value' },
      { path: 'entries.0.rpmLimit', problem: 'too_small' },
    ],
  });

  it('matches a field path exactly', () => {
    expect(fieldError(err, 'provider')).toBe('Not one of the allowed choices.');
  });

  it('matches a nested field by its parent prefix', () => {
    expect(fieldError(err, 'entries')).toBe('Too small.');
  });

  it('returns undefined when no field matches', () => {
    expect(fieldError(err, 'nope')).toBeUndefined();
    expect(fieldError(new Error('boom'), 'provider')).toBeUndefined();
  });
});
