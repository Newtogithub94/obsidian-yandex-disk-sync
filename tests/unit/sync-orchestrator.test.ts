/**
 * tests/unit/sync-orchestrator.test.ts
 * End-to-end integration tests for the SyncOrchestrator pipeline:
 * - Bidirectional synchronization (upload & download)
 * - Zero data loss conflict copy creation
 * - E2EE encryption/decryption in-flight
 * - Binary attachment integrity
 * - Cross-platform exclusion filtering
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncOrchestrator } from '../../src/sync/sync-orchestrator';
import { CryptoService } from '../../src/crypto/crypto-service';
import { ManifestManager } from '../../src/sync/manifest-manager';
import { YandexDiskClient } from '../../src/api/yandex-disk-client';
import { MockApp } from '../mocks/mock-app';
import { MockVault, MockTFile } from '../mocks/mock-vault';
import { MockDataAdapter } from '../mocks/mock-adapter';
import { App } from 'obsidian';
import { DEFAULT_SETTINGS, YANDEX_APP_FOLDER_PREFIX, MANIFEST_STORAGE_PATH } from '../../src/constants';
import { YandexSyncSettings, YandexResourceItem } from '../../src/types';

describe('SyncOrchestrator End-to-End Pipeline', () => {
  let app: MockApp;
  let adapter: MockDataAdapter;
  let vault: MockVault;
  let settings: YandexSyncSettings;
  let cryptoService: CryptoService;
  let manifestManager: ManifestManager;
  let client: YandexDiskClient;
  let orchestrator: SyncOrchestrator;

  // In-memory remote storage simulation
  let remoteStorage: Map<string, { data: ArrayBuffer; modified: string; etag: string }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new MockDataAdapter();
    vault = new MockVault(adapter);
    app = new MockApp();
    app.vault = vault as any;

    settings = {
      ...DEFAULT_SETTINGS,
      oauthToken: 'test-oauth-token',
      remoteFolder: 'MyVault',
      e2eeEnabled: false,
    };

    cryptoService = new CryptoService();
    manifestManager = new ManifestManager(adapter as any);
    client = new YandexDiskClient(settings.oauthToken);

    remoteStorage = new Map();

    // Mock YandexDiskClient methods to interact with in-memory remoteStorage
    vi.spyOn(client, 'ensureDirectory').mockResolvedValue();

    vi.spyOn(client as any, 'listDirectoryRecursive').mockImplementation((async (remotePath: any) => {
      const items: YandexResourceItem[] = [];
      const prefix = typeof remotePath === 'string' && remotePath.endsWith('/') ? remotePath : `${remotePath}/`;

      for (const [key, val] of remoteStorage.entries()) {
        if (key.startsWith(prefix)) {
          items.push({
            name: key.split('/').pop()!,
            path: key,
            type: 'file',
            size: val.data.byteLength,
            etag: val.etag,
            modified: val.modified,
          });
        }
      }
      return items;
    }) as any);

    vi.spyOn(client, 'listDirectory').mockImplementation(async (remotePath: string) => {
      const items: YandexResourceItem[] = [];
      const prefix = remotePath.endsWith('/') ? remotePath : `${remotePath}/`;

      for (const [key, val] of remoteStorage.entries()) {
        if (key.startsWith(prefix)) {
          const relative = key.substring(prefix.length);
          if (!relative.includes('/')) {
            items.push({
              name: relative,
              path: key,
              type: 'file',
              size: val.data.byteLength,
              etag: val.etag,
              modified: val.modified,
            });
          }
        }
      }

      return {
        path: remotePath,
        items,
        limit: 1000,
        offset: 0,
        total: items.length,
      };
    });

    vi.spyOn(client, 'uploadFile').mockImplementation(
      async (remotePath: string, content: ArrayBuffer) => {
        const etag = 'etag-synced';
        remoteStorage.set(remotePath, {
          data: content.slice(0),
          modified: new Date().toISOString(),
          etag,
        });
        return { etag } as any;
      }
    );

    vi.spyOn(client, 'downloadFile').mockImplementation(async (remotePath: string) => {
      const item = remoteStorage.get(remotePath);
      if (!item) {
        throw new Error(`Remote file not found: ${remotePath}`);
      }
      return item.data.slice(0);
    });

    vi.spyOn(client, 'deleteResource').mockImplementation(async (remotePath: string) => {
      remoteStorage.delete(remotePath);
    });

    orchestrator = new SyncOrchestrator(
      app as unknown as App,
      settings,
      client,
      manifestManager,
      cryptoService
    );
  });

  it('uploads a newly created local note to Yandex Disk', async () => {
    const text = '# My First Note\nCreated locally on Windows.';
    await vault.create('Notes/Intro.md', text);

    const result = await orchestrator.synchronize();
    if (result.errors.length > 0) {
      console.error('SYNC ERRORS:', JSON.stringify(result.errors, null, 2));
    }

    expect(result.success).toBe(true);
    expect(result.uploadedFiles).toContain('Notes/Intro.md');

    // Verify file is stored in remote storage under app:/MyVault/Notes/Intro.md
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/Intro.md`;
    expect(remoteStorage.has(remoteKey)).toBe(true);

    const decoder = new TextDecoder();
    const remoteText = decoder.decode(remoteStorage.get(remoteKey)!.data);
    expect(remoteText).toBe(text);
  });

  it('downloads a newly created remote note to the local vault', async () => {
    const text = '# Android Note\nCreated remotely on Android.';
    const encoder = new TextEncoder();
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Mobile/Daily.md`;

    remoteStorage.set(remoteKey, {
      data: encoder.encode(text).buffer,
      modified: new Date().toISOString(),
      etag: 'etag-remote-1',
    });

    const result = await orchestrator.synchronize();
    if (result.errors.length > 0) {
      console.error('SYNC ERRORS:', JSON.stringify(result.errors, null, 2));
    }

    expect(result.success).toBe(true);
    expect(result.downloadedFiles).toContain('Mobile/Daily.md');

    // Verify note is written into local Obsidian Vault
    const localFile = vault.getAbstractFileByPath('Mobile/Daily.md');
    expect(localFile).toBeInstanceOf(MockTFile);
    const localContent = await vault.read(localFile as any);
    expect(localContent).toBe(text);
  });

  it('guarantees zero data loss on concurrent edits via conflict copy', async () => {
    // 1. Initial sync
    await vault.create('Work/Plan.md', 'Version 1 baseline');
    await orchestrator.synchronize();

    // 2. Local edit
    const file = vault.getAbstractFileByPath('Work/Plan.md') as MockTFile;
    await vault.modify(file, 'Version 2 (Windows local edit)');

    // 3. Remote concurrent edit
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Work/Plan.md`;
    const encoder = new TextEncoder();
    remoteStorage.set(remoteKey, {
      data: encoder.encode('Version 3 (Android remote edit)').buffer,
      modified: new Date().toISOString(),
      etag: 'etag-remote-v3',
    });

    // 4. Synchronize
    const result = await orchestrator.synchronize();

    // Verify local file was preserved untouched
    const currentLocalText = await vault.read(file);
    expect(currentLocalText).toBe('Version 2 (Windows local edit)');

    // Verify conflict file was generated with the remote content
    expect(result.conflictFiles).toHaveLength(1);
    const conflictFileName = result.conflictFiles[0]!;
    expect(conflictFileName).toMatch(/Work\/Plan\.conflict-\d{8}-\d{6}\.md/);

    const conflictFile = vault.getAbstractFileByPath(conflictFileName);
    expect(conflictFile).toBeDefined();
    const conflictContent = await vault.read(conflictFile as any);
    expect(conflictContent).toBe('Version 3 (Android remote edit)');
  });

  it('seamlessly encrypts with E2EE on upload and decrypts on download', async () => {
    settings.e2eeEnabled = true;
    settings.e2eePassword = 'MasterSecretPassphrase123!';

    const secretText = 'Top-secret personal thoughts in Obsidian.';
    await vault.create('Private/Journal.md', secretText);

    // Sync with E2EE enabled
    const uploadResult = await orchestrator.synchronize();
    expect(uploadResult.success).toBe(true);

    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Private/Journal.md`;
    const remoteData = remoteStorage.get(remoteKey)!.data;

    // Verify remote data is strictly an encrypted OYDS envelope (not plaintext)
    expect(cryptoService.isEncrypted(remoteData)).toBe(true);
    const decoder = new TextDecoder();
    expect(decoder.decode(remoteData)).not.toContain('Top-secret');

    // Simulate second device: delete local note and download back
    const file = vault.getAbstractFileByPath('Private/Journal.md') as MockTFile;
    await vault.delete(file);
    manifestManager.removeEntry('Private/Journal.md');
    await adapter.remove(MANIFEST_STORAGE_PATH);

    // Download on second client with same passphrase
    const downloadResult = await orchestrator.synchronize();
    expect(downloadResult.success).toBe(true);

    const restoredFile = vault.getAbstractFileByPath('Private/Journal.md') as MockTFile;
    expect(restoredFile).toBeDefined();
    const restoredText = await vault.read(restoredFile);
    expect(restoredText).toBe(secretText);
  });

  it('preserves binary attachments byte-for-byte (PNG image / PDF)', async () => {
    // Generate 32 KB binary buffer
    const binary = new Uint8Array(32 * 1024);
    for (let i = 0; i < binary.length; i++) {
      binary[i] = (i * 17) % 256;
    }

    await vault.createBinary('Attachments/diagram.png', binary.buffer);
    const originalHash = await cryptoService.computeHash(binary.buffer);

    const uploadRes = await orchestrator.synchronize();
    expect(uploadRes.success).toBe(true);

    // Verify remote payload
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Attachments/diagram.png`;
    const remoteBuf = remoteStorage.get(remoteKey)!.data;
    const remoteHash = await cryptoService.computeHash(remoteBuf);
    expect(remoteHash).toBe(originalHash);
  });

  it('strictly excludes platform layout files (workspace.json, .trash)', async () => {
    await vault.create('.obsidian/workspace.json', '{"layout": "desktop"}');
    await vault.create('.obsidian/workspace-mobile.json', '{"layout": "mobile"}');
    await vault.create('.trash/old-note.md', 'deleted note');

    const result = await orchestrator.synchronize();
    expect(result.success).toBe(true);
    expect(result.uploadedFiles).toHaveLength(0);

    const remoteWorkspace = `${YANDEX_APP_FOLDER_PREFIX}MyVault/.obsidian/workspace.json`;
    expect(remoteStorage.has(remoteWorkspace)).toBe(false);
  });

  it('fast-path stat cache skips reading file binary when mtime and size match manifest', async () => {
    // 1. Create a file and sync it once
    const file = await vault.create('Notes/FastPath.md', 'Fast path initial content');
    const sync1 = await orchestrator.synchronize();
    expect(sync1.success).toBe(true);

    // Spy on readBinary
    const readBinarySpy = vi.spyOn(vault, 'readBinary');

    // 2. Run sync again with untouched file (mtime and size unchanged)
    const sync2 = await orchestrator.synchronize();
    expect(sync2.success).toBe(true);
    expect(sync2.uploadedFiles).toHaveLength(0);

    // Fast-path should have used cached hash without invoking readBinary for FastPath.md!
    const callsForFastPath = readBinarySpy.mock.calls.filter((call: any) => {
      const f = call[0];
      return f && f.path === 'Notes/FastPath.md';
    });
    expect(callsForFastPath).toHaveLength(0);

    // 3. Touch the file (modify mtime/content)
    await vault.modify(file, 'Fast path modified content');

    // 4. Now sync should invoke readBinary because mtime & size changed
    readBinarySpy.mockClear();
    const sync3 = await orchestrator.synchronize();
    expect(sync3.success).toBe(true);
    expect(sync3.uploadedFiles).toContain('Notes/FastPath.md');
    expect(readBinarySpy).toHaveBeenCalled();
  });

  it('pre-write CAS check diverts to conflict copy when user edits file mid-sync', async () => {
    // 1. Initial synced state
    const file = await vault.create('Notes/MidSync.md', 'Base version 1');
    await orchestrator.synchronize();

    // 2. Remote gets updated to Version 2
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/MidSync.md`;
    const encoder = new TextEncoder();
    remoteStorage.set(remoteKey, {
      data: encoder.encode('Remote Version 2 (Cloud)').buffer,
      modified: new Date(Date.now() + 1000).toISOString(),
      etag: 'etag-remote-v2',
    });

    // 3. Simulate mid-sync edit: during client.downloadFile, user writes to local file
    const origDownload = client.downloadFile.bind(client);
    vi.spyOn(client, 'downloadFile').mockImplementation(async (path: string) => {
      // Simulate user typing into local file right before the write happens:
      await vault.modify(file, 'Local Version 2 (User typed while download was in flight!)');
      return origDownload(path);
    });

    const result = await orchestrator.synchronize();
    expect(result.success).toBe(true);

    // The user's active edits in MidSync.md MUST NOT be lost or overwritten!
    const localContent = await vault.read(file);
    expect(localContent).toBe('Local Version 2 (User typed while download was in flight!)');

    // Remote download was diverted to a conflict copy
    expect(result.conflictFiles).toHaveLength(1);
    expect(result.conflictFiles[0]).toMatch(/Notes\/MidSync\.conflict-\d{8}-\d{6}\.md/);

    const conflictFile = vault.getAbstractFileByPath(result.conflictFiles[0]!) as MockTFile;
    const conflictContent = await vault.read(conflictFile);
    expect(conflictContent).toBe('Remote Version 2 (Cloud)');
  });

  it('converges identical plaintexts in E2EE without generating false conflicts', async () => {
    settings.e2eeEnabled = true;
    settings.e2eePassword = 'MasterSecretPassphrase123!';

    const identicalText = 'Exact same note content on both devices.';
    const file = await vault.create('Notes/Converge.md', identicalText);

    // Upload from device A
    await orchestrator.synchronize();

    // Device B generates a new encryption with a DIFFERENT random IV for the exact same plaintext
    const encoder = new TextEncoder();
    const freshCiphertext = await cryptoService.encrypt(encoder.encode(identicalText).buffer);

    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/Converge.md`;
    remoteStorage.set(remoteKey, {
      data: freshCiphertext,
      modified: new Date(Date.now() + 5000).toISOString(),
      etag: 'etag-different-iv',
    });

    // Device A edits base manifest or triggers diff conflict state
    // Simulate both sides flagged as modified
    const entry = manifestManager.getEntry('Notes/Converge.md')!;
    entry.remoteEtag = 'etag-old';
    entry.localHash = 'old-dummy-hash';
    manifestManager.setEntry(entry);

    const result = await orchestrator.synchronize();
    expect(result.success).toBe(true);

    // Because decrypted plaintext is identical to local plaintext, NO conflict copy is created!
    expect(result.conflictFiles).toHaveLength(0);
    const localContent = await vault.read(file);
    expect(localContent).toBe(identicalText);
  });

  it('handles Unicode NFC normalization across decomposed characters and Latvian diacritics', async () => {
    // 'заметки.md' with decomposed 'й' (\u0438\u0306) vs composed 'й' (\u0439)
    const decomposedPath = 'Заметки_\u0438\u0306.md'; // NFD
    const composedPath = 'Заметки_\u0439.md';   // NFC

    // Also Latvian diacritics: 'Mācības' with decomposed 'ā' (\u0061\u0304) vs composed 'ā' (\u0101)
    const decomposedLatvian = 'M\u0061\u0304c\u012bba.md';

    const file1 = await vault.create(decomposedPath, 'Cyrillic decomposed content');
    const file2 = await vault.create(decomposedLatvian, 'Latvian diacritics content');

    const result = await orchestrator.synchronize();
    expect(result.success).toBe(true);
    expect(result.uploadedFiles.length).toBe(2);

    // All paths in result and manifest should be canonical NFC
    for (const p of result.uploadedFiles) {
      expect(p).toBe(p.normalize('NFC'));
    }
  });

  it('pre-write CAS check on DELETE_LOCAL prevents deleting user edits and converts to UPLOAD_LOCAL_MOD', async () => {
    // 1. Initial synced state
    const file = await vault.create('Notes/DeleteMe.md', 'Original version');
    await orchestrator.synchronize();

    // 2. Remote file is deleted from another device
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/DeleteMe.md`;
    remoteStorage.delete(remoteKey);

    // 3. User edits local file before/during sync execution
    await vault.modify(file, 'User was typing during sync and added critical notes!');

    // 4. Synchronize: diff engine originally planned DELETE_LOCAL based on scan,
    // but CAS check discovers local edit and diverts to upload
    const result = await orchestrator.synchronize();
    expect(result.success).toBe(true);

    // Local file MUST NOT be deleted
    expect(result.deletedLocalFiles).not.toContain('Notes/DeleteMe.md');
    expect(result.uploadedFiles).toContain('Notes/DeleteMe.md');

    const localContent = await vault.read(file);
    expect(localContent).toBe('User was typing during sync and added critical notes!');

    // Manifest should reflect active file, not tombstone
    const entry = manifestManager.getEntry('Notes/DeleteMe.md');
    expect(entry?.tombstone).toBe(false);

    // Remote storage should now have the resurrected content
    expect(remoteStorage.has(remoteKey)).toBe(true);
  });

  it('case CONVERGE properly initializes manifest entry when files created independently without prior base', async () => {
    const identicalText = 'Independently created identical text on both machines';
    const encoder = new TextEncoder();
    const payload = encoder.encode(identicalText).buffer;
    const hash = await cryptoService.computeHash(payload);

    // Local file created
    await vault.create('Notes/IdenticalNew.md', identicalText);

    // Remote file created independently with matching SHA-256
    const remoteKey = `${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/IdenticalNew.md`;
    remoteStorage.set(remoteKey, {
      data: payload.slice(0),
      modified: new Date().toISOString(),
      etag: 'etag-remote-identical',
    });

    // Mock client to report sha256 in listDirectoryRecursive
    const origList = (client as any).listDirectoryRecursive.bind(client);
    vi.spyOn(client as any, 'listDirectoryRecursive').mockImplementation(async (path: any) => {
      const items = await origList(path);
      for (const item of items) {
        if (item.path === remoteKey) {
          item.sha256 = hash;
        }
      }
      return items;
    });

    // Verify manifest has no entry initially
    expect(manifestManager.getEntry('Notes/IdenticalNew.md')).toBeUndefined();

    // 1st Sync: triggers CONVERGE (State 3a)
    const result1 = await orchestrator.synchronize();
    expect(result1.success).toBe(true);
    expect(result1.plan.actions.some((a) => a.type === 'CONVERGE')).toBe(true);

    // Manifest entry MUST be initialized now!
    const entry = manifestManager.getEntry('Notes/IdenticalNew.md');
    expect(entry).toBeDefined();
    expect(entry?.localHash).toBe(hash);
    expect(entry?.remoteHash).toBe(hash);
    expect(entry?.localMtime).toBeGreaterThan(0);
    expect(entry?.localSize).toBe(payload.byteLength);

    // 2nd Sync: should result in clean NO_OP with 0 uploads, 0 downloads, 0 conflicts
    const result2 = await orchestrator.synchronize();
    expect(result2.success).toBe(true);
    expect(result2.uploadedFiles).toHaveLength(0);
    expect(result2.downloadedFiles).toHaveLength(0);
    expect(result2.conflictFiles).toHaveLength(0);
    expect(result2.plan.actions.find((a) => a.path === 'Notes/IdenticalNew.md')?.type).toBe('NO_OP');
  });

  it('honors interactive review callback by executing only approved actions (Approach A)', async () => {
    // 1. Create two new files locally
    await vault.create('Notes/KeepLocal.md', 'Secret local note - do not upload!');
    await vault.create('Notes/UploadMe.md', 'Public note - safe to sync.');

    // 2. Synchronize with interactive review callback that approves only UploadMe.md
    const result = await orchestrator.synchronize(async (plan) => {
      // User only selects UploadMe.md in the modal
      return plan.actions.filter((a) => a.path === 'Notes/UploadMe.md');
    });

    expect(result.success).toBe(true);
    expect(result.aborted).toBeFalsy();
    // Only UploadMe.md was uploaded
    expect(result.uploadedFiles).toContain('Notes/UploadMe.md');
    expect(result.uploadedFiles).not.toContain('Notes/KeepLocal.md');

    // Remote storage contains ONLY UploadMe.md
    expect(remoteStorage.has(`${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/UploadMe.md`)).toBe(true);
    expect(remoteStorage.has(`${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/KeepLocal.md`)).toBe(false);

    // Local file KeepLocal.md is completely intact and untouched
    const localNote = await vault.adapter.read('Notes/KeepLocal.md');
    expect(localNote).toBe('Secret local note - do not upload!');
  });

  it('safely aborts sync without touching any files when user cancels in review modal', async () => {
    await vault.create('Notes/Pending.md', 'Pending sync content');

    // Simulate user clicking "Cancel" in review modal
    const result = await orchestrator.synchronize(async () => null);

    expect(result.aborted).toBe(true);
    expect(result.uploadedFiles).toHaveLength(0);
    expect(remoteStorage.has(`${YANDEX_APP_FOLDER_PREFIX}MyVault/Notes/Pending.md`)).toBe(false);
  });
});
