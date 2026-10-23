import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl, RequestUrlResponse } from 'obsidian';
import { YandexDiskClient, canonicalizeRemotePath } from '../../src/api/yandex-disk-client';
import { SyncError } from '../../src/types';
import {
  YANDEX_API_BASE_URL,
  YANDEX_RESOURCES_URL,
  YANDEX_UPLOAD_URL,
  YANDEX_DOWNLOAD_URL,
  YANDEX_APP_FOLDER_PREFIX,
} from '../../src/constants';

describe('src/api/yandex-disk-client.ts: YandexDiskClient', () => {
  const mockToken = 'mock-oauth-token-12345';
  let client: YandexDiskClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new YandexDiskClient(mockToken, {
      maxRetries: 3,
      initialDelayMs: 1, // Fast tests
      maxDelayMs: 5,
    });
  });

  describe('1. Instantiation & Path Sanitization (R2 Sandboxing)', () => {
    it('sets and updates OAuth token', async () => {
      client.setToken('new-token-abc');
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {
          user: { login: 'octocat', uid: '123' },
          total_space: 1000,
          used_space: 500,
          trash_size: 0,
        },
        text: '',
      });

      await client.testConnection();

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'OAuth new-token-abc',
          }),
        })
      );
    });

    it('throws AUTH_REQUIRED when token is empty', async () => {
      const emptyClient = new YandexDiskClient('');
      await expect(emptyClient.testConnection()).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
    });

    it('normalizes relative vault paths into app:/ prefix', () => {
      expect(client.sanitizePath('')).toBe('app:/');
      expect(client.sanitizePath('Notes/Todo.md')).toBe('app:/Notes/Todo.md');
      expect(client.sanitizePath('app:/Notes/Todo.md')).toBe('app:/Notes/Todo.md');
      expect(client.sanitizePath('app:Notes/Todo.md')).toBe('app:/Notes/Todo.md');
    });

    it('converts Windows backslashes into forward slashes', () => {
      expect(client.sanitizePath('Notes\\Projects\\2026.md')).toBe(
        'app:/Notes/Projects/2026.md'
      );
    });

    it('strips trailing slashes on subfolders but preserves root app:/', () => {
      expect(client.sanitizePath('app:/')).toBe('app:/');
      expect(client.sanitizePath('app:/Folder/')).toBe('app:/Folder');
      expect(client.sanitizePath('Notes/Work/')).toBe('app:/Notes/Work');
    });

    it('resolves safe relative path segments (. and ..)', () => {
      expect(client.sanitizePath('Notes/./Daily.md')).toBe('app:/Notes/Daily.md');
      expect(client.sanitizePath('Notes/Drafts/../Final.md')).toBe('app:/Notes/Final.md');
    });

    it('strictly forbids path traversal attempting to escape app:/', () => {
      expect(() => client.sanitizePath('../outside.txt')).toThrow(SyncError);
      expect(() => client.sanitizePath('app:/../outside.txt')).toThrow(SyncError);
      expect(() => client.sanitizePath('app:/Notes/../../escaped.txt')).toThrow(SyncError);

      try {
        client.sanitizePath('app:/../secret.md');
      } catch (err: any) {
        expect(err.code).toBe('REMOTE_FORBIDDEN');
      }
    });

    it('trims leading and trailing whitespace from input path', () => {
      expect(client.sanitizePath('   app:/Notes/Todo.md   ')).toBe('app:/Notes/Todo.md');
      expect(client.sanitizePath('   Notes/Todo.md   ')).toBe('app:/Notes/Todo.md');
    });

    it('strictly forbids URL-encoded and double-encoded path traversal sequences', () => {
      const malicious = [
        'app:/..%2F..%2Foutside.md',
        'app:/%2e%2e/%2e%2e/escaped.md',
        'app:/%2E%2E/%2E%2E/escaped.md',
        'app:/..%5c..%5cescaped.md',
        'app:/..%5C..%5Cescaped.md',
        'app:/%2e%2e%2foutside.md',
        'app:/%252e%252e/%252e%252e/escaped.md',
        'app:\\foo\\..\\..\\bar',
      ];

      for (const p of malicious) {
        expect(() => client.sanitizePath(p)).toThrow(SyncError);
        try {
          client.sanitizePath(p);
        } catch (err: any) {
          expect(err.code).toBe('REMOTE_FORBIDDEN');
        }
      }
    });

    it('rejects malformed URI sequences with REMOTE_FORBIDDEN', () => {
      expect(() => client.sanitizePath('app:/bad%ZZpath')).toThrow(SyncError);
      try {
        client.sanitizePath('app:/bad%ZZpath');
      } catch (err: any) {
        expect(err.code).toBe('REMOTE_FORBIDDEN');
      }
    });

    it('strictly forbids external disk:/ paths to protect user files', () => {
      expect(() => client.sanitizePath('disk:/Documents/Secret.txt')).toThrow(SyncError);
      expect(() => client.sanitizePath('disk:/Приложения/OtherApp')).toThrow(SyncError);

      try {
        client.sanitizePath('disk:/Secret.md');
      } catch (err: any) {
        expect(err.code).toBe('REMOTE_FORBIDDEN');
      }
    });
  });

  describe('2. testConnection()', () => {
    it('returns parsed disk info on HTTP 200', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {
          user: { login: 'tester', uid: '987654', display_name: 'Test User' },
          total_space: 10737418240,
          used_space: 5368709120,
          trash_size: 1048576,
        },
        text: '',
      });

      const info = await client.testConnection();

      expect(info.user.login).toBe('tester');
      expect(info.user.uid).toBe('987654');
      expect(info.user.display_name).toBe('Test User');
      expect(info.total_space).toBe(10737418240);
      expect(info.used_space).toBe(5368709120);
      expect(info.trash_size).toBe(1048576);

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: YANDEX_API_BASE_URL,
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `OAuth ${mockToken}`,
          }),
        })
      );
    });

    it('throws AUTH_INVALID on HTTP 401', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 401,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { message: 'Unauthorized', error: 'UnauthorizedError' },
        text: '',
      });

      await expect(client.testConnection()).rejects.toMatchObject({
        code: 'AUTH_INVALID',
      });
    });

    it('throws REMOTE_FORBIDDEN on HTTP 403', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 403,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { message: 'Forbidden', error: 'AccessDeniedError' },
        text: '',
      });

      await expect(client.testConnection()).rejects.toMatchObject({
        code: 'REMOTE_FORBIDDEN',
      });
    });

    it('retries on HTTP 429 and succeeds on subsequent try', async () => {
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 429,
          headers: { 'retry-after': '0' },
          arrayBuffer: new ArrayBuffer(0),
          json: { error: 'TooManyRequests' },
          text: '',
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            user: { login: 'retry-user', uid: '111' },
            total_space: 100,
            used_space: 10,
            trash_size: 0,
          },
          text: '',
        });

      const info = await client.testConnection();
      expect(info.user.login).toBe('retry-user');
      expect(requestUrl).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. listDirectory() & listDirectoryRecursive()', () => {
    it('lists directory items and maps to YandexResourceItem[]', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {
          name: 'Notes',
          path: 'app:/Notes',
          type: 'dir',
          _embedded: {
            path: 'app:/Notes',
            total: 2,
            limit: 1000,
            offset: 0,
            items: [
              {
                name: 'Idea.md',
                path: 'app:/Notes/Idea.md',
                type: 'file',
                size: 512,
                sha256: 'abc123sha256',
                md5: 'def456md5',
                modified: '2026-10-21T10:00:00Z',
              },
              {
                name: 'Archive',
                path: 'app:/Notes/Archive',
                type: 'dir',
              },
            ],
          },
        },
        text: '',
      });

      const list = await client.listDirectory('app:/Notes');
      expect(list.path).toBe('app:/Notes');
      expect(list.items).toHaveLength(2);
      expect(list.items[0]).toEqual({
        name: 'Idea.md',
        path: 'app:/Notes/Idea.md',
        type: 'file',
        size: 512,
        sha256: 'abc123sha256',
        md5: 'def456md5',
        etag: undefined,
        modified: '2026-10-21T10:00:00Z',
        created: undefined,
        mime_type: undefined,
      });
      expect(list.items[1]!.type).toBe('dir');
    });

    it('paginates correctly when directory contains more than one page', async () => {
      // Page 1
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: 'BigFolder',
            path: 'app:/BigFolder',
            type: 'dir',
            _embedded: {
              path: 'app:/BigFolder',
              total: 3,
              limit: 2,
              offset: 0,
              items: [
                { name: 'file1.md', path: 'app:/BigFolder/file1.md', type: 'file' },
                { name: 'file2.md', path: 'app:/BigFolder/file2.md', type: 'file' },
              ],
            },
          },
          text: '',
        })
        // Page 2
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: 'BigFolder',
            path: 'app:/BigFolder',
            type: 'dir',
            _embedded: {
              path: 'app:/BigFolder',
              total: 3,
              limit: 2,
              offset: 2,
              items: [
                { name: 'file3.md', path: 'app:/BigFolder/file3.md', type: 'file' },
              ],
            },
          },
          text: '',
        });

      const list = await client.listDirectory('app:/BigFolder');
      expect(list.items).toHaveLength(3);
      expect(list.items.map((i) => i.name)).toEqual(['file1.md', 'file2.md', 'file3.md']);
      expect(requestUrl).toHaveBeenCalledTimes(2);
    });

    it('throws REMOTE_NOT_FOUND on HTTP 404', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 404,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: 'DiskNotFoundError' },
        text: '',
      });

      await expect(client.listDirectory('app:/NonExistent')).rejects.toMatchObject({
        code: 'REMOTE_NOT_FOUND',
      });
    });

    it('recursively lists all nested files and directories via listDirectoryRecursive', async () => {
      // Root folder listing
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: '',
            path: 'app:/',
            type: 'dir',
            _embedded: {
              path: 'app:/',
              total: 2,
              items: [
                { name: 'Root.md', path: 'app:/Root.md', type: 'file' },
                { name: 'Sub', path: 'app:/Sub', type: 'dir' },
              ],
            },
          },
          text: '',
        })
        // Sub folder listing
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: 'Sub',
            path: 'app:/Sub',
            type: 'dir',
            _embedded: {
              path: 'app:/Sub',
              total: 1,
              items: [
                { name: 'Nested.md', path: 'app:/Sub/Nested.md', type: 'file' },
              ],
            },
          },
          text: '',
        });

      const all = await client.listDirectoryRecursive('app:/');
      expect(all).toHaveLength(3);
      expect(all.map((i) => i.path)).toEqual([
        'app:/Root.md',
        'app:/Sub',
        'app:/Sub/Nested.md',
      ]);
    });

    it('canonicalizes real-world Yandex physical paths (disk:/Приложения/ and disk:/Applications/) into app:/', async () => {
      // Test the helper directly
      expect(canonicalizeRemotePath('disk:/Приложения/Obsidian Sync/Клональное микроразмножение (Экзамен)')).toBe(
        'app:/Клональное микроразмножение (Экзамен)'
      );
      expect(canonicalizeRemotePath('disk:/Приложения/Obsidian Sync')).toBe('app:/');
      expect(canonicalizeRemotePath('disk:/Applications/Obsidian Sync/Notes/Lecture.md')).toBe(
        'app:/Notes/Lecture.md'
      );
      expect(canonicalizeRemotePath('app:/Notes/Todo.md')).toBe('app:/Notes/Todo.md');

      // Test listDirectoryRecursive resolving physical child paths returned by Yandex Disk API
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: 'Obsidian Sync',
            path: 'disk:/Приложения/Obsidian Sync',
            type: 'dir',
            _embedded: {
              path: 'disk:/Приложения/Obsidian Sync',
              total: 2,
              items: [
                {
                  name: 'Клональное микроразмножение (Экзамен)',
                  path: 'disk:/Приложения/Obsidian Sync/Клональное микроразмножение (Экзамен)',
                  type: 'dir',
                },
                {
                  name: 'Index.md',
                  path: 'disk:/Приложения/Obsidian Sync/Index.md',
                  type: 'file',
                  size: 100,
                },
              ],
            },
          },
          text: '',
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            name: 'Клональное микроразмножение (Экзамен)',
            path: 'disk:/Приложения/Obsidian Sync/Клональное микроразмножение (Экзамен)',
            type: 'dir',
            _embedded: {
              path: 'disk:/Приложения/Obsidian Sync/Клональное микроразмножение (Экзамен)',
              total: 1,
              items: [
                {
                  name: 'Вопрос 1.md',
                  path: 'disk:/Приложения/Obsidian Sync/Клональное микроразмножение (Экзамен)/Вопрос 1.md',
                  type: 'file',
                  size: 200,
                },
              ],
            },
          },
          text: '',
        });

      const all = await client.listDirectoryRecursive('app:/');
      expect(all).toHaveLength(3);
      expect(all.map((i) => i.path)).toEqual([
        'app:/Клональное микроразмножение (Экзамен)',
        'app:/Index.md',
        'app:/Клональное микроразмножение (Экзамен)/Вопрос 1.md',
      ]);
    });
  });

  describe('4. ensureDirectory()', () => {
    it('is an immediate NO-OP for root app:/', async () => {
      await client.ensureDirectory('app:/');
      expect(requestUrl).not.toHaveBeenCalled();
    });

    it('creates single directory and handles 201 Created', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 201,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { href: '...', method: 'GET' },
        text: '',
      });

      await client.ensureDirectory('app:/Notes');

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent('app:/Notes')}`,
          method: 'PUT',
        })
      );
    });

    it('caches created directories to avoid duplicate network calls', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 201,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });

      await client.ensureDirectory('app:/Notes');
      expect(requestUrl).toHaveBeenCalledTimes(1);

      // Second call should hit in-memory cache
      await client.ensureDirectory('app:/Notes');
      expect(requestUrl).toHaveBeenCalledTimes(1);

      // Clearing cache re-allows call
      client.clearDirectoryCache();
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 201,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });
      await client.ensureDirectory('app:/Notes');
      expect(requestUrl).toHaveBeenCalledTimes(2);
    });

    it('treats HTTP 409 Conflict as idempotent success if folder exists', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 409,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: 'DiskResourceAlreadyExistsError' },
        text: '',
      });

      await expect(client.ensureDirectory('app:/AlreadyThere')).resolves.toBeUndefined();
    });

    it('creates nested folders sequentially from parent to child', async () => {
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 201, // app:/A
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        .mockResolvedValueOnce({
          status: 201, // app:/A/B
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.ensureDirectory('app:/A/B');

      expect(requestUrl).toHaveBeenCalledTimes(2);
      expect(vi.mocked(requestUrl).mock.calls[0]![0]).toMatchObject({
        url: `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent('app:/A')}`,
      });
      expect(vi.mocked(requestUrl).mock.calls[1]![0]).toMatchObject({
        url: `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent('app:/A/B')}`,
      });
    });
  });

  describe('5. uploadFile() Handshake', () => {
    const testContent = new TextEncoder().encode('# Test Content').buffer;

    it('executes two-step upload handshake (Step 1 GET upload URL -> Step 2 PUT raw body)', async () => {
      // Step 1: GET upload link
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            href: 'https://uploader.disk.yandex.net/upload-target/abc123',
            method: 'PUT',
          },
          text: '',
        })
        // Step 2: PUT raw ArrayBuffer to href
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.uploadFile('app:/Note.md', testContent, true);

      expect(requestUrl).toHaveBeenCalledTimes(2);

      // Check Step 1 call
      expect(vi.mocked(requestUrl).mock.calls[0]![0]).toMatchObject({
        url: `${YANDEX_UPLOAD_URL}?path=${encodeURIComponent('app:/Note.md')}&overwrite=true`,
        method: 'GET',
      });

      // Check Step 2 call
      expect(vi.mocked(requestUrl).mock.calls[1]![0]).toMatchObject({
        url: 'https://uploader.disk.yandex.net/upload-target/abc123',
        method: 'PUT',
        body: testContent,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });

    it('automatically ensures parent directory exists before upload handshake', async () => {
      // Parent directory mkdir
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 201, // mkdir app:/Deep
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        // Step 1: upload link
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://uploader/123' },
          text: '',
        })
        // Step 2: PUT binary
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.uploadFile('app:/Deep/File.md', testContent);

      expect(requestUrl).toHaveBeenCalledTimes(3);
      expect(vi.mocked(requestUrl).mock.calls[0]![0]).toMatchObject({
        url: `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent('app:/Deep')}`,
        method: 'PUT',
      });
    });

    it('throws REMOTE_CONFLICT if overwrite=false and resource already exists', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 409,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: 'DiskResourceAlreadyExistsError' },
        text: '',
      });

      await expect(client.uploadFile('app:/Existing.md', testContent, false)).rejects.toMatchObject(
        {
          code: 'REMOTE_CONFLICT',
        }
      );
    });

    it('throws REMOTE_FORBIDDEN on storage quota exhaustion (HTTP 507)', async () => {
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://uploader/full' },
          text: '',
        })
        .mockResolvedValueOnce({
          status: 507,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { error: 'DiskStorageFullError' },
          text: '',
        });

      await expect(client.uploadFile('app:/Big.zip', testContent)).rejects.toMatchObject({
        code: 'REMOTE_FORBIDDEN',
      });
    });

    it('retries PUT body on transient 500 error and succeeds', async () => {
      vi.mocked(requestUrl)
        // Step 1
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://uploader/transient' },
          text: '',
        })
        // Step 2 fail
        .mockResolvedValueOnce({
          status: 500,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        // Step 2 retry succeed
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.uploadFile('app:/Retry.md', testContent);
      expect(requestUrl).toHaveBeenCalledTimes(3);
    });

    it('correctly uploads 0-byte blank file', async () => {
      const emptyBuffer = new ArrayBuffer(0);

      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://uploader/empty' },
          text: '',
        })
        .mockResolvedValueOnce({
          status: 201,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        });

      await client.uploadFile('app:/Empty.md', emptyBuffer);
      expect(vi.mocked(requestUrl).mock.calls[1]![0]).toMatchObject({
        body: emptyBuffer,
      });
    });
  });

  describe('6. downloadFile() Handshake', () => {
    it('executes two-step download handshake and returns ArrayBuffer', async () => {
      const expectedBytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;

      // Step 1: GET download link
      vi.mocked(requestUrl)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {
            href: 'https://downloader.disk.yandex.net/disk/abc123download',
            method: 'GET',
          },
          text: '',
        })
        // Step 2: GET binary payload
        .mockResolvedValueOnce({
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
          arrayBuffer: expectedBytes,
          json: {},
          text: '',
        });

      const downloaded = await client.downloadFile('app:/Image.png');

      expect(downloaded).toEqual(expectedBytes);
      expect(requestUrl).toHaveBeenCalledTimes(2);

      expect(vi.mocked(requestUrl).mock.calls[0]![0]).toMatchObject({
        url: `${YANDEX_DOWNLOAD_URL}?path=${encodeURIComponent('app:/Image.png')}`,
        method: 'GET',
      });
      expect(vi.mocked(requestUrl).mock.calls[1]![0]).toMatchObject({
        url: 'https://downloader.disk.yandex.net/disk/abc123download',
        method: 'GET',
      });
    });

    it('throws REMOTE_NOT_FOUND if file does not exist on remote (HTTP 404)', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 404,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: 'DiskNotFoundError' },
        text: '',
      });

      await expect(client.downloadFile('app:/Missing.md')).rejects.toMatchObject({
        code: 'REMOTE_NOT_FOUND',
      });
    });

    it('retries binary transfer on HTTP 503 and succeeds', async () => {
      const expectedData = new Uint8Array([10, 20]).buffer;

      vi.mocked(requestUrl)
        // Step 1
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: { href: 'https://downloader/temp' },
          text: '',
        })
        // Step 2 fail 503
        .mockResolvedValueOnce({
          status: 503,
          headers: {},
          arrayBuffer: new ArrayBuffer(0),
          json: {},
          text: '',
        })
        // Step 2 retry succeed 200
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          arrayBuffer: expectedData,
          json: {},
          text: '',
        });

      const result = await client.downloadFile('app:/File.md');
      expect(result).toEqual(expectedData);
      expect(requestUrl).toHaveBeenCalledTimes(3);
    });
  });

  describe('7. deleteResource()', () => {
    it('deletes resource with HTTP 204 No Content', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 204,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });

      await client.deleteResource('app:/OldNote.md');

      expect(requestUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `${YANDEX_RESOURCES_URL}?path=${encodeURIComponent(
            'app:/OldNote.md'
          )}&permanently=true`,
          method: 'DELETE',
        })
      );
    });

    it('treats HTTP 404 Not Found as idempotent success', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 404,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: 'DiskNotFoundError' },
        text: '',
      });

      await expect(client.deleteResource('app:/AlreadyGone.md')).resolves.toBeUndefined();
    });

    it('handles HTTP 202 Accepted asynchronous deletion', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 202,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { href: 'https://cloud-api/operations/123' },
        text: '',
      });

      await expect(client.deleteResource('app:/LargeFolder')).resolves.toBeUndefined();
    });

    it('refuses to delete root app:/ directory', async () => {
      await expect(client.deleteResource('app:/')).rejects.toMatchObject({
        code: 'REMOTE_FORBIDDEN',
      });
      expect(requestUrl).not.toHaveBeenCalled();
    });

    it('throws AUTH_INVALID on HTTP 401 during delete', async () => {
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 401,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });

      await expect(client.deleteResource('app:/File.md')).rejects.toMatchObject({
        code: 'AUTH_INVALID',
      });
    });

    it('invalidates directory and its subdirectories in knownDirectories cache upon deletion', async () => {
      // Seed cache via ensureDirectory
      vi.mocked(requestUrl).mockResolvedValue({
        status: 201,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });

      await client.ensureDirectory('app:/Parent/Child/Grandchild');

      // Now delete Parent
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 204,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });

      await client.deleteResource('app:/Parent');

      // Calling ensureDirectory on Parent should require network call again because cache was cleared
      vi.mocked(requestUrl).mockClear();
      vi.mocked(requestUrl).mockResolvedValueOnce({
        status: 201,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: {},
        text: '',
      });

      await client.ensureDirectory('app:/Parent');
      expect(requestUrl).toHaveBeenCalledTimes(1);
    });
  });
});
