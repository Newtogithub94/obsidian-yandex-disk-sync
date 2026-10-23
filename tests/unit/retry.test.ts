import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withRetry,
  computeBackoffDelay,
  isTransientError,
  parseRetryAfterHeader,
  extractHttpStatus,
  extractRetryAfterMs,
  OperationCancelledError,
  abortableSleep,
  delayMs,
  getHeader,
} from '../../src/api/retry';
import { YandexApiError } from '../../src/api/yandex-types';
import { SyncError, YandexDiskInfo } from '../../src/types';
import { MockYandexDiskServer } from '../mocks/mock-yandex-disk';

describe('src/api/retry.ts: Network Retry & Resilience', () => {
  describe('1. Exponential Backoff & Jitter Calculation', () => {
    it('computes nominal backoff delays for attempts 1 to 6 with zero jitter', () => {
      // randomFn returning 0.5 results in jitterMultiplier = 1.0 (exact base delay)
      const mockRandomMid = () => 0.5;

      expect(computeBackoffDelay(1, {}, mockRandomMid)).toBe(1000);
      expect(computeBackoffDelay(2, {}, mockRandomMid)).toBe(2000);
      expect(computeBackoffDelay(3, {}, mockRandomMid)).toBe(4000);
      expect(computeBackoffDelay(4, {}, mockRandomMid)).toBe(8000);
      expect(computeBackoffDelay(5, {}, mockRandomMid)).toBe(16000);
      expect(computeBackoffDelay(6, {}, mockRandomMid)).toBe(30000); // Clamped at maxDelay (30000ms)
    });

    it('bounds jitter strictly within ±20% interval', () => {
      const mockRandomMin = () => 0.0; // jitterMultiplier = 0.8 (-20%)
      const mockRandomMax = () => 1.0; // jitterMultiplier = 1.2 (+20%)

      expect(computeBackoffDelay(1, {}, mockRandomMin)).toBe(800);
      expect(computeBackoffDelay(1, {}, mockRandomMax)).toBe(1200);

      expect(computeBackoffDelay(2, {}, mockRandomMin)).toBe(1600);
      expect(computeBackoffDelay(2, {}, mockRandomMax)).toBe(2400);

      expect(computeBackoffDelay(3, {}, mockRandomMin)).toBe(3200);
      expect(computeBackoffDelay(3, {}, mockRandomMax)).toBe(4800);
    });

    it('clamps delay to custom maxDelayMs when configured', () => {
      const delay = computeBackoffDelay(10, { maxDelayMs: 15000 }, () => 0.5);
      expect(delay).toBe(15000);
    });

    it('handles custom initialDelay and backoffFactor', () => {
      const delay = computeBackoffDelay(
        3,
        { initialDelayMs: 500, backoffFactor: 3.0 },
        () => 0.5
      );
      // 500 * 3^(3-1) = 500 * 9 = 4500
      expect(delay).toBe(4500);
    });
  });

  describe('2. Retry-After Header Parsing & Extraction', () => {
    it('parses integer seconds correctly and case-insensitively', () => {
      expect(parseRetryAfterHeader({ 'retry-after': '5' })).toBe(5000);
      expect(parseRetryAfterHeader({ 'Retry-After': '120' })).toBe(120000);
      expect(parseRetryAfterHeader({ 'RETRY-AFTER': ' 10 ' })).toBe(10000);
    });

    it('parses HTTP-Date format correctly', () => {
      const future = new Date(Date.now() + 60000).toUTCString();
      const parsed = parseRetryAfterHeader({ 'retry-after': future });
      expect(parsed).toBeGreaterThan(55000);
      expect(parsed).toBeLessThanOrEqual(65000);
    });

    it('returns undefined for invalid or missing header', () => {
      expect(parseRetryAfterHeader(undefined)).toBeUndefined();
      expect(parseRetryAfterHeader({})).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': 'invalid-date' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'other-header': 'value' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': '-5' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': '-120' })).toBeUndefined();
    });

    it('handles numeric and ISO-8601 date formats safely', () => {
      expect(parseRetryAfterHeader({ 'retry-after': 30 as any })).toBe(30000);
      expect(parseRetryAfterHeader({ 'retry-after': 0 as any })).toBe(0);
      expect(parseRetryAfterHeader({ 'retry-after': -5 as any })).toBeUndefined();

      const futureIso = new Date(Date.now() + 60000).toISOString();
      const parsed = parseRetryAfterHeader({ 'retry-after': futureIso });
      expect(parsed).toBeGreaterThan(50000);
      expect(parsed).toBeLessThanOrEqual(65000);
    });

    it('extracts Retry-After from error objects and nested responses', () => {
      const err1 = { headers: { 'retry-after': '7' } };
      expect(extractRetryAfterMs(err1)).toBe(7000);

      const err2 = { response: { headers: { 'Retry-After': '15' } } };
      expect(extractRetryAfterMs(err2)).toBe(15000);

      expect(extractRetryAfterMs(null)).toBeUndefined();
      expect(extractRetryAfterMs(new Error('no headers'))).toBeUndefined();
    });

    it('extracts status code via extractHttpStatus across diverse formats', () => {
      expect(extractHttpStatus(new YandexApiError('Forbidden', 403))).toBe(403);
      expect(extractHttpStatus({ status: 500 })).toBe(500);
      expect(extractHttpStatus({ statusCode: 502 })).toBe(502);
      expect(extractHttpStatus({ response: { status: 429 } })).toBe(429);
      expect(extractHttpStatus(new Error('Request failed with HTTP 503'))).toBe(503);
      expect(extractHttpStatus(new Error('status code 404'))).toBe(404);
      expect(extractHttpStatus(new Error('Network error without status'))).toBeUndefined();
      expect(extractHttpStatus(undefined)).toBeUndefined();
    });

    it('retrieves headers case-insensitively with getHeader', () => {
      const headers = { 'Content-Type': 'application/json', 'X-Custom-Id': '42' };
      expect(getHeader(headers, 'content-type')).toBe('application/json');
      expect(getHeader(headers, 'x-custom-id')).toBe('42');
      expect(getHeader(headers, 'unknown')).toBeUndefined();
      expect(getHeader(undefined, 'foo')).toBeUndefined();
    });
  });

  describe('3. Transient vs Permanent Error Detection', () => {
    it('identifies HTTP 429 as transient', () => {
      expect(isTransientError({ status: 429 })).toBe(true);
      expect(isTransientError(new YandexApiError('Too Many Requests', 429))).toBe(true);
      expect(isTransientError(new SyncError('Rate limited', 'RATE_LIMITED'))).toBe(true);
    });

    it('identifies HTTP 5xx errors as transient', () => {
      expect(isTransientError({ status: 500 })).toBe(true);
      expect(isTransientError({ status: 502 })).toBe(true);
      expect(isTransientError({ status: 503 })).toBe(true);
      expect(isTransientError({ status: 504 })).toBe(true);
      expect(isTransientError({ status: 599 })).toBe(true);
      expect(isTransientError(new YandexApiError('Gateway Error', 502))).toBe(true);
      expect(isTransientError(new SyncError('Server error', 'REMOTE_SERVER_ERROR'))).toBe(true);
    });

    it('identifies permanent HTTP errors as non-transient', () => {
      expect(isTransientError({ status: 400 })).toBe(false);
      expect(isTransientError({ status: 401 })).toBe(false);
      expect(isTransientError({ status: 403 })).toBe(false);
      expect(isTransientError({ status: 404 })).toBe(false);
      expect(isTransientError({ status: 409 })).toBe(false);
      expect(isTransientError({ status: 413 })).toBe(false);
      expect(isTransientError({ status: 415 })).toBe(false);
      expect(isTransientError({ status: 422 })).toBe(false);
      expect(isTransientError(new SyncError('Auth required', 'AUTH_REQUIRED'))).toBe(false);
      expect(isTransientError(new SyncError('Auth invalid', 'AUTH_INVALID'))).toBe(false);
      expect(isTransientError(new SyncError('Remote forbidden', 'REMOTE_FORBIDDEN'))).toBe(false);
      expect(isTransientError(new SyncError('Remote not found', 'REMOTE_NOT_FOUND'))).toBe(false);
      expect(isTransientError(new SyncError('Remote conflict', 'REMOTE_CONFLICT'))).toBe(false);
    });

    it('identifies network drop and timeout errors as transient', () => {
      expect(isTransientError(new Error('ETIMEDOUT: Connection timed out'))).toBe(true);
      expect(isTransientError(new Error('TypeError: Failed to fetch'))).toBe(true);
      expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
      expect(isTransientError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true);
      expect(isTransientError(new SyncError('Timeout', 'NETWORK_TIMEOUT'))).toBe(true);
      expect(isTransientError(new Error('requestUrl: Request timed out'))).toBe(true);
      expect(isTransientError(new Error('Request timed out'))).toBe(true);
      expect(isTransientError(new Error('Connection timed out'))).toBe(true);
      expect(isTransientError(new Error('socket hang up'))).toBe(true);
      expect(isTransientError('Connection timed out')).toBe(true);
    });

    it('returns false for null or undefined or unrecognized errors or cancellations', () => {
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(undefined)).toBe(false);
      expect(isTransientError(new Error('Syntax error'))).toBe(false);
      expect(isTransientError(new OperationCancelledError())).toBe(false);
    });
  });

  describe('4. withRetry Execution', () => {
    let server: MockYandexDiskServer;

    beforeEach(() => {
      server = new MockYandexDiskServer();
    });

    it('succeeds on first attempt without retrying', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withRetry(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on simulated 500 errors and succeeds within maxAttempts', async () => {
      server.injectFailures(2, 500); // Fails twice, succeeds on 3rd

      const fn = vi.fn().mockImplementation(async () => {
        return await server.getDiskInfo();
      });

      const fastSleep = vi.fn().mockResolvedValue(undefined);
      const onRetry = vi.fn();

      const result = await withRetry<YandexDiskInfo>(() => fn(), {
        sleepFn: fastSleep,
        onRetry,
      });
      expect(result.user.login).toBe('mock-user');
      expect(fn).toHaveBeenCalledTimes(3);
      expect(fastSleep).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it('respects Retry-After when larger than computed backoff', async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('Rate limit');
          err.status = 429;
          err.headers = { 'retry-after': '12' }; // 12000ms
          throw err;
        }
        return 'success';
      });

      const sleepDelays: number[] = [];
      const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
        sleepDelays.push(ms);
      });

      const result = await withRetry(fn, {
        sleepFn: mockSleep,
        randomFn: () => 0.5, // Base backoff = 1000ms
      });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(sleepDelays[0]).toBe(12000); // 12000ms > 1000ms
    });

    it('clamps Retry-After to maxDelayMs when clampRetryAfterToMax is true', async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('Rate limit');
          err.status = 429;
          err.headers = { 'retry-after': '60' }; // 60,000ms > maxDelayMs 30,000ms
          throw err;
        }
        return 'clamped';
      });

      const sleepDelays: number[] = [];
      const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
        sleepDelays.push(ms);
      });

      const result = await withRetry(fn, {
        sleepFn: mockSleep,
        maxDelayMs: 25000,
        clampRetryAfterToMax: true,
      });

      expect(result).toBe('clamped');
      expect(sleepDelays[0]).toBe(25000);
    });

    it('fails immediately without retrying on HTTP 401 Unauthorized', async () => {
      const fn = vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' });
      const fastSleep = vi.fn();

      await expect(withRetry(fn, { sleepFn: fastSleep })).rejects.toEqual({
        status: 401,
        message: 'Unauthorized',
      });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fastSleep).not.toHaveBeenCalled();
    });

    it('throws final error after exhausting maxAttempts', async () => {
      server.injectFailures(10, 503);
      const fn = vi.fn().mockImplementation(async () => {
        return await server.getDiskInfo();
      });

      const fastSleep = vi.fn().mockResolvedValue(undefined);
      await expect(withRetry(fn, { maxAttempts: 4, sleepFn: fastSleep })).rejects.toThrow(
        'Simulated HTTP 503'
      );
      expect(fn).toHaveBeenCalledTimes(4);
      expect(fastSleep).toHaveBeenCalledTimes(3);
    });

    it('supports custom isRetryable predicate', async () => {
      let callCount = 0;
      const fn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Custom retriable error');
        }
        return 'custom-ok';
      });

      const customPredicate = (err: unknown) =>
        (err as Error).message === 'Custom retriable error';

      const fastSleep = vi.fn().mockResolvedValue(undefined);
      const result = await withRetry(fn, {
        isRetryable: customPredicate,
        sleepFn: fastSleep,
      });

      expect(result).toBe('custom-ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('5. Cancellation Token & AbortSignal Support', () => {
    it('rejects immediately if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const fn = vi.fn().mockResolvedValue('ok');
      await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(
        OperationCancelledError
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('rejects immediately if isCancelled predicate returns true', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      await expect(withRetry(fn, { isCancelled: () => true })).rejects.toThrow(
        OperationCancelledError
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('aborts active sleep immediately when AbortController triggers abort', async () => {
      const controller = new AbortController();
      const sleepPromise = abortableSleep(10000, controller.signal);

      setTimeout(() => controller.abort(), 10);
      await expect(sleepPromise).rejects.toThrow(OperationCancelledError);
    });

    it('aborts active sleep immediately when isCancelled returns true', async () => {
      let cancelled = false;
      const sleepPromise = abortableSleep(50, undefined, () => cancelled);

      setTimeout(() => {
        cancelled = true;
      }, 10);
      await expect(sleepPromise).rejects.toThrow(OperationCancelledError);
    });

    it('resolves immediately when sleep duration is zero or negative', async () => {
      await expect(abortableSleep(0)).resolves.toBeUndefined();
      await expect(abortableSleep(-10)).resolves.toBeUndefined();
    });

    it('delayMs resolves properly', async () => {
      await expect(delayMs(5)).resolves.toBeUndefined();
    });
  });
});
