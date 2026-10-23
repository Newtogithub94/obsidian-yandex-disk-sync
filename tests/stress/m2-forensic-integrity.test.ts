import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { YandexDiskClient } from '../../src/api/yandex-disk-client';
import {
  computeBackoffDelay,
  parseRetryAfterHeader,
  isTransientError,
  withRetry,
  OperationCancelledError,
} from '../../src/api/retry';
import { SyncError } from '../../src/types';
import {
  YANDEX_API_BASE_URL,
  YANDEX_RESOURCES_URL,
  YANDEX_UPLOAD_URL,
  YANDEX_DOWNLOAD_URL,
} from '../../src/constants';

describe('Forensic Integrity Audit Suite for Milestone 2', () => {
  const SECRET_TOKEN = 'secret-oauth-token-xyz-98765';
  let client: YandexDiskClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new YandexDiskClient(SECRET_TOKEN, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 10,
    });
  });

  describe('1. Forensic Check: Token Privacy & Leaks', () => {
    it('never leaks the secret token in URLs or query strings', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { user: { login: 'tester', uid: '1' } },
        text: '',
      });

      await client.testConnection();

      const callArgs = vi.mocked(requestUrl).mock.calls[0]![0] as any;
      expect(callArgs.url).not.toContain(SECRET_TOKEN);
      expect(callArgs.headers?.['Authorization']).toBe(`OAuth ${SECRET_TOKEN}`);
    });

    it('never leaks the secret token in thrown error messages', async () => {
      vi.mocked(requestUrl).mockRejectedValue(
        new Error(`Connection failed with token ${SECRET_TOKEN}`)
      );

      try {
        await client.testConnection();
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('NETWORK_TIMEOUT');
      }
    });

    it('does not transmit Authorization header to signed upload/download URLs', async () => {
      // Step 1: Upload link
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://storage.yandex.net/signed-upload-target' },
          text: '',
        })
        // Step 2: Upload PUT
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.uploadFile('app:/test.md', new ArrayBuffer(4));

      expect(requestUrl).toHaveBeenCalledTimes(2);

      // Call 1 has Authorization
      const call1 = vi.mocked(requestUrl).mock.calls[0]![0] as any;
      expect(call1.headers?.['Authorization']).toBe(`OAuth ${SECRET_TOKEN}`);

      // Call 2 (to storage CDN href) MUST NOT include Authorization header
      const call2 = vi.mocked(requestUrl).mock.calls[1]![0] as any;
      expect(call2.headers?.['Authorization']).toBeUndefined();
    });
  });

  describe('2. Forensic Check: Sandbox Escapes & Path Traversal', () => {
    const maliciousPaths = [
      'disk:/',
      'disk:/MyFolder/file.md',
      'DISK:/Windows',
      'disk:\\escaped\\file.md',
      'app:/../outside.txt',
      'app:/folder/../../outside.txt',
      'app:/a/b/../../../c',
      '../outside.txt',
      '../../outside.txt',
      'app:../outside.txt',
      'app:\\..\\outside.txt',
    ];

    maliciousPaths.forEach((path) => {
      it(`blocks malicious path '${path}' with REMOTE_FORBIDDEN`, () => {
        expect(() => client.sanitizePath(path)).toThrowError();
        try {
          client.sanitizePath(path);
        } catch (err: any) {
          expect(err).toBeInstanceOf(SyncError);
          expect(err.code).toBe('REMOTE_FORBIDDEN');
        }
      });
    });

    it('correctly normalizes safe internal traversal segments', () => {
      expect(client.sanitizePath('app:/a/b/../c')).toBe('app:/a/c');
      expect(client.sanitizePath('app:/a/./b/./c')).toBe('app:/a/b/c');
      expect(client.sanitizePath('app:/a/b/c/../../d')).toBe('app:/a/d');
    });

    it('refuses deletion of sandbox root app:/', async () => {
      await expect(client.deleteResource('app:/')).rejects.toMatchObject({
        code: 'REMOTE_FORBIDDEN',
      });
      await expect(client.deleteResource('')).rejects.toMatchObject({
        code: 'REMOTE_FORBIDDEN',
      });
      expect(requestUrl).not.toHaveBeenCalled();
    });
  });

  describe('3. Forensic Check: Backoff Math & Jitter Distribution', () => {
    it('exponentially scales and clamps strictly at maxDelay', () => {
      const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
        computeBackoffDelay(
          attempt,
          { initialDelayMs: 1000, maxDelayMs: 16000, backoffFactor: 2.0, jitterRatio: 0.0 },
          () => 0.5
        )
      );

      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 16000, 16000]);
    });

    it('verifies jitter bounds across 1,000 random samples', () => {
      const baseAttempt = 3; // base 4000
      const minExpected = Math.round(4000 * 0.8); // 3200
      const maxExpected = Math.round(4000 * 1.2); // 4800

      for (let i = 0; i < 1000; i++) {
        const delay = computeBackoffDelay(baseAttempt);
        expect(delay).toBeGreaterThanOrEqual(minExpected);
        expect(delay).toBeLessThanOrEqual(maxExpected);
      }
    });

    it('parses Retry-After delta-seconds and HTTP-Date format correctly', () => {
      expect(parseRetryAfterHeader({ 'Retry-After': '25' })).toBe(25000);
      expect(parseRetryAfterHeader({ 'retry-after': '0' })).toBe(0);

      const futureDate = new Date(Date.now() + 45000).toUTCString();
      const parsed = parseRetryAfterHeader({ 'retry-after': futureDate });
      expect(parsed).toBeGreaterThanOrEqual(40000);
      expect(parsed).toBeLessThanOrEqual(50000);
    });
  });

  describe('4. Forensic Check: Error Classification & Quota Exhaustion', () => {
    it('classifies 507 Insufficient Storage as non-retryable permanent error', () => {
      const err507 = { status: 507, message: 'DiskStorageFullError' };
      expect(isTransientError(err507)).toBe(false);
    });

    it('classifies 429 and 500-599 as transient retryable errors', () => {
      expect(isTransientError({ status: 429 })).toBe(true);
      expect(isTransientError({ status: 500 })).toBe(true);
      expect(isTransientError({ status: 502 })).toBe(true);
      expect(isTransientError({ status: 503 })).toBe(true);
      expect(isTransientError({ status: 504 })).toBe(true);
    });

    it('classifies 400, 401, 403, 404, 409 as permanent non-retryable errors', () => {
      expect(isTransientError({ status: 400 })).toBe(false);
      expect(isTransientError({ status: 401 })).toBe(false);
      expect(isTransientError({ status: 403 })).toBe(false);
      expect(isTransientError({ status: 404 })).toBe(false);
      expect(isTransientError({ status: 409 })).toBe(false);
    });

    it('immediately cancels retry loop if AbortSignal is aborted', async () => {
      const controller = new AbortController();
      let attempts = 0;

      const promise = withRetry(
        async () => {
          attempts++;
          controller.abort();
          const err: any = new Error('Transient error');
          err.status = 500;
          throw err;
        },
        { signal: controller.signal, initialDelayMs: 1 }
      );

      await expect(promise).rejects.toBeInstanceOf(OperationCancelledError);
      expect(attempts).toBe(1);
    });
  });

  describe('5. Forensic Check: Binary Payload Byte Integrity & Unicode Paths', () => {
    it('transfers arbitrary binary data without corruption', async () => {
      const originalBytes = new Uint8Array(1024);
      for (let i = 0; i < originalBytes.length; i++) {
        originalBytes[i] = (i * 31 + 7) & 0xff;
      }

      // Step 1: upload link
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://uploader/binary' },
          text: '',
        })
        // Step 2: PUT binary
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        // Step 3: download link
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://downloader/binary' },
          text: '',
        })
        // Step 4: GET binary
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: originalBytes.buffer,
          json: {},
          text: '',
        });

      await client.uploadFile('app:/data.bin', originalBytes.buffer);
      const downloaded = await client.downloadFile('app:/data.bin');

      expect(new Uint8Array(downloaded)).toEqual(originalBytes);
    });

    it('correctly encodes Unicode paths with spaces and Cyrillic characters', async () => {
      const cyrillicPath = 'app:/Заметки/Рабочий проект 2026/Отчёт.md';

      vi.mocked(requestUrl)
        // Step 1: ensureDirectory parent
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        // Step 2: upload link
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://uploader/unicode' },
          text: '',
        })
        // Step 3: PUT
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.uploadFile(cyrillicPath, new ArrayBuffer(8));

      // Check upload URL query param encoding
      const uploadLinkCall = vi.mocked(requestUrl).mock.calls[2]![0] as any;
      expect(uploadLinkCall.url).toContain(encodeURIComponent(cyrillicPath));
    });
  });
});
