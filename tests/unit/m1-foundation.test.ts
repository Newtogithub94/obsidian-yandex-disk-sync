import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDataAdapter } from '../mocks/mock-adapter';
import { MockVault, MockTFile } from '../mocks/mock-vault';
import { MockApp } from '../mocks/mock-app';
import { MockYandexDiskServer } from '../mocks/mock-yandex-disk';
import { Platform, App } from 'obsidian';
import { Plugin as MockPlugin } from '../mocks/obsidian';
import YandexDiskSyncPlugin, { YandexDiskSyncSettingTab } from '../../src/main';
import {
  PLUGIN_ID,
  PLUGIN_NAME,
  DEFAULT_SETTINGS,
  DEFAULT_EXCLUDED_PATTERNS,
  ENVELOPE_HEADER_LENGTH,
  ENVELOPE_MAGIC_STRING,
  YANDEX_APP_FOLDER_PREFIX,
  YANDEX_OAUTH_SCOPE,
} from '../../src/constants';
import { SyncError } from '../../src/types';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Milestone 1: Project Foundation & Build System', () => {
  describe('1. Manifest Specification Verification', () => {
    it('manifest.json exists and strictly complies with Obsidian Community Guidelines', () => {
      const manifestPath = path.resolve(__dirname, '../../manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Property: id
      expect(manifestContent.id).toBe('yandex-disk-sync');
      expect(manifestContent.id).toMatch(/^[a-z0-9-]+$/);
      expect(manifestContent.id).not.toContain('obsidian');
      expect(manifestContent.id.endsWith('plugin')).toBe(false);

      // Property: name
      expect(manifestContent.name).toBe('Yandex Disk Sync');
      expect(manifestContent.name).not.toContain('Obsidian');
      expect(manifestContent.name).not.toContain('Plugin');

      // Property: version
      expect(manifestContent.version).toMatch(/^\d+\.\d+\.\d+$/);

      // Property: minAppVersion
      expect(manifestContent.minAppVersion).toBeDefined();

      // Property: description
      expect(manifestContent.description.length).toBeLessThanOrEqual(250);
      expect(manifestContent.description.endsWith('.')).toBe(true);
      expect(manifestContent.description).not.toMatch(/^This is a plugin/i);

      // Property: isDesktopOnly (MUST be false for Android support)
      expect(manifestContent.isDesktopOnly).toBe(false);
    });
  });

  describe('2. Domain Constants and Error Hierarchy', () => {
    it('constants match security, sandboxing, and envelope specifications', () => {
      expect(PLUGIN_ID).toBe('yandex-disk-sync');
      expect(PLUGIN_NAME).toBe('Yandex Disk Sync');
      expect(YANDEX_APP_FOLDER_PREFIX).toBe('app:/');
      expect(YANDEX_OAUTH_SCOPE).toBe('cloud_api:disk.app_folder');
      expect(ENVELOPE_HEADER_LENGTH).toBe(36);
      expect(ENVELOPE_MAGIC_STRING).toBe('OYDS');
    });

    it('default exclusion patterns filter system files and preserve markdown notes', () => {
      const shouldExclude = [
        '.obsidian/workspace.json',
        '.obsidian/workspace-mobile.json',
        'workspace.json',
        'workspace-mobile.json',
        'subfolder/workspace.json',
        '.trash/note.md',
        '.obsidian/plugins/yandex-disk-sync/data.json',
        '.DS_Store',
        'subfolder/.DS_Store',
        'Thumbs.db',
        'desktop.ini',
        '.git/config',
        '.sync-lock',
      ];

      const shouldKeep = [
        '.obsidian/workspace',
        'workspace_backup.md',
        'workspace.json.bak',
        'Notes/Project.md',
        'Images/diagram.png',
        'Attachments/doc.pdf',
        'README.md',
        'Work/Daily-2026-10-21.md',
      ];

      for (const p of shouldExclude) {
        const matches = DEFAULT_EXCLUDED_PATTERNS.some((regex) => regex.test(p));
        expect(matches, `Path "${p}" should be excluded`).toBe(true);
      }

      for (const p of shouldKeep) {
        const matches = DEFAULT_EXCLUDED_PATTERNS.some((regex) => regex.test(p));
        expect(matches, `Path "${p}" should NOT be excluded`).toBe(false);
      }
    });

    it('SyncError encapsulates error codes, path, and recoverability', () => {
      const error = new SyncError('Network request timed out', 'NETWORK_TIMEOUT', {
        recoverable: true,
        path: 'Notes/Test.md',
        originalError: new Error('ECONNRESET'),
      });

      expect(error.name).toBe('SyncError');
      expect(error.code).toBe('NETWORK_TIMEOUT');
      expect(error.recoverable).toBe(true);
      expect(error.path).toBe('Notes/Test.md');
      expect(error.originalError).toBeDefined();
    });
  });

  describe('3. In-Memory Mock DataAdapter & Vault Harness', () => {
    let adapter: MockDataAdapter;
    let vault: MockVault;

    beforeEach(() => {
      adapter = new MockDataAdapter();
      vault = new MockVault(adapter);
    });

    it('creates, reads, modifies, and deletes text and binary files in memory', async () => {
      // 1. Create text file
      const noteFile = await vault.create('Folder/My Note.md', '# Header Content\nInitial text.');
      expect(noteFile.path).toBe('Folder/My Note.md');
      expect(noteFile.basename).toBe('My Note');
      expect(noteFile.extension).toBe('md');
      expect(await vault.read(noteFile)).toBe('# Header Content\nInitial text.');

      // 2. Modify text file
      await vault.modify(noteFile, '# Updated Header');
      expect(await vault.read(noteFile)).toBe('# Updated Header');

      // 3. Create binary file
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
      const binFile = await vault.createBinary('Images/logo.png', binaryData);
      expect(binFile.extension).toBe('png');
      const readBuf = await vault.readBinary(binFile);
      expect(new Uint8Array(readBuf)).toEqual(new Uint8Array(binaryData));

      // 4. List files and filter markdown
      expect(vault.getFiles().length).toBe(2);
      expect(vault.getMarkdownFiles().length).toBe(1);
      expect(vault.getMarkdownFiles()[0]!.basename).toBe('My Note');

      // 5. Rename file
      await vault.rename(noteFile, 'Folder/Renamed Note.md');
      expect(vault.getFileByPath('Folder/My Note.md')).toBeNull();
      const renamedFile = vault.getFileByPath('Folder/Renamed Note.md');
      expect(renamedFile).not.toBeNull();
      expect(renamedFile?.basename).toBe('Renamed Note');
      expect(renamedFile?.extension).toBe('md');
      expect(renamedFile?.parent?.name).toBe('Folder');

      // 6. Delete file
      await vault.delete(binFile);
      expect(vault.getFileByPath('Images/logo.png')).toBeNull();
    });

    it('triggers Vault event lifecycle callbacks', async () => {
      const createEvents: string[] = [];
      const modifyEvents: string[] = [];
      const deleteEvents: string[] = [];
      const renameEvents: string[] = [];

      vault.on('create', (file) => createEvents.push(file.path));
      vault.on('modify', (file) => modifyEvents.push(file.path));
      vault.on('delete', (file) => deleteEvents.push(file.path));
      vault.on('rename', (file, oldPath) => renameEvents.push(`${oldPath}->${file.path}`));

      const file = await vault.create('EventTest.md', 'Initial');
      await vault.modify(file, 'Modified');
      await vault.rename(file, 'EventRenamed.md');
      await vault.delete(file);

      expect(createEvents).toEqual(['EventTest.md']);
      expect(modifyEvents).toEqual(['EventTest.md']);
      expect(renameEvents).toEqual(['EventTest.md->EventRenamed.md']);
      expect(deleteEvents).toEqual(['EventRenamed.md']);
    });

    it('supports fault injection for resilience testing', async () => {
      await vault.create('FaultTest.md', 'Data');

      adapter.injectFault('FaultTest.md', 'read', new Error('Simulated read I/O failure'));
      const file = vault.getFileByPath('FaultTest.md')!;

      await expect(vault.read(file)).rejects.toThrow('Simulated read I/O failure');

      adapter.clearFaults();
      expect(await vault.read(file)).toBe('Data');
    });
  });

  describe('4. In-Memory Mock Yandex Disk Server Harness', () => {
    let server: MockYandexDiskServer;

    beforeEach(() => {
      server = new MockYandexDiskServer();
    });

    it('enforces app:/ sandboxing and rejects forbidden paths', async () => {
      const buffer = new TextEncoder().encode('Payload').buffer;

      await expect(server.uploadFile('disk:/unauthorized.txt', buffer)).rejects.toThrow(/Forbidden/);
      await expect(server.downloadFile('/etc/passwd')).rejects.toThrow(/Forbidden/);

      // app:/ path succeeds
      await server.uploadFile('app:/allowed.txt', buffer);
      const downloaded = await server.downloadFile('app:/allowed.txt');
      expect(new TextDecoder().decode(downloaded)).toBe('Payload');
    });

    it('simulates folder listing, quota reporting, and rate limiting', async () => {
      await server.uploadFile('app:/Folder/doc1.md', new TextEncoder().encode('Doc 1').buffer);
      await server.uploadFile('app:/Folder/doc2.md', new TextEncoder().encode('Doc 2').buffer);

      const listing = await server.listDirectory('app:/Folder');
      expect(listing.items.length).toBe(2);
      expect(listing.items.map((i) => i.name).sort()).toEqual(['doc1.md', 'doc2.md']);

      const info = await server.getDiskInfo();
      expect(info.total_space).toBeGreaterThan(0);
      expect(info.used_space).toBeGreaterThan(0);

      // Fault injection: Rate limiting
      server.injectRateLimit(1);
      await expect(server.getDiskInfo()).rejects.toThrow('Rate limit exceeded');
      // Succeeds after limit consumed
      const nextInfo = await server.getDiskInfo();
      expect(nextInfo.user.login).toBe('mock-user');
    });
  });

  describe('5. Plugin Lifecycle, Mobile Guards & Settings Tab', () => {
    let app: MockApp;
    let manifest: any;

    beforeEach(() => {
      MockPlugin.resetStorage();
      Platform.isMobile = false;
      app = new MockApp();
      manifest = {
        id: 'yandex-disk-sync',
        name: 'Yandex Disk Sync',
        version: '1.0.0',
        minAppVersion: '1.4.0',
        description: 'Sync plugin',
        isDesktopOnly: false,
      };
    });

    it('initializes cleanly on desktop with status bar', async () => {
      Platform.isMobile = false;

      const plugin = new YandexDiskSyncPlugin(app as unknown as App, manifest);
      await plugin.onload();

      expect(plugin.settings).toBeDefined();
      expect(plugin.settings.oauthToken).toBe('');
      expect(plugin.statusBarItem).not.toBeNull();
      expect(plugin.statusBarItem?.hasClass('yd-sync-status-bar')).toBe(true);

      // Teardown
      plugin.onunload();
      expect(plugin.statusBarItem).toBeNull();
    });

    it('respects mobile guard: does NOT create status bar when Platform.isMobile is true', async () => {
      Platform.isMobile = true;

      const plugin = new YandexDiskSyncPlugin(app as unknown as App, manifest);
      await plugin.onload();

      expect(plugin.statusBarItem).toBeNull();

      plugin.onunload();
      Platform.isMobile = false; // Restore
    });

    it('updates settings and persists via saveData / loadData', async () => {
      const plugin = new YandexDiskSyncPlugin(app as unknown as App, manifest);
      await plugin.onload();

      plugin.settings.oauthToken = 'test-oauth-token-12345';
      plugin.settings.remoteFolder = 'MyNotes';
      await plugin.saveSettings();

      const newPlugin = new YandexDiskSyncPlugin(app as unknown as App, manifest);
      await newPlugin.onload();
      expect(newPlugin.settings.oauthToken).toBe('test-oauth-token-12345');
      expect(newPlugin.settings.remoteFolder).toBe('MyNotes');

      plugin.onunload();
      newPlugin.onunload();
    });

    it('renders settings tab without errors and clears container on display()', () => {
      const plugin = new YandexDiskSyncPlugin(app as unknown as App, manifest);
      const tab = new YandexDiskSyncSettingTab(app as unknown as App, plugin);

      tab.display();
      expect(tab.containerEl.children.length).toBeGreaterThan(0);

      // Calling display() again should empty and not duplicate elements
      const countFirst = tab.containerEl.children.length;
      tab.display();
      expect(tab.containerEl.children.length).toBe(countFirst);
    });

    it('handles sync triggers and validates OAuth token', async () => {
      const plugin = new YandexDiskSyncPlugin(app as unknown as App, manifest);
      await plugin.onload();

      // Trigger sync without token -> error status
      await plugin.triggerSync('manual');
      expect(plugin.statusBarItem?.hasClass('yd-sync-status-error')).toBe(true);

      // Provide token -> sync proceeds
      plugin.settings.oauthToken = 'valid-token';
      await plugin.triggerSync('manual');
      expect(plugin.statusBarItem?.hasClass('yd-sync-status-synced')).toBe(true);

      plugin.onunload();
    });
  });
});
