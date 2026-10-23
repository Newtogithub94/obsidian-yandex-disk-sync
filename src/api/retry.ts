/**
 * src/api/retry.ts
 * High-resilience exponential backoff with jitter, Retry-After header parsing,
 * transient error detection, and cancellation support for Obsidian Yandex Disk Sync.
 */

import {
  RETRY_INITIAL_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_BACKOFF_FACTOR,
  RETRY_MAX_ATTEMPTS,
  RETRY_JITTER_RATIO,
  HTTP_STATUS_UNAUTHORIZED,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_RATE_LIMITED,
  HTTP_STATUS_SERVER_ERROR_MIN,
  HTTP_STATUS_SERVER_ERROR_MAX,
} from '../constants';
import { SyncError } from '../types';
import { RetryOptions, YandexApiError } from './yandex-types';

/**
 * Custom error thrown when a retry loop is aborted via cancellation token or AbortSignal.
 */
export class OperationCancelledError extends Error {
  constructor(message: string = 'Operation cancelled by user') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

/**
 * Case-insensitive header lookup helper with defensive object validation.
 */
export function getHeader(
  headers: Record<string, any> | undefined,
  name: string
): any | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

/**
 * Extracts and parses the `Retry-After` header value into milliseconds.
 * Supports delta-seconds (RFC 7231 / RFC 9110), HTTP-date, and ISO-8601 timestamps.
 * Safely handles non-string header values, negative numbers, and empty strings.
 */
export function parseRetryAfterHeader(headers?: Record<string, any>): number | undefined {
  const value = getHeader(headers, 'retry-after');
  if (value === undefined || value === null) return undefined;

  // Safely coerce value to string (handling numbers and single-element arrays)
  const rawStr = Array.isArray(value) ? String(value[0]) : String(value);
  const trimmed = rawStr.trim();
  if (!trimmed) return undefined;

  // 1. Delta-seconds format (RFC 7231 / RFC 9110: delay-seconds = 1*DIGIT)
  // Must consist strictly of non-negative integer digits
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }

  // Explicitly reject negative numbers, signed values, or decimal floats
  // to prevent V8 Date.parse from interpreting negative integers as BCE years.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }

  // 2. HTTP-Date (RFC 1123 / RFC 7231) or ISO-8601 timestamp
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.max(0, delta);
  }

  return undefined;
}

/**
 * Extracts HTTP status code from any error representation.
 */
export function extractHttpStatus(error: unknown): number | undefined {
  if (!error) return undefined;

  if (error instanceof YandexApiError) {
    return error.status;
  }

  const errObj = error as any;
  if (typeof errObj.status === 'number') {
    return errObj.status;
  }

  if (typeof errObj.statusCode === 'number') {
    return errObj.statusCode;
  }

  if (typeof errObj.response?.status === 'number') {
    return errObj.response.status;
  }

  // Regex fallback on error message
  if (typeof errObj.message === 'string') {
    const match =
      errObj.message.match(/HTTP\s*(\d{3})/i) ||
      errObj.message.match(/status code\s*(\d{3})/i);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }

  return undefined;
}

/**
 * Extracts `Retry-After` milliseconds from an error object if present.
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error) return undefined;

  const errObj = error as any;
  if (errObj.headers) {
    const parsed = parseRetryAfterHeader(errObj.headers);
    if (parsed !== undefined) return parsed;
  }

  if (errObj.response?.headers) {
    const parsed = parseRetryAfterHeader(errObj.response.headers);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

// Comprehensive pattern for transient network errors and timeouts across platforms
const TRANSIENT_NETWORK_PATTERN =
  /time(?:d\s*)?out|socket\s*hang\s*up|network\s*error|failed\s*to\s*fetch|net::ERR_|err_network|etimedout|econnreset|econnrefused|econnaborted|enotfound|eai_again|sockettimeoutexception/i;

/**
 * Determines whether an error is transient (temporary/retryable) or permanent.
 * Transient: HTTP 429, 500..599, network drops, timeouts.
 * Permanent: HTTP 401, 403, 404, 409, 400.
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof OperationCancelledError) return false;

  // 1. Check domain SyncError
  if (error instanceof SyncError) {
    if (
      error.code === 'RATE_LIMITED' ||
      error.code === 'NETWORK_TIMEOUT' ||
      error.code === 'REMOTE_SERVER_ERROR'
    ) {
      return true;
    }
    if (
      error.code === 'AUTH_REQUIRED' ||
      error.code === 'AUTH_INVALID' ||
      error.code === 'REMOTE_FORBIDDEN' ||
      error.code === 'REMOTE_NOT_FOUND' ||
      error.code === 'REMOTE_CONFLICT'
    ) {
      return false;
    }
    if (error.recoverable) return true;
  }

  // 2. Check HTTP status code
  const status = extractHttpStatus(error);
  if (status !== undefined) {
    if (status === 507) return false; // DiskStorageFullError: User quota exceeded
    if (status === HTTP_STATUS_RATE_LIMITED) return true;
    if (status >= HTTP_STATUS_SERVER_ERROR_MIN && status <= HTTP_STATUS_SERVER_ERROR_MAX) {
      return true;
    }

    // Explicit non-retryable statuses
    if (
      status === HTTP_STATUS_UNAUTHORIZED ||
      status === HTTP_STATUS_FORBIDDEN ||
      status === HTTP_STATUS_NOT_FOUND ||
      status === HTTP_STATUS_CONFLICT ||
      status === 400 ||
      status === 405 ||
      status === 413 ||
      status === 415 ||
      status === 422
    ) {
      return false;
    }
  }

  // 3. Check network error / timeout patterns
  const errObj = error as any;
  const msg =
    typeof errObj?.message === 'string'
      ? errObj.message
      : typeof error === 'string'
      ? error
      : '';
  const name = typeof errObj?.name === 'string' ? errObj.name : '';
  const code = typeof errObj?.code === 'string' ? errObj.code.toUpperCase() : '';

  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ERR_NETWORK' ||
    TRANSIENT_NETWORK_PATTERN.test(msg) ||
    TRANSIENT_NETWORK_PATTERN.test(code) ||
    (name === 'AbortError' && /time(?:d\s*)?out/i.test(msg))
  ) {
    return true;
  }

  return false;
}

/**
 * Computes the backoff delay in milliseconds for a given attempt with ±20% jitter.
 * Formula: min(initialDelayMs * backoffFactor^(attempt - 1), maxDelayMs) * (1 ± jitter)
 */
export function computeBackoffDelay(
  attempt: number,
  options?: Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'backoffFactor' | 'jitterRatio'>,
  randomFn: () => number = Math.random
): number {
  const initial = options?.initialDelayMs ?? RETRY_INITIAL_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const factor = options?.backoffFactor ?? RETRY_BACKOFF_FACTOR;
  const jitterRatio = options?.jitterRatio ?? RETRY_JITTER_RATIO;

  const validAttempt = Math.max(1, attempt);
  const baseDelay = Math.min(initial * Math.pow(factor, validAttempt - 1), maxDelay);

  // Jitter multiplier in range [1 - jitterRatio, 1 + jitterRatio]
  const jitterMultiplier = 1.0 + (randomFn() * 2.0 - 1.0) * jitterRatio;
  const calculated = Math.round(baseDelay * jitterMultiplier);

  return Math.max(0, calculated);
}

/**
 * Sleep for the specified duration with immediate cancellation support via
 * AbortSignal or isCancelled callback.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
  isCancelled?: () => boolean
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted || isCancelled?.()) {
      return reject(new OperationCancelledError());
    }

    if (ms <= 0) {
      return resolve();
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    onAbort = () => {
      cleanup();
      reject(new OperationCancelledError());
    };

    if (signal) {
      signal.addEventListener('abort', onAbort);
    }

    timer = setTimeout(() => {
      cleanup();
      if (isCancelled?.()) {
        reject(new OperationCancelledError());
      } else {
        resolve();
      }
    }, ms);
  });
}

/**
 * Delay utility helper.
 */
export async function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  return abortableSleep(ms, signal);
}

/**
 * Executes an asynchronous function with exponential backoff, jitter,
 * Retry-After header compliance, transient error filtering, and cancellation support.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const isRetryable = options?.isRetryable ?? isTransientError;
  const sleep = options?.sleepFn ?? abortableSleep;
  const maxDelayMs = options?.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  const clampRetryAfter = options?.clampRetryAfterToMax ?? true;

  let attempt = 1;

  while (true) {
    if (options?.signal?.aborted || options?.isCancelled?.()) {
      throw new OperationCancelledError();
    }

    try {
      return await fn(attempt);
    } catch (error) {
      if (options?.signal?.aborted || options?.isCancelled?.()) {
        throw new OperationCancelledError();
      }

      if (attempt >= maxAttempts) {
        throw error;
      }

      if (!isRetryable(error, attempt)) {
        throw error;
      }

      // Compute exponential backoff with jitter
      let delay = computeBackoffDelay(attempt, options, options?.randomFn);

      // Check Retry-After header
      const retryAfterMs = extractRetryAfterMs(error);
      if (retryAfterMs !== undefined && retryAfterMs > delay) {
        delay = clampRetryAfter ? Math.min(retryAfterMs, maxDelayMs) : retryAfterMs;
      }

      // Invoke optional notification hook
      options?.onRetry?.(error, attempt, delay);

      // Wait before next attempt
      await sleep(delay, options?.signal, options?.isCancelled);

      attempt++;
    }
  }
}

/**
 * Alias for withRetry to support alternative naming conventions.
 */
export const executeWithRetry = withRetry;
