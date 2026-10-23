/**
 * src/api/yandex-disk-client.ts
 * Production-grade Yandex Disk REST API client implementing IYandexDiskClient.
 * Pure Obsidian requestUrl — Zero Node.js desktop dependencies.
 */

import { requestUrl, RequestUrlResponse } from 'obsidian';
import {
  IYandexDiskClient,
  YandexDiskInfo,
  YandexResourceList,
  YandexResourceItem,
  SyncError,
} from '../types';
import {
  YANDEX_API_BASE_URL,
  YANDEX_RESOURCES_URL,
  YANDEX_UPLOAD_URL,
  YANDEX_DOWNLOAD_URL,
  YANDEX_APP_FOLDER_PREFIX,
  DEFAULT_NETWORK_TIMEOUT_MS,
  HTTP_STATUS_OK,
  HTTP_STATUS_CREATED,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_UNAUTHORIZED,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_RATE_LIMITED,
} from '../constants';
import {
  YandexClientOptions,
  YandexApiDiskResponse,
  YandexApiResourceResponse,
  YandexApiLinkResponse,
} from './yandex-types';
import { withRetry, OperationCancelledError } from './retry';

/**
 * Canonicalizes raw physical remote paths returned by Yandex Disk REST API
 * (e.g. "disk:/Приложения/AppName/folder/file" or "disk:/Applications/AppName/file")
 * into the unified virtual app folder namespace ("app:/folder/file").
 */
export function canonicalizeRemotePath(rawPath: string | undefined): string {
  if (!rawPath) return YANDEX_APP_FOLDER_PREFIX;
  const normalized = rawPath.replace(/\\/g, '/').normalize('NFC').trim();
  const replaced = normalized.replace(/^disk:\/(?:Приложения|Applications)\/[^/]+(?:\/|$)/i, 'app:/');
  return replaced.normalize('NFC');
}

export class YandexDiskClient implements IYandexDiskClient {
  private token: string;
  private options: YandexClientOptions;
  private knownDirectories: Set<string> = new Set([YANDEX_APP_FOLDER_PREFIX]);

  constructor(token: string, options?: Partial<YandexClientOptions>) {
    this.token = token.trim();
    this.options = {
      token: this.token,
      timeoutMs: options?.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
      maxRetries: options?.maxRetries,
      initialDelayMs: options?.initialDelayMs,
      maxDelayMs: options?.maxDelayMs,
      backoffFactor: options?.backoffFactor,
      jitterRatio: options?.jitterRatio,
    };
  }

  public setToken(token: string): void {
    this.token = token.trim();
    this.options.token = this.token;
  }

  public clearDirectoryCache(): void {
    this.knownDirectories.clear();
    this.knownDirectories.add(YANDEX_APP_FOLDER_PREFIX);
  }

  /**
   * Sanitizes and normalizes path strictly within app:/ sandbox.
   * Defends against directory traversal and external disk paths.
   */
  public sanitizePath(remotePath: string): string {
    if (!remotePath) return YANDEX_APP_FOLDER_PREFIX;

    let normalized = remotePath.normalize('NFC').trim();
    if (!normalized) return YANDEX_APP_FOLDER_PREFIX;

    // Multi-step decoding: decode percent-encoded sequences (e.g. %252e%252e or %252f)
    for (let i = 0; i < 3; i++) {
      try {
        const decoded = decodeURIComponent(normalized);
        if (decoded === normalized) break;
        normalized = decoded;
      } catch {
        throw new SyncError(
          `Security violation: Malformed URI encoding in path: '${remotePath}'`,
          'REMOTE_FORBIDDEN',
          { path: remotePath }
        );
      }
    }

    normalized = normalized.replace(/\\/g, '/');

    if (/^disk:\//i.test(normalized) || /^disk:/i.test(normalized)) {
      throw new SyncError(
        `Security violation: Access outside sandboxed app:/ directory is forbidden: '${remotePath}'`,
        'REMOTE_FORBIDDEN',
        { path: remotePath }
      );
    }

    if (normalized.startsWith(YANDEX_APP_FOLDER_PREFIX)) {
      normalized = normalized.substring(YANDEX_APP_FOLDER_PREFIX.length);
    } else if (normalized.startsWith('app:')) {
      normalized = normalized.substring('app:'.length);
    }

    const segments = normalized.split('/');
    const stack: string[] = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed || trimmed === '.') continue;
      if (trimmed === '..') {
        if (stack.length === 0) {
          throw new SyncError(
            `Security violation: Path traversal outside app:/ sandbox: '${remotePath}'`,
            'REMOTE_FORBIDDEN',
            { path: remotePath }
          );
        }
        stack.pop();
      } else {
        stack.push(trimmed);
      }
    }

    if (stack.length === 0) {
      return YANDEX_APP_FOLDER_PREFIX;
    }

    return `${YANDEX_APP_FOLDER_PREFIX}${stack.join('/')}`;
  }

  /**
   * Executes an authorized HTTP request with exponential backoff and error mapping.
   */
  private async request(
    url: string,
    method: string = 'GET',
    body?: string | ArrayBuffer,
    extraHeaders?: Record<string, string>
  ): Promise<RequestUrlResponse> {
    if (!this.token) {
      throw new SyncError('Yandex OAuth access token is not configured.', 'AUTH_REQUIRED');
    }

    const headers: Record<string, string> = {
      Authorization: `OAuth ${this.token}`,
      Accept: 'application/json',
      ...extraHeaders,
    };

    return withRetry(
      async () => {
        let response: RequestUrlResponse;
        try {
          response = await requestUrl({
            url,
            method,
            headers,
            body,
            throw: false,
          });
        } catch (netErr: any) {
          if (netErr instanceof OperationCancelledError) throw netErr;
          if (netErr instanceof SyncError) throw netErr;
          throw new SyncError(
            `Network error connecting to Yandex Disk: ${netErr?.message || netErr}`,
            'NETWORK_TIMEOUT',
            { originalError: netErr }
          );
        }

        if (response.status === HTTP_STATUS_RATE_LIMITED) {
          const err: any = new SyncError('Yandex Disk rate limit exceeded', 'RATE_LIMITED');
          err.status = 429;
          err.headers = response.headers;
          throw err;
        }

        if (response.status === 507) {
          throw new SyncError(
            'User cloud storage quota exceeded (HTTP 507)',
            'REMOTE_FORBIDDEN'
          );
        }

        if (response.status >= 500 && response.status <= 599) {
          const err: any = new SyncError(
            `Yandex Disk server error (HTTP ${response.status})`,
            'REMOTE_SERVER_ERROR'
          );
          err.status = response.status;
          err.headers = response.headers;
          throw err;
        }

        return response;
      },
      {
        maxAttempts: this.options.maxRetries,
        initialDelayMs: this.options.initialDelayMs,
        maxDelayMs: this.options.maxDelayMs,
        backoffFactor: this.options.backoffFactor,
        jitterRatio: this.options.jitterRatio,
      }
    );
  }

  /**
   * Tests connectivity, validates OAuth token, and retrieves storage quota.
   */
  public async testConnection(): Promise<YandexDiskInfo> {
    const url = `${YANDEX_API_BASE_URL}`;
    const response = await this.request(url, 'GET');

    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
      throw new SyncError('Invalid or expired Yandex OAuth token.', 'AUTH_INVALID');
    }
    if (response.status === HTTP_STATUS_FORBIDDEN) {
      throw new SyncError('Insufficient permissions for Yandex Disk app folder.', 'REMOTE_FORBIDDEN');
    }
    if (response.status !== HTTP_STATUS_OK) {
      throw new SyncError(
        `Failed to connect to Yandex Disk (HTTP ${response.status})`,
        'REMOTE_SERVER_ERROR'
      );
    }

    const data: YandexApiDiskResponse =
      typeof response.json === 'object' && response.json !== null
        ? response.json
        : response.text
        ? JSON.parse(response.text)
        : {};

    return {
      user: {
        login: data.user?.login ?? 'unknown',
        uid: String(data.user?.uid ?? ''),
        display_name: data.user?.display_name,
      },
      total_space: data.total_space ?? 0,
      used_space: data.used_space ?? 0,
      trash_size: data.trash_size ?? 0,
    };
  }

  /**
   * Lists contents of a remote directory with complete pagination support.
   */
  public async listDirectory(remotePath: string): Promise<YandexResourceList> {
    const sanitized = this.sanitizePath(remotePath);
    const allItems: YandexResourceItem[] = [];
    let offset = 0;
    const limit = 1000;
    let total = 0;

    while (true) {
      const url = `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent(sanitized)}&limit=${limit}&offset=${offset}`;
      const response = await this.request(url, 'GET');

      if (response.status === HTTP_STATUS_NOT_FOUND) {
        throw new SyncError(`Directory not found: '${sanitized}'`, 'REMOTE_NOT_FOUND', { path: sanitized });
      }
      if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        throw new SyncError('Invalid or expired OAuth token.', 'AUTH_INVALID');
      }
      if (response.status === HTTP_STATUS_FORBIDDEN) {
        throw new SyncError(`Access forbidden: '${sanitized}'`, 'REMOTE_FORBIDDEN', { path: sanitized });
      }
      if (response.status !== HTTP_STATUS_OK) {
        throw new SyncError(
          `Failed to list directory '${sanitized}' (HTTP ${response.status})`,
          'REMOTE_SERVER_ERROR',
          { path: sanitized }
        );
      }

      const res: YandexApiResourceResponse =
        typeof response.json === 'object' && response.json !== null
          ? response.json
          : response.text
          ? JSON.parse(response.text)
          : {};

      if (!res || !res._embedded) {
        // Target is a single file or empty resource without _embedded
        break;
      }

      total = res._embedded.total ?? 0;
      const items = res._embedded.items ?? [];
      for (const item of items) {
        allItems.push({
          name: item.name ? item.name.normalize('NFC') : item.name,
          path: canonicalizeRemotePath(item.path),
          type: item.type,
          size: item.size,
          sha256: item.sha256,
          md5: item.md5,
          etag: item.etag,
          modified: item.modified,
          created: item.created,
          mime_type: item.mime_type,
        });
      }

      offset += items.length;
      if (offset >= total || items.length === 0) {
        break;
      }
    }

    return {
      path: sanitized,
      items: allItems,
      limit,
      offset: 0,
      total: allItems.length,
    };
  }

  /**
   * Recursively traverses all subdirectories and returns flattened inventory.
   */
  public async listDirectoryRecursive(remotePath: string): Promise<YandexResourceItem[]> {
    const root = this.sanitizePath(remotePath);
    const results: YandexResourceItem[] = [];
    const queue: string[] = [root];

    while (queue.length > 0) {
      const currentDir = queue.shift()!;
      const list = await this.listDirectory(currentDir);

      for (const item of list.items) {
        results.push(item);
        if (item.type === 'dir') {
          queue.push(item.path);
        }
      }
    }

    return results;
  }

  /**
   * Ensures remote folder hierarchy exists level-by-level before uploads.
   * Handles idempotency (HTTP 201 Created and HTTP 409 Conflict are treated as successes).
   */
  public async ensureDirectory(remotePath: string): Promise<void> {
    const sanitized = this.sanitizePath(remotePath);
    if (sanitized === YANDEX_APP_FOLDER_PREFIX) {
      return;
    }

    const relative = sanitized.substring(YANDEX_APP_FOLDER_PREFIX.length);
    const segments = relative.split('/');
    let current = YANDEX_APP_FOLDER_PREFIX;

    for (const segment of segments) {
      if (!segment) continue;
      current = current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`;

      if (this.knownDirectories.has(current)) {
        continue;
      }

      const url = `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent(current)}`;
      const response = await this.request(url, 'PUT');

      if (response.status === HTTP_STATUS_CREATED || response.status === HTTP_STATUS_CONFLICT) {
        // 201 = Created, 409 = Exists already (idempotent success)
        this.knownDirectories.add(current);
      } else if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        throw new SyncError('Invalid or expired OAuth token.', 'AUTH_INVALID');
      } else if (response.status === HTTP_STATUS_FORBIDDEN) {
        throw new SyncError(`Access forbidden: '${current}'`, 'REMOTE_FORBIDDEN', { path: current });
      } else {
        throw new SyncError(
          `Failed to create directory '${current}' (HTTP ${response.status})`,
          'REMOTE_SERVER_ERROR',
          { path: current }
        );
      }
    }
  }

  /**
   * Two-Step Upload:
   * 1. Ensure parent folder exists.
   * 2. GET /v1/disk/resources/upload -> obtain signed href.
   * 3. PUT binary ArrayBuffer to href.
   */
  public async uploadFile(
    remotePath: string,
    content: ArrayBuffer,
    overwrite: boolean = true
  ): Promise<void> {
    const sanitized = this.sanitizePath(remotePath);

    // Ensure parent directory exists before requesting upload URL
    const lastSlash = sanitized.lastIndexOf('/');
    if (lastSlash > YANDEX_APP_FOLDER_PREFIX.length - 1) {
      const parentDir = sanitized.substring(0, lastSlash);
      await this.ensureDirectory(parentDir);
    }

    // Step 1: Obtain upload URL
    const uploadUrlEndpoint = `${YANDEX_UPLOAD_URL}?path=${encodeURIComponent(
      sanitized
    )}&overwrite=${overwrite}`;
    const linkResponse = await this.request(uploadUrlEndpoint, 'GET');

    if (linkResponse.status === HTTP_STATUS_CONFLICT) {
      throw new SyncError(
        `Resource already exists and overwrite is false: '${sanitized}'`,
        'REMOTE_CONFLICT',
        { path: sanitized }
      );
    }
    if (linkResponse.status === HTTP_STATUS_UNAUTHORIZED) {
      throw new SyncError('Invalid or expired OAuth token.', 'AUTH_INVALID');
    }
    if (linkResponse.status === HTTP_STATUS_FORBIDDEN) {
      throw new SyncError(
        `Upload forbidden: disk quota exceeded or permission denied for '${sanitized}'`,
        'REMOTE_FORBIDDEN',
        { path: sanitized }
      );
    }
    if (linkResponse.status === 507) {
      throw new SyncError(
        `Upload rejected: cloud storage quota exceeded for '${sanitized}'`,
        'REMOTE_FORBIDDEN',
        { path: sanitized }
      );
    }
    if (linkResponse.status !== HTTP_STATUS_OK) {
      throw new SyncError(
        `Failed to obtain upload link for '${sanitized}' (HTTP ${linkResponse.status})`,
        'REMOTE_SERVER_ERROR',
        { path: sanitized }
      );
    }

    const linkData: YandexApiLinkResponse =
      typeof linkResponse.json === 'object' && linkResponse.json !== null
        ? linkResponse.json
        : linkResponse.text
        ? JSON.parse(linkResponse.text)
        : {};

    if (!linkData.href) {
      throw new SyncError('Yandex Disk did not provide an upload href.', 'REMOTE_SERVER_ERROR', {
        path: sanitized,
      });
    }

    // Step 2: PUT binary ArrayBuffer to upload target href
    await withRetry(
      async () => {
        let putResponse: RequestUrlResponse;
        try {
          putResponse = await requestUrl({
            url: linkData.href,
            method: 'PUT',
            body: content,
            headers: {
              'Content-Type': 'application/octet-stream',
            },
            throw: false,
          });
        } catch (putErr: any) {
          if (putErr instanceof OperationCancelledError) throw putErr;
          if (putErr instanceof SyncError) throw putErr;
          throw new SyncError(
            `Network error during file upload to storage: ${putErr?.message || putErr}`,
            'NETWORK_TIMEOUT',
            { path: sanitized, originalError: putErr }
          );
        }

        if (putResponse.status === HTTP_STATUS_RATE_LIMITED) {
          const err: any = new SyncError('Rate limit exceeded during upload', 'RATE_LIMITED', {
            path: sanitized,
          });
          err.status = 429;
          err.headers = putResponse.headers;
          throw err;
        }

        if (putResponse.status === 507) {
          throw new SyncError(
            `Upload rejected: storage quota exceeded (HTTP 507)`,
            'REMOTE_FORBIDDEN',
            { path: sanitized }
          );
        }

        if (putResponse.status >= 500 && putResponse.status <= 599) {
          const err: any = new SyncError(
            `Storage server error during upload (HTTP ${putResponse.status})`,
            'REMOTE_SERVER_ERROR',
            { path: sanitized }
          );
          err.status = putResponse.status;
          err.headers = putResponse.headers;
          throw err;
        }

        if (
          putResponse.status !== HTTP_STATUS_CREATED &&
          putResponse.status !== HTTP_STATUS_OK &&
          putResponse.status !== 202
        ) {
          throw new SyncError(
            `Upload payload rejected by storage server (HTTP ${putResponse.status})`,
            'REMOTE_SERVER_ERROR',
            { path: sanitized }
          );
        }
      },
      {
        maxAttempts: this.options.maxRetries,
        initialDelayMs: this.options.initialDelayMs,
        maxDelayMs: this.options.maxDelayMs,
        backoffFactor: this.options.backoffFactor,
        jitterRatio: this.options.jitterRatio,
      }
    );
  }

  /**
   * Two-Step Download:
   * 1. GET /v1/disk/resources/download -> obtain signed href.
   * 2. GET href -> receive ArrayBuffer binary response.
   */
  public async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    const sanitized = this.sanitizePath(remotePath);

    // Step 1: Obtain download URL
    const downloadUrlEndpoint = `${YANDEX_DOWNLOAD_URL}?path=${encodeURIComponent(sanitized)}`;
    const linkResponse = await this.request(downloadUrlEndpoint, 'GET');

    if (linkResponse.status === HTTP_STATUS_NOT_FOUND) {
      throw new SyncError(`File not found: '${sanitized}'`, 'REMOTE_NOT_FOUND', { path: sanitized });
    }
    if (linkResponse.status === HTTP_STATUS_UNAUTHORIZED) {
      throw new SyncError('Invalid or expired OAuth token.', 'AUTH_INVALID');
    }
    if (linkResponse.status === HTTP_STATUS_FORBIDDEN) {
      throw new SyncError(`Access forbidden: '${sanitized}'`, 'REMOTE_FORBIDDEN', { path: sanitized });
    }
    if (linkResponse.status !== HTTP_STATUS_OK) {
      throw new SyncError(
        `Failed to obtain download link for '${sanitized}' (HTTP ${linkResponse.status})`,
        'REMOTE_SERVER_ERROR',
        { path: sanitized }
      );
    }

    const linkData: YandexApiLinkResponse =
      typeof linkResponse.json === 'object' && linkResponse.json !== null
        ? linkResponse.json
        : linkResponse.text
        ? JSON.parse(linkResponse.text)
        : {};

    if (!linkData.href) {
      throw new SyncError('Yandex Disk did not provide a download href.', 'REMOTE_SERVER_ERROR', {
        path: sanitized,
      });
    }

    // Step 2: GET binary data from storage href
    return withRetry(
      async () => {
        let getResponse: RequestUrlResponse;
        try {
          getResponse = await requestUrl({
            url: linkData.href,
            method: 'GET',
            throw: false,
          });
        } catch (getErr: any) {
          if (getErr instanceof OperationCancelledError) throw getErr;
          if (getErr instanceof SyncError) throw getErr;
          throw new SyncError(
            `Network error during file download from storage: ${getErr?.message || getErr}`,
            'NETWORK_TIMEOUT',
            { path: sanitized, originalError: getErr }
          );
        }

        if (getResponse.status === HTTP_STATUS_RATE_LIMITED) {
          const err: any = new SyncError('Rate limit exceeded during download', 'RATE_LIMITED', {
            path: sanitized,
          });
          err.status = 429;
          err.headers = getResponse.headers;
          throw err;
        }

        if (getResponse.status >= 500 && getResponse.status <= 599) {
          const err: any = new SyncError(
            `Storage server error during download (HTTP ${getResponse.status})`,
            'REMOTE_SERVER_ERROR',
            { path: sanitized }
          );
          err.status = getResponse.status;
          err.headers = getResponse.headers;
          throw err;
        }

        if (getResponse.status === HTTP_STATUS_NOT_FOUND) {
          throw new SyncError(`File not found: '${sanitized}'`, 'REMOTE_NOT_FOUND', { path: sanitized });
        }

        if (getResponse.status !== HTTP_STATUS_OK) {
          throw new SyncError(
            `Download failed from storage server (HTTP ${getResponse.status})`,
            'REMOTE_SERVER_ERROR',
            { path: sanitized }
          );
        }

        return getResponse.arrayBuffer;
      },
      {
        maxAttempts: this.options.maxRetries,
        initialDelayMs: this.options.initialDelayMs,
        maxDelayMs: this.options.maxDelayMs,
        backoffFactor: this.options.backoffFactor,
        jitterRatio: this.options.jitterRatio,
      }
    );
  }

  /**
   * Deletes a remote resource permanently (file or directory).
   * Idempotent: HTTP 404 is treated as successful deletion.
   */
  public async deleteResource(remotePath: string, permanently: boolean = true): Promise<void> {
    const sanitized = this.sanitizePath(remotePath);
    if (sanitized === YANDEX_APP_FOLDER_PREFIX) {
      throw new SyncError('Cannot delete the root application folder.', 'REMOTE_FORBIDDEN', {
        path: sanitized,
      });
    }

    const url = `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent(sanitized)}&permanently=${permanently}`;
    const response = await this.request(url, 'DELETE');

    if (
      response.status === HTTP_STATUS_NO_CONTENT ||
      response.status === 202 ||
      response.status === HTTP_STATUS_NOT_FOUND
    ) {
      // 204 = Deleted, 202 = Accepted async, 404 = Already absent
      this.knownDirectories.forEach((dir) => {
        if (dir === sanitized || dir.startsWith(`${sanitized}/`)) {
          this.knownDirectories.delete(dir);
        }
      });
      return;
    }

    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
      throw new SyncError('Invalid or expired OAuth token.', 'AUTH_INVALID');
    }
    if (response.status === HTTP_STATUS_FORBIDDEN) {
      throw new SyncError(`Access forbidden: '${sanitized}'`, 'REMOTE_FORBIDDEN', { path: sanitized });
    }

    throw new SyncError(
      `Failed to delete resource '${sanitized}' (HTTP ${response.status})`,
      'REMOTE_SERVER_ERROR',
      { path: sanitized }
    );
  }
}
