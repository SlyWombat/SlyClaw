import { describe, expect, it } from 'vitest';

import { isRetryableNetworkError } from './weather-station.js';

describe('isRetryableNetworkError', () => {
  it('retries transient DNS failures (EAI_AGAIN) wrapped by undici', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = new Error('getaddrinfo EAI_AGAIN api.ecowitt.net');
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it('retries connect timeouts', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = Object.assign(
      new Error('Connect Timeout Error (attempted address: api.ecowitt.net:443, timeout: 10000ms)'),
      { name: 'ConnectTimeoutError' },
    );
    expect(isRetryableNetworkError(err)).toBe(true);
  });

  it('retries aborted/timed-out fetches by error name', () => {
    expect(isRetryableNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isRetryableNetworkError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe(true);
  });

  it('retries connection resets', () => {
    expect(isRetryableNetworkError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does NOT retry rate-limit ("Operation too frequent") — serve stale cache instead', () => {
    expect(isRetryableNetworkError(new Error('Ecowitt API error -1: Operation too frequent'))).toBe(false);
  });

  it('does NOT retry HTTP/auth errors', () => {
    expect(isRetryableNetworkError(new Error('Ecowitt API HTTP 401'))).toBe(false);
    expect(isRetryableNetworkError(new Error('Ecowitt API error -2: Invalid api_key'))).toBe(false);
  });

  it('handles non-Error inputs', () => {
    expect(isRetryableNetworkError('EAI_AGAIN')).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
    expect(isRetryableNetworkError(undefined)).toBe(false);
  });
});
