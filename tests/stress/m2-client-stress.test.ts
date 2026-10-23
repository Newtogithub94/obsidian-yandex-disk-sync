/**
 * tests/stress/m2-client-stress.test.ts
 * Milestone 2 Adversarial Stress Suite:
 * - Path traversal and sandbox escape attacks (app:/../, disk:/, %2F encoded, Windows backslashes)
 * - Special characters and Unicode resilience (Cyrillic, Latvian, Emoji, Symbols, deep nesting)
 * - Binary data integrity (0-byte, null bytes 0x00..0xFF, multi-megabyte payloads)
 * - Concurrency and idempotency stress (concurrent ensureDirectory, idempotent deleteResource)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { YandexDiskClient } from '../../src/api/yandex-disk-client';
import { SyncError } from '../../src/types';
import {
  YANDEX_API_BASE_URL,
  YANDEX_RESOURCES_URL,
  YANDEX_UPLOAD_URL,
  YANDEX_DOWNLOAD_URL,
  YANDEX_APP_FOLDER_PREFIX,
} from '../../src/constants';

describe('Milestone 2 Adversarial Stress & Sandbox Security Suite', () => {
  const mockToken = 'mock-adversarial-token-xyz';
  let client: YandexDiskClient;

  // In-memory simulated storage for mock REST router
  let mockRemoteFiles: Map<string, { data: Uint8Array; sha256: string; modified: string }>;
  let mockRemoteDirs: Set<string>;
  let requestLog: RequestUrlParam[];

  async function sha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
    const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const hashBuf = await crypto.subtle.digest('SHA-256', uint8.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoteFiles = new Map();
    mockRemoteDirs = new Set([YANDEX_APP_FOLDER_PREFIX]);
    requestLog = [];

    client = new YandexDiskClient(mockToken, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 5,
    });

    // Setup intelligent in-memory Yandex Disk REST router for requestUrl
    vi.mocked(requestUrl).mockImplementation((async (param: RequestUrlParam | string): Promise<any> => {
      const req: RequestUrlParam = typeof param === 'string' ? { url: param } : param;
      requestLog.push(req);

      const urlObj = new URL(req.url);
      const pathname = urlObj.pathname;
      const searchParams = urlObj.searchParams;
      const method = (req.method || 'GET').toUpperCase();

      // 1. GET /v1/disk/ -> testConnection
      if (pathname === '/v1/disk/' || pathname === '/v1/disk') {
        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            user: { login: 'adversarial-tester', uid: '99999999' },
            total_space: 50 * 1024 * 1024 * 1024,
            used_space: 1024 * 1024,
            trash_size: 0,
          },
          text: '',
        };
      }

      // 2. /v1/disk/resources
      if (pathname === '/v1/disk/resources') {
        const rawPath = searchParams.get('path') || '';

        // PUT -> ensureDirectory
        if (method === 'PUT') {
          if (mockRemoteDirs.has(rawPath)) {
            return {
              status: 409,
              headers: {},
              arrayBuffer: new ArrayBuffer(0),
              json: { error: 'DiskResourceAlreadyExistsError' },
              text: '',
            };
          }
          mockRemoteDirs.add(rawPath);
          return {
            status: 201,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { href: req.url, method: 'GET' },
            text: '',
          };
        }

        // GET -> listDirectory
        if (method === 'GET') {
          if (!mockRemoteDirs.has(rawPath) && !mockRemoteFiles.has(rawPath)) {
            return {
              status: 404,
              headers: {},
              arrayBuffer: new ArrayBuffer(0),
              json: { error: 'DiskNotFoundError', message: 'Resource not found' },
              text: '',
            };
          }

          const prefix = rawPath.endsWith('/') ? rawPath : `${rawPath}/`;
          const items: any[] = [];
          const directSubdirs = new Set<string>();

          for (const [filePath, entry] of mockRemoteFiles.entries()) {
            if (filePath.startsWith(prefix)) {
              const sub = filePath.substring(prefix.length);
              const slashIdx = sub.indexOf('/');
              if (slashIdx === -1) {
                items.push({
                  name: sub,
                  path: filePath,
                  type: 'file',
                  size: entry.data.byteLength,
                  sha256: entry.sha256,
                  md5: entry.sha256.substring(0, 32),
                  modified: entry.modified,
                });
              } else {
                directSubdirs.add(prefix + sub.substring(0, slashIdx));
              }
            }
          }

          for (const dirPath of mockRemoteDirs) {
            if (dirPath !== rawPath && dirPath.startsWith(prefix)) {
              const sub = dirPath.substring(prefix.length);
              const slashIdx = sub.indexOf('/');
              if (slashIdx === -1) {
                directSubdirs.add(dirPath);
              } else {
                directSubdirs.add(prefix + sub.substring(0, slashIdx));
              }
            }
          }

          for (const dir of directSubdirs) {
            const name = dir.substring(dir.lastIndexOf('/') + 1);
            items.push({
              name,
              path: dir,
              type: 'dir',
            });
          }

          return {
            status: 200,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: {
              name: rawPath.substring(rawPath.lastIndexOf('/') + 1),
              path: rawPath,
              type: 'dir',
              _embedded: {
                path: rawPath,
                total: items.length,
                limit: 1000,
                offset: 0,
                items,
              },
            },
            text: '',
          };
        }

        // DELETE -> deleteResource
        if (method === 'DELETE') {
          const hadFile = mockRemoteFiles.delete(rawPath);
          const hadDir = mockRemoteDirs.delete(rawPath);
          const prefix = `${rawPath}/`;
          for (const key of Array.from(mockRemoteFiles.keys())) {
            if (key.startsWith(prefix)) mockRemoteFiles.delete(key);
          }
          for (const key of Array.from(mockRemoteDirs)) {
            if (key.startsWith(prefix)) mockRemoteDirs.delete(key);
          }

          if (hadFile || hadDir) {
            return {
              status: 204,
              headers: {},
              arrayBuffer: new ArrayBuffer(0),
              json: {},
              text: '',
            };
          } else {
            // Already absent
            return {
              status: 404,
              headers: {},
              arrayBuffer: new ArrayBuffer(0),
              json: { error: 'DiskNotFoundError' },
              text: '',
            };
          }
        }
      }

      // 3. /v1/disk/resources/upload -> Step 1 upload
      if (pathname === '/v1/disk/resources/upload') {
        const rawPath = searchParams.get('path') || '';
        const overwrite = searchParams.get('overwrite') === 'true';

        if (!overwrite && mockRemoteFiles.has(rawPath)) {
          return {
            status: 409,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { error: 'DiskResourceAlreadyExistsError' },
            text: '',
          };
        }

        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            href: `https://uploader.mock/upload?target=${encodeURIComponent(rawPath)}`,
            method: 'PUT',
          },
          text: '',
        };
      }

      // 4. Target upload endpoint (uploader.mock) -> Step 2 upload
      if (urlObj.hostname === 'uploader.mock') {
        const targetPath = searchParams.get('target') || '';
        const bodyBuf = req.body instanceof ArrayBuffer
          ? req.body
          : typeof req.body === 'string'
          ? new TextEncoder().encode(req.body).buffer
          : new ArrayBuffer(0);
        const uint8 = new Uint8Array(bodyBuf.slice(0));

        const hash = await sha256Hex(uint8);
        mockRemoteFiles.set(targetPath, {
          data: uint8,
          sha256: hash,
          modified: new Date().toISOString(),
        });

        return {
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        };
      }

      // 5. /v1/disk/resources/download -> Step 1 download
      if (pathname === '/v1/disk/resources/download') {
        const rawPath = searchParams.get('path') || '';
        if (!mockRemoteFiles.has(rawPath)) {
          return {
            status: 404,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { error: 'DiskNotFoundError' },
            text: '',
          };
        }

        return {
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            href: `https://downloader.mock/download?target=${encodeURIComponent(rawPath)}`,
            method: 'GET',
          },
          text: '',
        };
      }

      // 6. Target download endpoint (downloader.mock) -> Step 2 download
      if (urlObj.hostname === 'downloader.mock') {
        const targetPath = searchParams.get('target') || '';
        const entry = mockRemoteFiles.get(targetPath);
        if (!entry) {
          return {
            status: 404,
            headers: {},
            arrayBuffer: new ArrayBuffer(0),
            json: { error: 'DiskNotFoundError' },
            text: '',
          };
        }

        const copy = new Uint8Array(entry.data.byteLength);
        copy.set(entry.data);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
          arrayBuffer: copy.buffer,
          json: {},
          text: '',
        };
      }

      // Default fallback
      return {
        status: 400,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: 'BadRequest' },
        text: '',
      };
    }) as any);
  });

  // =========================================================================
  // Dimension 1: Path Traversal & Sandbox Escape Attacks
  // =========================================================================
  describe('Dimension 1: Path Traversal & Sandbox Escape Attacks', () => {
    const maliciousPaths = [
      'app:/../outside.md',
      'app:/sub/../../outside.md',
      'disk:/secret.md',
      'disk:/app/test.md',
      'app:/..%2F..%2Foutside.md',
      'app:\\foo\\..\\..\\bar',
      'disk:\\secret.md',
      'DISK:/passwords.txt',
      'app:/%2e%2e/%2e%2e/escaped.md',
      'app:/%2E%2E/%2E%2E/escaped.md',
      'app:/..%5c..%5cescaped.md',
      'app:/..%5C..%5Cescaped.md',
      'app:/%2e%2e%2foutside.md',
      'app:/sub/dir/../../../escaped.md',
      'app:/%252e%252e/%252e%252e/escaped.md',
    ];

    it.each(maliciousPaths)(
      'rejects traversal path %s in sanitizePath with SyncError(REMOTE_FORBIDDEN)',
      (maliciousPath) => {
        expect(() => client.sanitizePath(maliciousPath)).toThrow(SyncError);
        try {
          client.sanitizePath(maliciousPath);
        } catch (err: any) {
          expect(err.code).toBe('REMOTE_FORBIDDEN');
        }
      }
    );

    it.each(maliciousPaths)(
      'rejects %s on uploadFile without dispatching any network requests',
      async (maliciousPath) => {
        const dummy = new ArrayBuffer(8);
        await expect(client.uploadFile(maliciousPath, dummy)).rejects.toMatchObject({
          code: 'REMOTE_FORBIDDEN',
        });
        expect(requestLog).toHaveLength(0);
      }
    );

    it.each(maliciousPaths)(
      'rejects %s on downloadFile without dispatching any network requests',
      async (maliciousPath) => {
        await expect(client.downloadFile(maliciousPath)).rejects.toMatchObject({
          code: 'REMOTE_FORBIDDEN',
        });
        expect(requestLog).toHaveLength(0);
      }
    );

    it.each(maliciousPaths)(
      'rejects %s on listDirectory without dispatching any network requests',
      async (maliciousPath) => {
        await expect(client.listDirectory(maliciousPath)).rejects.toMatchObject({
          code: 'REMOTE_FORBIDDEN',
        });
        expect(requestLog).toHaveLength(0);
      }
    );

    it.each(maliciousPaths)(
      'rejects %s on deleteResource without dispatching any network requests',
      async (maliciousPath) => {
        await expect(client.deleteResource(maliciousPath)).rejects.toMatchObject({
          code: 'REMOTE_FORBIDDEN',
        });
        expect(requestLog).toHaveLength(0);
      }
    );

    it.each(maliciousPaths)(
      'rejects %s on ensureDirectory without dispatching any network requests',
      async (maliciousPath) => {
        await expect(client.ensureDirectory(maliciousPath)).rejects.toMatchObject({
          code: 'REMOTE_FORBIDDEN',
        });
        expect(requestLog).toHaveLength(0);
      }
    );

    it('refuses to delete root application folder app:/ without network call', async () => {
      await expect(client.deleteResource('app:/')).rejects.toMatchObject({
        code: 'REMOTE_FORBIDDEN',
      });
      expect(requestLog).toHaveLength(0);
    });
  });

  // =========================================================================
  // Dimension 2: Special Characters & Unicode Stress
  // =========================================================================
  describe('Dimension 2: Special Characters & Unicode Stress', () => {
    const unicodeTestCases = [
      { name: 'Spaces & Subdirs', path: 'app:/My Vault/Daily Notes/2026-10-21 Work Note.md' },
      { name: 'Russian Cyrillic', path: 'app:/Заметки/Проект Синхронизации/тестовый файл.md' },
      { name: 'Latvian Diacritics', path: 'app:/Valoda/Mācību materiāli (āēīūšģķļņž)/Ievads.md' },
      { name: 'Emoji Filenames', path: 'app:/📁 Vault/📝 Ideas/🔥 Top Priority.md' },
      { name: 'Punctuation & Symbols', path: 'app:/Symbols/Report [v1.0] (Draft) + #tag = $100 & more.md' },
      {
        name: 'Deep Hierarchy (12 levels)',
        path: 'app:/L1/L2/L3/L4/L5/L6/L7/L8/L9/L10/L11/L12/deep-leaf.md',
      },
    ];

    it.each(unicodeTestCases)(
      'correctly uploads, lists, downloads, and deletes: $name',
      async ({ path }) => {
        const payloadText = `# Content for ${path} — ${Date.now()}`;
        const payloadBuffer = new TextEncoder().encode(payloadText).buffer;

        // 1. Upload
        await client.uploadFile(path, payloadBuffer);

        // 2. Download and verify fidelity
        const downloaded = await client.downloadFile(path);
        const downloadedText = new TextDecoder().decode(downloaded);
        expect(downloadedText).toBe(payloadText);

        // 3. List parent directory and verify entry exists
        const lastSlash = path.lastIndexOf('/');
        const parentDir = path.substring(0, lastSlash);
        const fileName = path.substring(lastSlash + 1);

        const listing = await client.listDirectory(parentDir);
        const found = listing.items.find((item) => item.name === fileName);
        expect(found).toBeDefined();
        expect(found?.type).toBe('file');
        expect(found?.size).toBe(payloadBuffer.byteLength);

        // 4. Delete resource
        await client.deleteResource(path);

        // 5. Verify download fails with REMOTE_NOT_FOUND after deletion
        await expect(client.downloadFile(path)).rejects.toMatchObject({
          code: 'REMOTE_NOT_FOUND',
        });
      }
    );
  });

  // =========================================================================
  // Dimension 3: Binary Data Integrity & Edge Payloads
  // =========================================================================
  describe('Dimension 3: Binary Data Integrity & Edge Payloads', () => {
    it('uploads and downloads 0-byte blank buffer with byte-for-byte fidelity', async () => {
      const emptyBuffer = new ArrayBuffer(0);
      const filePath = 'app:/Binary/zero-byte.bin';

      await client.uploadFile(filePath, emptyBuffer);

      const downloaded = await client.downloadFile(filePath);
      expect(downloaded.byteLength).toBe(0);

      const hashOriginal = await sha256Hex(emptyBuffer);
      const hashDownloaded = await sha256Hex(downloaded);
      expect(hashDownloaded).toBe(hashOriginal);
      expect(hashDownloaded).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('uploads and downloads binary buffer containing null bytes (0x00) and full 0..255 byte spectrum', async () => {
      // 1024 bytes containing 4 repetitions of the 0..255 spectrum, with many null bytes
      const testArray = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) {
        testArray[i] = i % 256;
      }
      const testBuffer = testArray.buffer;
      const filePath = 'app:/Binary/spectrum.dat';

      await client.uploadFile(filePath, testBuffer);

      const downloaded = await client.downloadFile(filePath);
      expect(downloaded.byteLength).toBe(1024);

      const originalHash = await sha256Hex(testBuffer);
      const downloadedHash = await sha256Hex(downloaded);
      expect(downloadedHash).toBe(originalHash);

      const downloadedView = new Uint8Array(downloaded);
      for (let i = 0; i < 1024; i++) {
        expect(downloadedView[i]).toBe(i % 256);
      }
    });

    it('uploads and downloads multi-megabyte (2 MB) binary payload without truncation or corruption', async () => {
      const twoMegabytes = 2 * 1024 * 1024;
      const largeArray = new Uint8Array(twoMegabytes);

      // Fill with deterministic pseudo-random sequence
      let seed = 42;
      for (let i = 0; i < twoMegabytes; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        largeArray[i] = seed & 0xff;
      }
      const largeBuffer = largeArray.buffer;
      const filePath = 'app:/Binary/large-payload.bin';

      const originalSha = await sha256Hex(largeBuffer);

      await client.uploadFile(filePath, largeBuffer);

      const downloaded = await client.downloadFile(filePath);
      expect(downloaded.byteLength).toBe(twoMegabytes);

      const downloadedSha = await sha256Hex(downloaded);
      expect(downloadedSha).toBe(originalSha);

      // Spot check boundaries and interior
      const downloadedView = new Uint8Array(downloaded);
      expect(downloadedView[0]).toBe(largeArray[0]);
      expect(downloadedView[1024]).toBe(largeArray[1024]);
      expect(downloadedView[1024 * 1024]).toBe(largeArray[1024 * 1024]);
      expect(downloadedView[twoMegabytes - 1]).toBe(largeArray[twoMegabytes - 1]);
    });
  });

  // =========================================================================
  // Dimension 4: Concurrency & Idempotency Stress
  // =========================================================================
  describe('Dimension 4: Concurrency & Idempotency Stress', () => {
    it('handles 20 concurrent ensureDirectory calls on the same deep path without error or race condition', async () => {
      const targetPath = 'app:/Concurrent/Level1/Level2/Level3/Level4';

      // Launch 20 concurrent calls
      const promises = Array.from({ length: 20 }).map(() =>
        client.ensureDirectory(targetPath)
      );

      await expect(Promise.all(promises)).resolves.not.toThrow();

      // Verify that all parent levels exist in the mock storage
      expect(mockRemoteDirs.has('app:/Concurrent')).toBe(true);
      expect(mockRemoteDirs.has('app:/Concurrent/Level1')).toBe(true);
      expect(mockRemoteDirs.has('app:/Concurrent/Level1/Level2')).toBe(true);
      expect(mockRemoteDirs.has('app:/Concurrent/Level1/Level2/Level3')).toBe(true);
      expect(mockRemoteDirs.has('app:/Concurrent/Level1/Level2/Level3/Level4')).toBe(true);
    });

    it('idempotently handles deleteResource on non-existent or already deleted resources', async () => {
      const nonExistentPath = 'app:/GhostFolder/NonExistent.md';

      // 1. Delete on resource that never existed resolves cleanly
      await expect(client.deleteResource(nonExistentPath)).resolves.toBeUndefined();

      // 2. Create resource, delete it, then delete again
      const fileBuffer = new Uint8Array([1, 2, 3]).buffer;
      const realPath = 'app:/Temp/WillDelete.md';
      await client.uploadFile(realPath, fileBuffer);

      // First delete
      await expect(client.deleteResource(realPath)).resolves.toBeUndefined();

      // Second delete on same path
      await expect(client.deleteResource(realPath)).resolves.toBeUndefined();

      // Third delete on same path
      await expect(client.deleteResource(realPath)).resolves.toBeUndefined();
    });

    it('handles concurrent uploads of distinct files to the same directory without directory collisions', async () => {
      const uploadPromises = Array.from({ length: 10 }).map((_, i) => {
        const path = `app:/BatchUpload/file_${i}.txt`;
        const content = new TextEncoder().encode(`Data ${i}`).buffer;
        return client.uploadFile(path, content);
      });

      await expect(Promise.all(uploadPromises)).resolves.not.toThrow();

      // Verify all 10 files exist and are downloadable
      for (let i = 0; i < 10; i++) {
        const path = `app:/BatchUpload/file_${i}.txt`;
        const downloaded = await client.downloadFile(path);
        const text = new TextDecoder().decode(downloaded);
        expect(text).toBe(`Data ${i}`);
      }
    });
  });
});
