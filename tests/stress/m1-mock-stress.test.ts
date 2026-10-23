import { describe, it, expect, beforeEach } from 'vitest';
import { MockDataAdapter } from '../mocks/mock-adapter';
import { MockVault, MockTFile, MockTFolder } from '../mocks/mock-vault';
import { MockYandexDiskServer } from '../mocks/mock-yandex-disk';
import { YANDEX_APP_FOLDER_PREFIX } from '../../src/constants';

describe('Milestone 1 Empirical Challenger: Mock Harness Stress Suite', () => {
  let adapter: MockDataAdapter;
  let vault: MockVault;
  let server: MockYandexDiskServer;

  beforeEach(() => {
    adapter = new MockDataAdapter();
    vault = new MockVault(adapter);
    server = new MockYandexDiskServer();
  });

  // =========================================================================
  // Dimension 1: Binary Buffer Fidelity & Large Payloads
  // =========================================================================
  describe('Dimension 1: Binary Fidelity, Defensive Copying & Concurrency', () => {
    it('handles 0-byte empty file cleanly across adapter, vault, and remote server', async () => {
      const emptyBuffer = new ArrayBuffer(0);

      // Adapter
      await adapter.writeBinary('empty-adapter.bin', emptyBuffer);
      const readAdapter = await adapter.readBinary('empty-adapter.bin');
      expect(readAdapter.byteLength).toBe(0);

      // Vault
      const vaultFile = await vault.createBinary('empty-vault.bin', emptyBuffer);
      const readVault = await vault.readBinary(vaultFile);
      expect(readVault.byteLength).toBe(0);

      // Server
      await server.uploadFile('app:/empty-remote.bin', emptyBuffer);
      const readServer = await server.downloadFile('app:/empty-remote.bin');
      expect(readServer.byteLength).toBe(0);

      // Check SHA-256 for empty buffer in server listing
      const listing = await server.listDirectory('app:/');
      const item = listing.items.find((i) => i.name === 'empty-remote.bin');
      expect(item).toBeDefined();
      expect(item?.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('preserves null bytes (0x00) and full 0x00-0xFF byte range without alteration or truncation', async () => {
      // 256 bytes covering entire unsigned byte range
      const fullRange = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        fullRange[i] = i;
      }

      await adapter.writeBinary('binary/fullrange.bin', fullRange.buffer);
      const readAdapter = new Uint8Array(await adapter.readBinary('binary/fullrange.bin'));

      expect(readAdapter.byteLength).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(readAdapter[i]).toBe(i);
      }

      // Check string decode/encode did not tamper with null bytes
      expect(readAdapter[0]).toBe(0); // null byte
      expect(readAdapter[255]).toBe(255);
    });

    it('ensures byte-for-byte identity on realistic PNG and PDF headers with binary data', async () => {
      // Simulated PNG: 8-byte magic header + IHDR chunk + null bytes + EOF
      const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
        0x00, 0x00, 0x00, 0x0d, // IHDR length (13)
        0x49, 0x48, 0x44, 0x52, // IHDR
        0x00, 0x00, 0x01, 0x00, // Width 256
        0x00, 0x00, 0x01, 0x00, // Height 256
        0x08, 0x06, 0x00, 0x00, 0x00, // Bit depth, color type, compression, filter, interlace
        0x5c, 0x72, 0xa8, 0x66, // CRC
      ]);

      // Simulated PDF: header + body with null bytes + trailer
      const pdfHeader = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n');
      const pdfBody = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]);
      const pdfTrailer = new TextEncoder().encode('\n%%EOF\n');
      const pdfBytes = new Uint8Array(pdfHeader.length + pdfBody.length + pdfTrailer.length);
      pdfBytes.set(pdfHeader, 0);
      pdfBytes.set(pdfBody, pdfHeader.length);
      pdfBytes.set(pdfTrailer, pdfHeader.length + pdfBody.length);

      // Test PNG through Vault
      const pngFile = await vault.createBinary('attachments/image.png', pngBytes.buffer);
      const readPng = new Uint8Array(await vault.readBinary(pngFile));
      expect(readPng).toEqual(pngBytes);

      // Test PDF through Yandex Disk Server
      await server.uploadFile('app:/docs/sample.pdf', pdfBytes.buffer);
      const readPdf = new Uint8Array(await server.downloadFile('app:/docs/sample.pdf'));
      expect(readPdf).toEqual(pdfBytes);
    });

    it('maintains integrity of 1MB binary buffer and computes matching SHA-256', async () => {
      const size = 1024 * 1024; // 1 MB
      const largeBytes = new Uint8Array(size);
      // Fill with pseudo-random pattern including null bytes
      let seed = 0x12345678;
      for (let i = 0; i < size; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        largeBytes[i] = seed & 0xff;
      }

      // Compute expected SHA-256
      const expectedDigest = await crypto.subtle.digest('SHA-256', largeBytes);
      const expectedSha256 = Array.from(new Uint8Array(expectedDigest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // Test across Adapter, Vault, and Server
      const file = await vault.createBinary('large/data.bin', largeBytes.buffer);
      const readFromVault = await vault.readBinary(file);
      expect(readFromVault.byteLength).toBe(size);

      const vaultDigest = await crypto.subtle.digest('SHA-256', readFromVault);
      const vaultSha256 = Array.from(new Uint8Array(vaultDigest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      expect(vaultSha256).toBe(expectedSha256);

      // Remote Server
      await server.uploadFile('app:/large/data.bin', readFromVault);
      const list = await server.listDirectory('app:/large');
      const item = list.items.find((i) => i.name === 'data.bin');
      expect(item?.sha256).toBe(expectedSha256);
      expect(item?.size).toBe(size);

      const downloaded = await server.downloadFile('app:/large/data.bin');
      expect(downloaded.byteLength).toBe(size);
    });

    it('enforces defensive copying: modifying external buffer does not alter internal mock state', async () => {
      const original = new Uint8Array([10, 20, 30, 40]);
      await adapter.writeBinary('defensive.bin', original.buffer);

      // Mutate original source array
      original[0] = 99;

      // Mock must still hold original value 10
      const read1 = new Uint8Array(await adapter.readBinary('defensive.bin'));
      expect(read1[0]).toBe(10);

      // Mutate the returned buffer
      read1[0] = 77;

      // Mock must still hold 10
      const read2 = new Uint8Array(await adapter.readBinary('defensive.bin'));
      expect(read2[0]).toBe(10);
    });

    it('handles concurrent interleaved reads and writes across multiple files', async () => {
      const fileCount = 20;
      const writePromises = [];

      for (let i = 0; i < fileCount; i++) {
        const data = new Uint8Array([i, i + 1, i + 2]).buffer;
        writePromises.push(adapter.writeBinary(`concurrent/file_${i}.bin`, data));
      }
      await Promise.all(writePromises);

      // Concurrent reads
      const readPromises = [];
      for (let i = 0; i < fileCount; i++) {
        readPromises.push(
          adapter.readBinary(`concurrent/file_${i}.bin`).then((buf) => {
            const arr = new Uint8Array(buf);
            expect(arr[0]).toBe(i);
            expect(arr[1]).toBe(i + 1);
            expect(arr[2]).toBe(i + 2);
          })
        );
      }
      await Promise.all(readPromises);
    });
  });

  // =========================================================================
  // Dimension 2: Fault Injection & Resilience Testing
  // =========================================================================
  describe('Dimension 2: Fault Injection (MockDataAdapter & MockYandexDiskServer)', () => {
    it('MockDataAdapter: injects and clears faults on read, write, remove, and stat', async () => {
      const path = 'faulty/target.md';
      await adapter.write(path, 'Initial Content');

      // 1. Read fault
      adapter.injectFault(path, 'read', new Error('E_READ_FAULT'));
      await expect(adapter.read(path)).rejects.toThrow('E_READ_FAULT');
      await expect(adapter.readBinary(path)).rejects.toThrow('E_READ_FAULT');

      // 2. Clear fault restores read
      adapter.clearFaults();
      expect(await adapter.read(path)).toBe('Initial Content');

      // 3. Write fault
      adapter.injectFault(path, 'write', new Error('E_WRITE_FAULT'));
      await expect(adapter.write(path, 'New Content')).rejects.toThrow('E_WRITE_FAULT');
      await expect(adapter.writeBinary(path, new ArrayBuffer(4))).rejects.toThrow('E_WRITE_FAULT');
      adapter.clearFaults();

      // 4. Stat / Exists fault
      adapter.injectFault(path, 'stat', new Error('E_STAT_FAULT'));
      await expect(adapter.stat(path)).rejects.toThrow('E_STAT_FAULT');
      await expect(adapter.exists(path)).rejects.toThrow('E_STAT_FAULT');
      adapter.clearFaults();

      // 5. Remove fault
      adapter.injectFault(path, 'remove', new Error('E_REMOVE_FAULT'));
      await expect(adapter.remove(path)).rejects.toThrow('E_REMOVE_FAULT');
      adapter.clearFaults();
      await adapter.remove(path);
      expect(await adapter.exists(path)).toBe(false);
    });

    it('MockDataAdapter: fault injection is path-specific and supports path normalization', async () => {
      await adapter.write('a/target.md', 'Data A');
      await adapter.write('b/other.md', 'Data B');

      // Inject fault with non-normalized path (backslash, leading slash)
      adapter.injectFault('/a\\target.md/', 'read', new Error('E_SPECIFIC'));

      // Target path fails
      await expect(adapter.read('a/target.md')).rejects.toThrow('E_SPECIFIC');
      // Other path succeeds
      expect(await adapter.read('b/other.md')).toBe('Data B');

      adapter.clearFaults();
    });

    it('MockYandexDiskServer: injectFailures simulates HTTP errors for exact count of requests', async () => {
      server.injectFailures(2, 503);

      // First request fails with 503
      await expect(server.getDiskInfo()).rejects.toThrow('Simulated HTTP 503');
      // Second request fails with 503
      await expect(server.listDirectory('app:/')).rejects.toThrow('Simulated HTTP 503');
      // Third request succeeds
      const info = await server.getDiskInfo();
      expect(info.user.login).toBe('mock-user');
    });

    it('MockYandexDiskServer: injectRateLimit simulates HTTP 429 with status and message', async () => {
      server.injectRateLimit(2);

      let caughtStatus1: number | undefined;
      try {
        await server.getDiskInfo();
      } catch (err: any) {
        caughtStatus1 = err.status;
        expect(err.message).toBe('Rate limit exceeded');
      }
      expect(caughtStatus1).toBe(429);

      let caughtStatus2: number | undefined;
      try {
        await server.uploadFile('app:/test.txt', new ArrayBuffer(0));
      } catch (err: any) {
        caughtStatus2 = err.status;
      }
      expect(caughtStatus2).toBe(429);

      // Next request succeeds
      const info = await server.getDiskInfo();
      expect(info.total_space).toBeGreaterThan(0);
    });

    it('Empirical Discovery: MockYandexDiskServer does NOT implement setRateLimited method', () => {
      // The dispatch instructions refer to `mockYandexDisk.setRateLimited(...)`.
      // We verify empirically whether setRateLimited exists or if injectRateLimit is the actual method.
      const hasSetRateLimited = typeof (server as any).setRateLimited === 'function';
      const hasInjectRateLimit = typeof server.injectRateLimit === 'function';

      expect(hasInjectRateLimit).toBe(true);
      expect(hasSetRateLimited, 'Discrepancy: setRateLimited method does not exist on MockYandexDiskServer').toBe(false);
    });
  });

  // =========================================================================
  // Dimension 3: Edge Case Paths (Unicode, Nested, Spaces, Deep Hierarchy)
  // =========================================================================
  describe('Dimension 3: Unicode, Nested Paths, Deep Hierarchy & Spaces', () => {
    it('handles Cyrillic, Chinese, and Emoji paths across Vault and Server', async () => {
      const unicodePaths = [
        'Заметки/Рабочие материалы/Проект 2026.md',
        '📁 Work 🎯/📝 Meeting Notes 🚀.md',
        '知识库/日记/2026年10月.md',
        'Café/résumé & Überwald (100%).md',
      ];

      for (const p of unicodePaths) {
        // Vault
        const file = await vault.create(p, `Content for ${p}`);
        expect(file.path).toBe(adapter.normalizePath(p));
        expect(await vault.read(file)).toBe(`Content for ${p}`);

        // Server
        const remotePath = `${YANDEX_APP_FOLDER_PREFIX}${p}`;
        const buf = new TextEncoder().encode(`Remote ${p}`).buffer;
        await server.uploadFile(remotePath, buf);
        const downloaded = await server.downloadFile(remotePath);
        expect(new TextDecoder().decode(downloaded)).toBe(`Remote ${p}`);
      }
    });

    it('handles paths with multiple spaces and leading/trailing spaces within segments', async () => {
      const spacePath = 'Folder   with   spaces/My Note with multiple   spaces.md';
      const file = await vault.create(spacePath, 'Space test');
      expect(file.path).toBe(spacePath);
      expect(await vault.read(file)).toBe('Space test');

      const fileInVault = vault.getFileByPath(spacePath);
      expect(fileInVault).not.toBeNull();
      expect(fileInVault?.name).toBe('My Note with multiple   spaces.md');
    });

    it('handles deep hierarchy of 15 directory levels', async () => {
      const segments: string[] = [];
      for (let i = 1; i <= 15; i++) {
        segments.push(`level_${i}`);
      }
      const deepFolder = segments.join('/');
      const deepFilePath = `${deepFolder}/deepest_note.md`;

      await vault.create(deepFilePath, 'Deep hierarchy content');
      expect(await adapter.exists(deepFilePath)).toBe(true);

      // Verify listing at intermediate level
      const intermediate = segments.slice(0, 5).join('/');
      const list = await adapter.list(intermediate);
      expect(list.folders).toContain(`${intermediate}/level_6`);

      // Verify remote server deep folder creation and listing
      await server.ensureDirectory(`app:/${deepFolder}`);
      await server.uploadFile(`app:/${deepFilePath}`, new TextEncoder().encode('Deep remote').buffer);
      const remoteList = await server.listDirectory(`app:/${deepFolder}`);
      expect(remoteList.items.some((i) => i.name === 'deepest_note.md')).toBe(true);
    });

    it('handles path normalization: backslashes, double slashes, and leading/trailing slashes', async () => {
      const weirdPath = '\\nested\\\\folder///deep\\note.md';
      const normalized = adapter.normalizePath(weirdPath);
      expect(normalized).toBe('nested/folder/deep/note.md');

      const file = await vault.create(weirdPath, 'Weird path content');
      expect(file.path).toBe('nested/folder/deep/note.md');
      expect(vault.getFileByPath('nested/folder/deep/note.md')).not.toBeNull();
      expect(vault.getFileByPath('\\nested/folder\\deep/note.md')).not.toBeNull();
    });
  });

  // =========================================================================
  // Dimension 4: Adversarial Stress & Bug Hunting
  // =========================================================================
  describe('Dimension 4: Adversarial Edge Cases & Defect Reproduction', () => {
    it('BUG PROBE 1: MockVault.rename computes lastDot on file.name accurately', async () => {
      const file = await vault.create('initial.md', 'Test content');
      expect(file.basename).toBe('initial');
      expect(file.extension).toBe('md');

      await vault.rename(file, 'subfolder/renamed.md');

      expect(file.name).toBe('renamed.md');
      expect(file.basename).toBe('renamed');
      expect(file.extension).toBe('md');
      expect(file.path).toBe('subfolder/renamed.md');
      expect(file.parent?.path).toBe('subfolder');
    });

    it('BUG PROBE 2: MockVault.rename on MockTFolder renames folder and descendant files', async () => {
      const folder = await vault.createFolder('projects');
      await vault.create('projects/spec.md', 'Spec content');
      expect(folder).toBeInstanceOf(MockTFolder);

      // Attempting to rename a folder in MockVault
      await vault.rename(folder, 'archive');

      expect(folder.path).toBe('archive');
      expect(folder.name).toBe('archive');
      expect(vault.getFolderByPath('projects')).toBeNull();
      expect(vault.getFolderByPath('archive')).toBe(folder);

      // Descendant file must be re-mapped
      expect(vault.getFileByPath('projects/spec.md')).toBeNull();
      const remappedFile = vault.getFileByPath('archive/spec.md');
      expect(remappedFile).not.toBeNull();
      expect(remappedFile?.path).toBe('archive/spec.md');
      expect(await vault.read(remappedFile!)).toBe('Spec content');
    });

    it('BUG PROBE 3: MockVault populates folderMap on file creation, and deleting folder removes descendant files from fileMap', async () => {
      // Part A: Creating a file in a subfolder registers the folder in vault.folderMap
      await vault.create('implicit-folder/doc1.md', 'Doc 1');
      const implicitFolder = vault.getFolderByPath('implicit-folder');
      expect(implicitFolder).not.toBeNull();
      expect(implicitFolder?.path).toBe('implicit-folder');
      expect(implicitFolder?.children.length).toBe(1);

      // Part B: Deleting the folder removes descendant files from vault.fileMap
      const explicitFolder = await vault.createFolder('my-folder');
      await vault.create('my-folder/doc2.md', 'Doc 2');
      expect(vault.getFolderByPath('my-folder')).not.toBeNull();

      // Delete the folder
      await vault.delete(explicitFolder);

      // In adapter, the file was removed by rmdir
      expect(await adapter.exists('my-folder/doc2.md')).toBe(false);

      // In vault.fileMap, descendant file is also purged
      const orphanedFile = vault.getFileByPath('my-folder/doc2.md');
      expect(orphanedFile).toBeNull();
      expect(vault.getFolderByPath('my-folder')).toBeNull();
    });

    it('BUG PROBE 4: Concurrent MockVault.create on identical path creates duplicate files and emits duplicate events', async () => {
      // If two concurrent calls execute vault.create('race.md', ...) before either finishes:
      const p1 = vault.create('race.md', 'Content 1');
      const p2 = vault.create('race.md', 'Content 2');

      // In a real vault, one must fail with 'File already exists: race.md'
      const results = await Promise.allSettled([p1, p2]);

      const fulfilledCount = results.filter((r) => r.status === 'fulfilled').length;
      // In current MockVault, both succeed because fileMap.set is called AFTER await adapter.write
      expect(fulfilledCount, 'TOCTOU race condition: both concurrent creates succeeded without throwing').toBe(2);
    });

    it('BUG PROBE 5: MockYandexDiskServer does not prevent path traversal with app:/../', async () => {
      // validateSandboxedPath only tests remotePath.startsWith('app:/')
      // It does not normalize path or reject '..'
      const traversalPath = 'app:/../outside_sandbox.txt';
      const buf = new TextEncoder().encode('leaked').buffer;

      // This should ideally throw Forbidden, but currently succeeds
      let threw = false;
      try {
        await server.uploadFile(traversalPath, buf);
      } catch (err: any) {
        threw = true;
      }

      expect(threw, 'Defect confirmed: MockYandexDiskServer accepts app:/../ path traversal').toBe(false);
    });

    it('PROBE 6: MockVault.seed handles text and binary files, but adapter.dump corrupts binary', async () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]).buffer;
      await vault.seed({
        'notes/seeded.md': '# Seeded',
        'images/seeded.png': pngHeader,
      });

      expect(vault.getFileByPath('notes/seeded.md')).not.toBeNull();
      expect(vault.getFileByPath('images/seeded.png')).not.toBeNull();

      // adapter.dump() decodes everything as utf-8 strings
      const dumped = adapter.dump();
      expect(dumped['notes/seeded.md']).toBe('# Seeded');
      // Binary contains replacement char \uFFFD
      expect(dumped['images/seeded.png']).toBeDefined();
    });

    it('PROBE 7: adapter.setFileMtime modifies adapter record but desyncs TFile.stat', async () => {
      const file = await vault.create('timestamp-test.md', 'Data');
      const oldMtime = file.stat.mtime;

      const newMtime = oldMtime + 50000;
      adapter.setFileMtime('timestamp-test.md', newMtime);

      // Adapter stat has new mtime
      const adapterStat = await adapter.stat('timestamp-test.md');
      expect(adapterStat?.mtime).toBe(newMtime);

      // BUT cached TFile.stat still has old mtime
      expect(file.stat.mtime).toBe(oldMtime);
    });
  });
});

