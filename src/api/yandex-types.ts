/**
 * src/api/yandex-types.ts
 * Wire DTOs, response schemas, client options, and error models
 * for the official Yandex Disk REST API.
 */

export interface YandexApiUser {
  login: string;
  uid: string;
  display_name?: string;
  country?: string;
}

export interface YandexApiDiskResponse {
  trash_size: number;
  total_space: number;
  used_space: number;
  system_folders?: Record<string, string>;
  user?: YandexApiUser;
  unlimited_autoupload_enabled?: boolean;
  revision?: number;
}

export interface YandexApiItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  sha256?: string;
  md5?: string;
  etag?: string;
  modified?: string; // ISO 8601
  created?: string;  // ISO 8601
  mime_type?: string;
  revision?: number;
  resource_id?: string;
}

export interface YandexApiEmbeddedList {
  sort?: string;
  path: string;
  items: YandexApiItem[];
  limit: number;
  offset: number;
  total: number;
}

export interface YandexApiResourceResponse {
  name: string;
  path: string;
  type: 'file' | 'dir';
  created?: string;
  modified?: string;
  size?: number;
  mime_type?: string;
  _embedded?: YandexApiEmbeddedList;
  revision?: number;
  resource_id?: string;
}

export interface YandexApiLinkResponse {
  href: string;
  method: string;
  templated?: boolean;
  operation_id?: string;
}

export interface YandexApiErrorResponse {
  message?: string;
  description?: string;
  error?: string; // e.g. "TooManyRequests", "DiskLimitExceeded", "DiskResourceAlreadyExistsError", "DiskPathDoesntExistsError", "UnauthorizedError", "AccessDeniedError"
}

export class YandexApiError extends Error {
  readonly status: number;
  readonly errorDetails?: YandexApiErrorResponse;
  readonly headers?: Record<string, string>;
  readonly url?: string;
  readonly method?: string;

  constructor(
    message: string,
    status: number,
    options?: {
      errorDetails?: YandexApiErrorResponse;
      headers?: Record<string, string>;
      url?: string;
      method?: string;
    }
  ) {
    super(message);
    this.name = 'YandexApiError';
    this.status = status;
    this.errorDetails = options?.errorDetails;
    this.headers = options?.headers;
    this.url = options?.url;
    this.method = options?.method;
  }
}

export interface YandexClientOptions {
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
}

export interface RetryOptions {
  /** Maximum number of execution attempts. Defaults to RETRY_MAX_ATTEMPTS (5). */
  maxAttempts?: number;

  /** Initial delay in milliseconds. Defaults to RETRY_INITIAL_DELAY_MS (1000). */
  initialDelayMs?: number;

  /** Maximum delay cap in milliseconds. Defaults to RETRY_MAX_DELAY_MS (30000). */
  maxDelayMs?: number;

  /** Multiplier applied per attempt. Defaults to RETRY_BACKOFF_FACTOR (2.0). */
  backoffFactor?: number;

  /** Jitter ratio (e.g. 0.2 = ±20%). Defaults to RETRY_JITTER_RATIO (0.2). */
  jitterRatio?: number;

  /** Whether to clamp Retry-After header values to maxDelayMs. Defaults to true. */
  clampRetryAfterToMax?: boolean;

  /** Custom predicate to determine whether an error is transient. Defaults to isTransientError. */
  isRetryable?: (error: unknown, attempt: number) => boolean;

  /** Web standard AbortSignal for aborting retry cycles. */
  signal?: AbortSignal;

  /** Callback predicate indicating if the operation was cancelled. */
  isCancelled?: () => boolean;

  /** Hook invoked before sleeping prior to a retry attempt. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;

  /** Custom random generator for deterministic testing. Defaults to Math.random. */
  randomFn?: () => number;

  /** Custom sleep implementation for fast-forward testing. Defaults to abortableSleep. */
  sleepFn?: (ms: number, signal?: AbortSignal, isCancelled?: () => boolean) => Promise<void>;
}
