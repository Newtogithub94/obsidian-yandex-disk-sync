/**
 * tests/stress/m2-retry-stress.test.ts
 * Milestone 2 Adversarial Stress Test Suite for Network Resilience & Retry Engine.
 * 
 * Verifies:
 * 1. 1,000 randomized iterations of backoff delay and jitter bounds across attempts 1..10.
 * 2. Exhaustive Retry-After header edge cases (delta-seconds, HTTP-Date, past dates, malformed values).
 * 3. Immediate cancellation & AbortSignal non-blocking sleep interruption.
 * 4. Strict transient vs permanent error classification and immediate rejection on non-retryable errors.
 * 5. Empirical defect detection and boundary stress documentation.
 */

import { describe, it, expect, vi } from 'vitest';
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
import { SyncError } from '../../src/types';
import {
  RETRY_INITIAL_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_BACKOFF_FACTOR,
  RETRY_JITTER_RATIO,
} from '../../src/constants';

describe('M2 Adversarial Stress Suite: Network Resilience & Retry Engine', () => {
  // =========================================================================
  // 1. Jitter Bounds & Backoff Mathematics Stress (1,000 Iterations)
  // =========================================================================
  describe('1. Jitter Bounds & Backoff Mathematics Stress (1,000 Iterations)', () => {
    it('verifies 1,000 randomized iterations across attempts 1..10 strictly respect ±20% jitter bounds', () => {
      const iterationsPerAttempt = 100; // 10 attempts * 100 = 1,000 total randomized iterations
      let totalIterationsChecked = 0;

      for (let attempt = 1; attempt <= 10; attempt++) {
        // Base delay formula: min(initial * factor^(attempt - 1), maxDelayMs)
        const expectedBaseDelay = Math.min(
          RETRY_INITIAL_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1),
          RETRY_MAX_DELAY_MS
        );

        // Theoretical bounds with ±20% jitter
        const expectedMin = Math.round(expectedBaseDelay * (1 - RETRY_JITTER_RATIO)); // 0.8
        const expectedMax = Math.round(expectedBaseDelay * (1 + RETRY_JITTER_RATIO)); // 1.2

        // Base delay never exceeds maxDelayMs (30,000ms)
        expect(expectedBaseDelay).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);

        for (let iter = 0; iter < iterationsPerAttempt; iter++) {
          const delay = computeBackoffDelay(attempt);
          totalIterationsChecked++;

          // Every computed delay must strictly lie within [0.8 * D_base, 1.2 * D_base]
          expect(delay).toBeGreaterThanOrEqual(expectedMin);
          expect(delay).toBeLessThanOrEqual(expectedMax);

          // Delay must be non-negative integer
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(0);

          // Base delay is clamped to 30,000ms; with +20% jitter, delay can reach at most 36,000ms
          expect(delay).toBeLessThanOrEqual(Math.round(RETRY_MAX_DELAY_MS * 1.2));
        }
      }

      expect(totalIterationsChecked).toBe(1000);
    });

    it('verifies 1,000 randomized iterations on attempt 6+ (maxDelay clamping threshold) exhibit expected statistical spread', () => {
      const delays: number[] = [];
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const delay = computeBackoffDelay(6);
        delays.push(delay);

        // Clamped base delay is 30,000ms, bounds are [24,000ms, 36,000ms]
        expect(delay).toBeGreaterThanOrEqual(24000);
        expect(delay).toBeLessThanOrEqual(36000);
      }

      // Check statistical distribution
      const minObserved = Math.min(...delays);
      const maxObserved = Math.max(...delays);
      const sum = delays.reduce((acc, v) => acc + v, 0);
      const mean = sum / iterations;

      // With 1,000 uniform random samples, min should be very close to 24,000 and max to 36,000
      expect(minObserved).toBeLessThan(25000);
      expect(maxObserved).toBeGreaterThan(35000);
      // Mean should be within ±2% of nominal 30,000ms
      expect(mean).toBeGreaterThan(29400);
      expect(mean).toBeLessThan(30600);
    });

    it('adversarially tests extreme random generator return values (0.0, 0.5, 1.0)', () => {
      // Min jitter (randomFn = 0.0 -> multiplier = 0.8)
      expect(computeBackoffDelay(1, {}, () => 0.0)).toBe(800);
      expect(computeBackoffDelay(2, {}, () => 0.0)).toBe(1600);
      expect(computeBackoffDelay(3, {}, () => 0.0)).toBe(3200);
      expect(computeBackoffDelay(4, {}, () => 0.0)).toBe(6400);
      expect(computeBackoffDelay(5, {}, () => 0.0)).toBe(12800);
      expect(computeBackoffDelay(6, {}, () => 0.0)).toBe(24000);
      expect(computeBackoffDelay(10, {}, () => 0.0)).toBe(24000);

      // Max jitter (randomFn = 1.0 -> multiplier = 1.2)
      expect(computeBackoffDelay(1, {}, () => 1.0)).toBe(1200);
      expect(computeBackoffDelay(2, {}, () => 1.0)).toBe(2400);
      expect(computeBackoffDelay(3, {}, () => 1.0)).toBe(4800);
      expect(computeBackoffDelay(4, {}, () => 1.0)).toBe(9600);
      expect(computeBackoffDelay(5, {}, () => 1.0)).toBe(19200);
      expect(computeBackoffDelay(6, {}, () => 1.0)).toBe(36000);
      expect(computeBackoffDelay(10, {}, () => 1.0)).toBe(36000);

      // Neutral jitter (randomFn = 0.5 -> multiplier = 1.0)
      expect(computeBackoffDelay(1, {}, () => 0.5)).toBe(1000);
      expect(computeBackoffDelay(2, {}, () => 0.5)).toBe(2000);
      expect(computeBackoffDelay(3, {}, () => 0.5)).toBe(4000);
      expect(computeBackoffDelay(4, {}, () => 0.5)).toBe(8000);
      expect(computeBackoffDelay(5, {}, () => 0.5)).toBe(16000);
      expect(computeBackoffDelay(6, {}, () => 0.5)).toBe(30000);
      expect(computeBackoffDelay(10, {}, () => 0.5)).toBe(30000);
    });

    it('handles negative, zero, and extreme attempt indices without NaN or negative delay', () => {
      // Non-positive attempts must clamp to attempt 1
      expect(computeBackoffDelay(0, {}, () => 0.5)).toBe(1000);
      expect(computeBackoffDelay(-1, {}, () => 0.5)).toBe(1000);
      expect(computeBackoffDelay(-999, {}, () => 0.5)).toBe(1000);

      // Huge attempt values must clamp gracefully at maxDelayMs
      expect(computeBackoffDelay(100, {}, () => 0.5)).toBe(30000);
      expect(computeBackoffDelay(1000, {}, () => 0.5)).toBe(30000);
    });

    it('honors custom backoff options across 1,000 iterations', () => {
      const customOptions = {
        initialDelayMs: 200,
        maxDelayMs: 2500,
        backoffFactor: 3.0,
        jitterRatio: 0.1, // ±10%
      };

      for (let iter = 0; iter < 1000; iter++) {
        // Attempt 1: 200 * 3^0 = 200. ±10% -> [180, 220]
        const delay1 = computeBackoffDelay(1, customOptions);
        expect(delay1).toBeGreaterThanOrEqual(180);
        expect(delay1).toBeLessThanOrEqual(220);

        // Attempt 2: 200 * 3^1 = 600. ±10% -> [540, 660]
        const delay2 = computeBackoffDelay(2, customOptions);
        expect(delay2).toBeGreaterThanOrEqual(540);
        expect(delay2).toBeLessThanOrEqual(660);

        // Attempt 4: 200 * 3^3 = 5400 -> clamped to 2500. ±10% -> [2250, 2750]
        const delay4 = computeBackoffDelay(4, customOptions);
        expect(delay4).toBeGreaterThanOrEqual(2250);
        expect(delay4).toBeLessThanOrEqual(2750);
      }
    });
  });

  // =========================================================================
  // 2. Retry-After Header Edge Cases Stress
  // =========================================================================
  describe('2. Retry-After Header Edge Cases Stress', () => {
    it('parses valid delta-seconds formats', () => {
      expect(parseRetryAfterHeader({ 'retry-after': '120' })).toBe(120000);
      expect(parseRetryAfterHeader({ 'retry-after': '0' })).toBe(0);
      expect(parseRetryAfterHeader({ 'retry-after': '  42  ' })).toBe(42000);
      expect(parseRetryAfterHeader({ 'retry-after': '1' })).toBe(1000);
    });

    it('gracefully handles missing or malformed non-numeric values without throwing', () => {
      expect(parseRetryAfterHeader({ 'retry-after': 'invalid' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': '' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': '    ' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': 'NaN' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': 'null' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': 'undefined' })).toBeUndefined();
      expect(parseRetryAfterHeader(undefined)).toBeUndefined();
      expect(parseRetryAfterHeader({})).toBeUndefined();
    });

    it('rejects negative delta-seconds returning undefined per RFC 7231 / RFC 9110', () => {
      expect(parseRetryAfterHeader({ 'retry-after': '-5' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': '-100' })).toBeUndefined();
    });

    it('handles non-string header values safely without throwing TypeError', () => {
      expect(parseRetryAfterHeader({ 'retry-after': 30 as any })).toBe(30000);
      expect(parseRetryAfterHeader({ 'retry-after': 0 as any })).toBe(0);
      expect(parseRetryAfterHeader({ 'retry-after': -5 as any })).toBeUndefined();
    });

    it('parses valid RFC 1123 / RFC 7231 HTTP-Date strings', () => {
      const now = Date.now();
      const futureDate = new Date(now + 90000); // 90 seconds in future
      const httpDateStr = futureDate.toUTCString(); // e.g. "Wed, 21 Oct 2026 21:00:00 GMT"

      const parsed = parseRetryAfterHeader({ 'retry-after': httpDateStr });
      expect(parsed).toBeDefined();
      expect(parsed!).toBeGreaterThanOrEqual(85000);
      expect(parsed!).toBeLessThanOrEqual(92000);
    });

    it('returns 0 for past HTTP-Date values instead of negative or crashing', () => {
      const pastDate = new Date(Date.now() - 60000).toUTCString(); // 1 minute in the past
      const parsedPast = parseRetryAfterHeader({ 'retry-after': pastDate });
      expect(parsedPast).toBe(0);

      const ancientDate = new Date('1994-11-06T08:49:37Z').toUTCString();
      const parsedAncient = parseRetryAfterHeader({ 'retry-after': ancientDate });
      expect(parsedAncient).toBe(0);
    });

    it('returns undefined for malformed date strings', () => {
      expect(parseRetryAfterHeader({ 'retry-after': 'Wed, 99 Foo 2026 99:99:99 GMT' })).toBeUndefined();
      expect(parseRetryAfterHeader({ 'retry-after': 'Not a date string at all' })).toBeUndefined();
    });

    it('handles diverse header casing and object nesting in extractRetryAfterMs', () => {
      expect(extractRetryAfterMs({ headers: { 'retry-after': '25' } })).toBe(25000);
      expect(extractRetryAfterMs({ headers: { 'Retry-After': '30' } })).toBe(30000);
      expect(extractRetryAfterMs({ headers: { 'RETRY-AFTER': '35' } })).toBe(35000);
      expect(extractRetryAfterMs({ headers: { 'rEtRy-AfTeR': '40' } })).toBe(40000);
      expect(extractRetryAfterMs({ response: { headers: { 'retry-after': '50' } } })).toBe(50000);

      // Edge payloads
      expect(extractRetryAfterMs(null)).toBeUndefined();
      expect(extractRetryAfterMs(undefined)).toBeUndefined();
      expect(extractRetryAfterMs({})).toBeUndefined();
      expect(extractRetryAfterMs(new Error('no headers'))).toBeUndefined();
      expect(extractRetryAfterMs('string error')).toBeUndefined();
      expect(extractRetryAfterMs(12345)).toBeUndefined();
    });

    it('verifies withRetry falls back gracefully to computed backoff on invalid or past Retry-After headers', async () => {
      const invalidHeaders = [
        'invalid',
        '-5', // returns 0ms, but 0 <= 1000 so falls back to 1000ms
        '',
        '   ',
        'Wed, 99 Foo 2026',
        new Date(Date.now() - 100000).toUTCString(), // past date -> 0ms <= 1000ms
      ];

      for (const headerVal of invalidHeaders) {
        let attempts = 0;
        const sleepDelays: number[] = [];

        const fn = vi.fn().mockImplementation(async () => {
          attempts++;
          if (attempts === 1) {
            const err: any = new Error('Rate limit');
            err.status = 429;
            err.headers = { 'retry-after': headerVal };
            throw err;
          }
          return 'ok';
        });

        const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
          sleepDelays.push(ms);
        });

        const result = await withRetry(fn, {
          sleepFn: mockSleep,
          randomFn: () => 0.5, // Base delay for attempt 1 = 1,000ms
        });

        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(sleepDelays.length).toBe(1);
        // If Retry-After is invalid or past, it MUST fallback to computed backoff (1000ms)
        expect(sleepDelays[0]).toBe(1000);
      }
    });

    it('verifies withRetry respects valid future Retry-After and clamps to maxDelayMs', async () => {
      // 1. Unclamped when retry-after <= maxDelayMs
      let attempts1 = 0;
      const sleepDelays1: number[] = [];
      const fn1 = vi.fn().mockImplementation(async () => {
        attempts1++;
        if (attempts1 === 1) {
          const err: any = new Error('Rate limit');
          err.status = 429;
          err.headers = { 'retry-after': '15' }; // 15,000ms > 1,000ms
          throw err;
        }
        return 'success1';
      });

      await withRetry(fn1, {
        sleepFn: async (ms) => { sleepDelays1.push(ms); },
        randomFn: () => 0.5,
      });
      expect(sleepDelays1[0]).toBe(15000);

      // 2. Clamped when retry-after > maxDelayMs
      let attempts2 = 0;
      const sleepDelays2: number[] = [];
      const fn2 = vi.fn().mockImplementation(async () => {
        attempts2++;
        if (attempts2 === 1) {
          const err: any = new Error('Rate limit');
          err.status = 429;
          err.headers = { 'retry-after': '120' }; // 120,000ms > 30,000ms
          throw err;
        }
        return 'success2';
      });

      await withRetry(fn2, {
        sleepFn: async (ms) => { sleepDelays2.push(ms); },
        maxDelayMs: 30000,
        clampRetryAfterToMax: true,
      });
      expect(sleepDelays2[0]).toBe(30000);
    });
  });

  // =========================================================================
  // 3. Cancellation & Abort Signal Stress
  // =========================================================================
  describe('3. Cancellation & Abort Signal Stress', () => {
    it('aborts active sleep immediately when AbortSignal triggers without waiting for timer', async () => {
      const controller = new AbortController();
      const startTime = Date.now();

      // Schedule a 10-second sleep, but abort after 15ms
      const sleepPromise = abortableSleep(10000, controller.signal);
      setTimeout(() => controller.abort(), 15);

      await expect(sleepPromise).rejects.toThrow(OperationCancelledError);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(1000); // Exited immediately, did NOT hang for 10s
    });

    it('rejects immediately without starting sleep if AbortSignal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const startTime = Date.now();
      await expect(abortableSleep(5000, controller.signal)).rejects.toThrow(
        OperationCancelledError
      );
      expect(Date.now() - startTime).toBeLessThan(50);
    });

    it('rejects immediately without calling function when AbortSignal is pre-aborted in withRetry', async () => {
      const controller = new AbortController();
      controller.abort();

      const fn = vi.fn().mockResolvedValue('value');
      await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(
        OperationCancelledError
      );
      expect(fn).not.toHaveBeenCalled();
    });

    it('cleans up abort event listeners from signal to prevent memory leaks', async () => {
      const controller = new AbortController();
      
      const addSpy = vi.spyOn(controller.signal, 'addEventListener');
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

      await abortableSleep(10, controller.signal);

      expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('aborts retry loop cleanly when isCancelled callback returns true', async () => {
      // 1. Pre-cancelled
      const fn1 = vi.fn().mockResolvedValue('ok');
      await expect(withRetry(fn1, { isCancelled: () => true })).rejects.toThrow(
        OperationCancelledError
      );
      expect(fn1).not.toHaveBeenCalled();

      // 2. Cancelled mid-flight after attempt 1 failure
      let cancelled = false;
      let callCount = 0;
      const fn2 = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          cancelled = true; // User clicked Cancel in UI during operation
          throw { status: 500 };
        }
        return 'should-not-reach';
      });

      await expect(
        withRetry(fn2, {
          isCancelled: () => cancelled,
          sleepFn: async () => {},
        })
      ).rejects.toThrow(OperationCancelledError);

      expect(callCount).toBe(1);
    });
  });

  // =========================================================================
  // 4. Transient vs Permanent Error Classification Stress
  // =========================================================================
  describe('4. Transient vs Permanent Error Classification Stress', () => {
    it('adversarially stress tests that HTTP 429, 500, 502, 503, 504 and network errors trigger retry', async () => {
      const transientErrors = [
        // HTTP 429 Rate Limiting
        { status: 429 },
        { statusCode: 429 },
        { response: { status: 429 } },
        new YandexApiError('Too Many Requests', 429),
        new SyncError('Rate limited', 'RATE_LIMITED'),
        new Error('Request failed with HTTP 429'),

        // HTTP 5xx Server Errors
        { status: 500 },
        { status: 502 },
        { status: 503 },
        { status: 504 },
        { status: 520 }, // Cloudflare unknown error
        { status: 524 }, // Cloudflare timeout
        { status: 599 }, // Server boundary
        new YandexApiError('Internal Server Error', 500),
        new YandexApiError('Bad Gateway', 502),
        new YandexApiError('Service Unavailable', 503),
        new YandexApiError('Gateway Timeout', 504),
        new SyncError('Remote server error', 'REMOTE_SERVER_ERROR'),
        new Error('HTTP 500 Internal Server Error'),
        new Error('status code 503'),

        // Network Drops and Timeouts with recognised patterns
        { code: 'ETIMEDOUT', message: 'Connection timed out' },
        { code: 'ECONNRESET', message: 'Connection reset by peer' },
        { code: 'ECONNREFUSED', message: 'Connection refused' },
        { code: 'ENOTFOUND', message: 'DNS resolution failed' },
        new Error('TypeError: Failed to fetch'),
        new Error('net::ERR_INTERNET_DISCONNECTED'),
        new Error('net::ERR_CONNECTION_TIMED_OUT'),
        new Error('net::ERR_NETWORK_CHANGED'),
        new Error('Request timeout during fetch'),
        new SyncError('Network timeout occurred', 'NETWORK_TIMEOUT'),
        { name: 'AbortError', message: 'The user aborted a request due to timeout' },
      ];

      for (const err of transientErrors) {
        // Step 1: Assert isTransientError classifies as true
        const desc = err instanceof Error ? `${err.name}: ${err.message}` : JSON.stringify(err);
        expect(isTransientError(err), `Expected transient for: ${desc}`).toBe(true);

        // Step 2: Assert withRetry attempts retry
        let attempts = 0;
        const fn = vi.fn().mockImplementation(async () => {
          attempts++;
          if (attempts === 1) {
            throw err;
          }
          return 'recovered';
        });

        const fastSleep = vi.fn().mockResolvedValue(undefined);
        const result = await withRetry(fn, { sleepFn: fastSleep });

        expect(result).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fastSleep).toHaveBeenCalledTimes(1);
      }
    });

    it('classifies "timed out" and "socket hang up" error messages as transient', () => {
      const obsidianTimeoutError = new Error('requestUrl: Request timed out');
      const connectionTimedOutError = new Error('Connection timed out');
      const socketHangUpError = new Error('socket hang up');

      expect(isTransientError(obsidianTimeoutError)).toBe(true);
      expect(isTransientError(connectionTimedOutError)).toBe(true);
      expect(isTransientError(socketHangUpError)).toBe(true);
    });

    it('adversarially asserts that 400, 401, 403, 404, 409, 507 FAIL IMMEDIATELY without retrying', async () => {
      const permanentErrors = [
        // HTTP 400 Bad Request
        { status: 400, desc: 'HTTP 400 Bad Request' },
        new YandexApiError('Bad Request', 400),
        new Error('HTTP 400 Bad Request'),

        // HTTP 401 Unauthorized
        { status: 401, desc: 'HTTP 401 Unauthorized' },
        new YandexApiError('Unauthorized', 401),
        new SyncError('Auth required', 'AUTH_REQUIRED'),
        new SyncError('Auth invalid', 'AUTH_INVALID'),
        new Error('HTTP 401 Unauthorized'),

        // HTTP 403 Forbidden
        { status: 403, desc: 'HTTP 403 Forbidden' },
        new YandexApiError('Forbidden', 403),
        new SyncError('Remote forbidden', 'REMOTE_FORBIDDEN'),
        new Error('HTTP 403 Forbidden'),

        // HTTP 404 Not Found
        { status: 404, desc: 'HTTP 404 Not Found' },
        new YandexApiError('Not Found', 404),
        new SyncError('Remote not found', 'REMOTE_NOT_FOUND'),
        new Error('HTTP 404 Not Found'),

        // HTTP 409 Conflict
        { status: 409, desc: 'HTTP 409 Conflict' },
        new YandexApiError('Conflict', 409),
        new SyncError('Remote conflict', 'REMOTE_CONFLICT'),
        new Error('HTTP 409 Conflict'),

        // HTTP 507 Storage Quota Full (Must NEVER retry!)
        { status: 507, desc: 'HTTP 507 Insufficient Storage' },
        new YandexApiError('DiskStorageFullError', 507),
        new Error('HTTP 507 Insufficient Storage'),

        // Other permanent client errors
        { status: 405, desc: 'Method Not Allowed' },
        { status: 413, desc: 'Payload Too Large' },
        { status: 415, desc: 'Unsupported Media Type' },
        { status: 422, desc: 'Unprocessable Entity' },
      ];

      for (const err of permanentErrors) {
        // Step 1: Assert isTransientError classifies as false
        expect(isTransientError(err)).toBe(false);

        // Step 2: Assert withRetry FAILS IMMEDIATELY (exactly 1 call, zero sleeps)
        const fn = vi.fn().mockRejectedValue(err);
        const fastSleep = vi.fn();

        await expect(withRetry(fn, { sleepFn: fastSleep })).rejects.toEqual(err);

        // Verification: Exactly 1 invocation, 0 retries, 0 sleep calls
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fastSleep).not.toHaveBeenCalled();
      }
    });

    it('correctly handles non-error and unexpected types in extractHttpStatus', () => {
      expect(extractHttpStatus(null)).toBeUndefined();
      expect(extractHttpStatus(undefined)).toBeUndefined();
      expect(extractHttpStatus(true)).toBeUndefined();
      expect(extractHttpStatus(123)).toBeUndefined();
      expect(extractHttpStatus('some random string')).toBeUndefined();
      expect(extractHttpStatus({})).toBeUndefined();
      expect(extractHttpStatus({ message: 'random error with no status' })).toBeUndefined();
    });
  });
});
