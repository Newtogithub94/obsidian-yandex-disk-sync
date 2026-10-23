/**
 * src/sync/sync-orchestrator.ts
 * Coordinates the full end-to-end synchronization pipeline between Obsidian and Yandex Disk.
 * Handles scanning, diff calculation, E2EE encryption/decryption, conflict branch creation,
 * atomic vault operations, and manifest persistence.
 */

import { App, TFile, TFolder } from 'obsidian';
import {
  FileManifestEntry,
  ICryptoService,
  IManifestManager,
  ISyncOrchestrator,
  IYandexDiskClient,
  SyncAction,
  SyncPlan,
  SyncResult,
  SyncStatus,
  SyncStatusState,
  YandexResourceItem,
  YandexSyncSettings,
  SyncError,
} from '../types';
import { DiffEngine, LocalFileScan } from './diff-engine';
import { isPathExcluded, normalizeVaultPath } from './filter';
import { YANDEX_APP_FOLDER_PREFIX } from '../constants';
import { canonicalizeRemotePath } from '../api/yandex-disk-client';

function isTFile(file: any): file is TFile {
  return Boolean(file && (file instanceof TFile || ('stat' in file && 'basename' in file)));
}

function isTFolder(file: any): file is TFolder {
  return Boolean(file && (file instanceof TFolder || ('children' in file && !('stat' in file))));
}

export class SyncOrchestrator implements ISyncOrchestrator {
  private app: App;
  private settings: YandexSyncSettings;
  private client: IYandexDiskClient;
  private manifestManager: IManifestManager;
  private cryptoService: ICryptoService;
  private diffEngine: DiffEngine;

  private status: SyncStatus = {
    state: 'idle',
    message: 'Ready to synchronize.',
  };

  private aborted: boolean = false;
  private isRunning: boolean = false;
  private statusListeners: Array<(status: SyncStatus) => void> = [];

  constructor(
    app: App,
    settings: YandexSyncSettings,
    client: IYandexDiskClient,
    manifestManager: IManifestManager,
    cryptoService: ICryptoService
  ) {
    this.app = app;
    this.settings = settings;
    this.client = client;
    this.manifestManager = manifestManager;
    this.cryptoService = cryptoService;
    this.diffEngine = new DiffEngine();
  }

  public getStatus(): SyncStatus {
    return { ...this.status };
  }

  public cancel(): void {
    if (this.isRunning) {
      this.aborted = true;
      this.updateStatus('idle', 'Synchronization cancelled by user.');
    }
  }

  public onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== listener);
    };
  }

  private updateStatus(
    state: SyncStatusState,
    message: string,
    current?: number,
    total?: number
  ): void {
    this.status = {
      state,
      message,
      progressCurrent: current,
      progressTotal: total,
      lastSyncTime: this.status.lastSyncTime,
    };
    for (const listener of this.statusListeners) {
      try {
        listener(this.status);
      } catch {
        // Safe listener execution
      }
    }
  }

  /**
   * Constructs the full remote Yandex Disk path for a relative vault path.
   * e.g. "Notes/Work.md" -> "app:/ObsidianVault/Notes/Work.md"
   */
  private getRemotePath(vaultRelativePath: string): string {
    const subfolder = (this.settings.remoteFolder || '').trim().replace(/^\/+|\/+$/g, '');
    const cleanRelative = normalizeVaultPath(vaultRelativePath);

    if (subfolder.length > 0) {
      return `${YANDEX_APP_FOLDER_PREFIX}${subfolder}/${cleanRelative}`;
    }
    return `${YANDEX_APP_FOLDER_PREFIX}${cleanRelative}`;
  }

  /**
   * Converts a full remote Yandex Disk path back into a relative vault path.
   * e.g. "app:/ObsidianVault/Notes/Work.md" -> "Notes/Work.md"
   */
  private getVaultPathFromRemote(remotePath: string): string {
    let clean = canonicalizeRemotePath(remotePath);
    if (clean.startsWith(YANDEX_APP_FOLDER_PREFIX)) {
      clean = clean.substring(YANDEX_APP_FOLDER_PREFIX.length);
    } else if (clean.startsWith('app:')) {
      clean = clean.substring('app:'.length);
    }

    clean = clean.replace(/^\/+/, '');
    const subfolder = (this.settings.remoteFolder || '').trim().replace(/^\/+|\/+$/g, '');

    if (subfolder.length > 0 && clean.startsWith(subfolder)) {
      clean = clean.substring(subfolder.length).replace(/^\/+/, '');
    }

    return normalizeVaultPath(clean);
  }

  /**
   * Main synchronization execution entry point.
   */
  public async synchronize(
    filterActionsCallback?: (plan: SyncPlan) => Promise<SyncAction[] | null>
  ): Promise<SyncResult> {
    if (this.isRunning) {
      throw new SyncError('Synchronization is already in progress.', 'LOCK_ACQUISITION_TIMEOUT');
    }

    this.isRunning = true;
    this.aborted = false;
    const startTime = Date.now();

    const result: SyncResult = {
      success: true,
      startTime,
      endTime: 0,
      durationMs: 0,
      plan: {
        timestamp: startTime,
        actions: [],
        stats: { total: 0, uploads: 0, downloads: 0, deletions: 0, conflicts: 0, noops: 0, tombstonePurges: 0 },
      },
      uploadedFiles: [],
      downloadedFiles: [],
      deletedLocalFiles: [],
      deletedRemoteFiles: [],
      conflictFiles: [],
      errors: [],
    };

    try {
      // 1. Initialize E2EE if enabled
      if (this.settings.e2eeEnabled) {
        if (!this.settings.e2eePassword) {
          throw new SyncError(
            'E2EE is enabled but no master passphrase was supplied in settings.',
            'CRYPTO_PASSWORD_REQUIRED'
          );
        }
        const vaultSalt = await this.cryptoService.initializeKey(
          this.settings.e2eePassword,
          this.settings.vaultSalt
        );
        if (vaultSalt !== this.settings.vaultSalt) {
          this.settings.vaultSalt = vaultSalt;
        }
      }

      // 2. Load manifest
      this.updateStatus('scanning', 'Loading sync manifest...');
      await this.manifestManager.load();
      const baseManifest = this.manifestManager.getManifest();

      // 3. Scan local vault
      this.updateStatus('scanning', 'Scanning local vault files...');
      const localFiles = await this.scanLocalVault();

      if (this.aborted) throw new SyncError('Sync cancelled', 'NETWORK_TIMEOUT');

      // 4. Scan remote directory
      this.updateStatus('scanning', 'Scanning Yandex Disk remote files...');
      const remoteFiles = await this.scanRemoteStorage();

      if (this.aborted) throw new SyncError('Sync cancelled', 'NETWORK_TIMEOUT');

      // 5. Compute 3-way diff plan
      this.updateStatus('diffing', 'Calculating 3-way synchronization differences...');
      const plan = this.diffEngine.computeDiff({
        baseEntries: baseManifest.files,
        localFiles,
        remoteFiles,
      });
      result.plan = plan;

      // 5b. Interactive Review Step (if callback provided and actionable changes exist)
      let actionsToExecute: SyncAction[] = plan.actions;
      const actionableChanges = plan.actions.filter(
        (a) => a.type !== 'NO_OP' && a.type !== 'RETAIN_TOMBSTONE'
      );

      if (filterActionsCallback && actionableChanges.length > 0) {
        this.updateStatus('idle', 'Awaiting user review in modal...');
        const userApproved = await filterActionsCallback(plan);
        if (userApproved === null) {
          result.aborted = true;
          this.updateStatus('idle', 'Sync cancelled by user');
          return result;
        }
        const approvedSet = new Set(userApproved.map((a) => `${a.type}:${a.path}`));
        actionsToExecute = plan.actions.filter(
          (a) =>
            a.type === 'RETAIN_TOMBSTONE' ||
            a.type === 'NO_OP' ||
            approvedSet.has(`${a.type}:${a.path}`)
        );
      }

      // 6. Execute actions
      const totalActions = actionsToExecute.filter((a) => a.type !== 'NO_OP' && a.type !== 'RETAIN_TOMBSTONE').length;
      let completedActions = 0;

      for (const action of actionsToExecute) {
        if (this.aborted) break;

        try {
          await this.executeAction(action, result);
          if (action.type !== 'NO_OP' && action.type !== 'RETAIN_TOMBSTONE') {
            completedActions++;
            // Incremental flush: persist manifest every 5 actions so progress survives unexpected dropouts
            if (completedActions % 5 === 0) {
              await this.manifestManager.save();
            }
            this.updateStatus(
              'uploading',
              `Processing ${action.path}...`,
              completedActions,
              totalActions
            );
          }
        } catch (actionErr: any) {
          result.success = false;
          result.errors.push({
            path: action.path,
            action: action.type,
            message: actionErr?.message || String(actionErr),
            code: actionErr?.code,
            timestamp: Date.now(),
          });
        }
      }

      // 7. Purge expired tombstones
      this.manifestManager.purgeTombstones();

      // 8. Save updated manifest
      baseManifest.lastSyncTime = Date.now();
      await this.manifestManager.save();
      this.settings.lastSyncTimestamp = Date.now();

      const finalState: SyncStatusState = result.conflictFiles.length > 0
        ? 'conflict'
        : result.errors.length > 0
        ? 'error'
        : 'synced';

      const finalMsg = result.conflictFiles.length > 0
        ? `Sync finished with ${result.conflictFiles.length} conflict(s).`
        : result.errors.length > 0
        ? `Sync finished with ${result.errors.length} error(s).`
        : 'Synchronization completed successfully.';

      this.updateStatus(finalState, finalMsg);
      this.status.lastSyncTime = Date.now();
    } catch (fatalErr: any) {
      result.success = false;
      this.updateStatus('error', fatalErr?.message || 'Sync failed.');
      throw fatalErr;
    } finally {
      // Always flush any pending manifest mutations before releasing the lock
      try {
        await this.manifestManager.save();
      } catch {
        // Suppress secondary save errors in finally
      }
      this.isRunning = false;
      result.endTime = Date.now();
      result.durationMs = result.endTime - result.startTime;
    }

    return result;
  }

  /**
   * Scans local Obsidian vault and computes cryptographic hashes for non-excluded files.
   * Leverages fast-path mtime and size comparison with existing manifest entries to avoid
   * redundant I/O reads on Android and large vaults.
   */
  private async scanLocalVault(): Promise<Map<string, LocalFileScan>> {
    const localMap = new Map<string, LocalFileScan>();
    const allFiles = this.app.vault.getFiles();

    for (const file of allFiles) {
      const normalized = normalizeVaultPath(file.path);
      if (isPathExcluded(normalized, this.settings.customExcludedPatterns)) {
        continue;
      }

      // Fast-path: If file is in manifest, not a tombstone, and mtime + size match, reuse cached SHA-256 hash
      const cached = this.manifestManager.getEntry(normalized);
      if (
        cached &&
        !cached.tombstone &&
        cached.localMtime === file.stat.mtime &&
        cached.localSize === file.stat.size &&
        cached.localHash
      ) {
        localMap.set(normalized, {
          path: normalized,
          hash: cached.localHash,
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
        continue;
      }

      const binary = await this.app.vault.readBinary(file);
      const hash = await this.cryptoService.computeHash(binary);

      localMap.set(normalized, {
        path: normalized,
        hash,
        mtime: file.stat.mtime,
        size: file.stat.size,
      });
    }

    return localMap;
  }

  /**
   * Scans remote directory on Yandex Disk and returns map of normalized vault paths.
   */
  private async scanRemoteStorage(): Promise<Map<string, YandexResourceItem>> {
    const remoteMap = new Map<string, YandexResourceItem>();
    const subfolder = (this.settings.remoteFolder || '').trim().replace(/^\/+|\/+$/g, '');
    const remoteRoot = subfolder.length > 0
      ? `${YANDEX_APP_FOLDER_PREFIX}${subfolder}`
      : YANDEX_APP_FOLDER_PREFIX;

    // Ensure remote root folder exists
    await this.client.ensureDirectory(remoteRoot);

    const clientAny = this.client as any;
    let remoteItems: YandexResourceItem[] = [];

    if (typeof clientAny.listDirectoryRecursive === 'function') {
      remoteItems = await clientAny.listDirectoryRecursive(remoteRoot);
    } else {
      const res = await this.client.listDirectory(remoteRoot);
      remoteItems = res.items;
    }

    for (const item of remoteItems) {
      if (item.type !== 'file') continue;

      const vaultPath = this.getVaultPathFromRemote(item.path);
      if (!vaultPath || isPathExcluded(vaultPath, this.settings.customExcludedPatterns)) {
        continue;
      }

      remoteMap.set(vaultPath, item);
    }

    return remoteMap;
  }

  /**
   * Dispatches and executes an individual planned action.
   */
  private async executeAction(action: SyncAction, result: SyncResult): Promise<void> {
    const remotePath = this.getRemotePath(action.path);

    // Helper to find file by path or normalized fallback
    const findLocalFile = (targetPath: string): TFile | null => {
      const norm = normalizeVaultPath(targetPath);
      const direct = this.app.vault.getAbstractFileByPath(norm);
      if (isTFile(direct)) return direct;
      const all = this.app.vault.getFiles();
      return all.find((f) => normalizeVaultPath(f.path) === norm) ?? null;
    };

    switch (action.type) {
      case 'UPLOAD_LOCAL':
      case 'UPLOAD_LOCAL_MOD':
      case 'REVIVE_LOCAL': {
        const file = findLocalFile(action.path);
        if (!isTFile(file)) {
          throw new SyncError(`Local file not found: '${action.path}'`, 'VAULT_FILE_NOT_FOUND');
        }

        const rawContent = await this.app.vault.readBinary(file);
        const localHash = await this.cryptoService.computeHash(rawContent);

        let uploadPayload = rawContent;
        let isEncrypted = false;

        if (this.settings.e2eeEnabled) {
          uploadPayload = await this.cryptoService.encrypt(rawContent);
          isEncrypted = true;
        }

        const uploadRes: any = await this.client.uploadFile(remotePath, uploadPayload, true);

        const remoteHash = isEncrypted
          ? await this.cryptoService.computeHash(uploadPayload)
          : localHash;

        this.manifestManager.setEntry({
          path: action.path,
          localHash,
          localMtime: file.stat.mtime,
          localSize: file.stat.size,
          remoteHash,
          remoteEtag: uploadRes?.etag ?? 'etag-synced',
          remoteModified: new Date().toISOString(),
          remoteSize: uploadPayload.byteLength,
          encrypted: isEncrypted,
          tombstone: false,
          tombstoneTimestamp: null,
        });

        result.uploadedFiles.push(action.path);
        break;
      }

      case 'DOWNLOAD_REMOTE':
      case 'RESTORE_REMOTE_MOD':
      case 'REVIVE_REMOTE': {
        const downloadedBuf = await this.client.downloadFile(remotePath);
        let finalContent = downloadedBuf;
        let isEncrypted = false;

        if (this.cryptoService.isEncrypted(downloadedBuf)) {
          finalContent = await this.cryptoService.decrypt(downloadedBuf);
          isEncrypted = true;
        }

        // R2: Pre-Write CAS Check (protect against concurrent mid-sync local edits)
        const existingLocal = findLocalFile(action.path);
        if (isTFile(existingLocal)) {
          const currentBuf = await this.app.vault.readBinary(existingLocal);
          const currentHash = await this.cryptoService.computeHash(currentBuf);
          const expectedHash = action.localFile?.hash ?? action.baseEntry?.localHash;

          // If expectedHash existed and file changed locally during sync, OR if a new file appeared unexpectedly:
          if ((expectedHash && currentHash !== expectedHash) || (!expectedHash && currentHash)) {
            const downloadedHash = await this.cryptoService.computeHash(finalContent);
            if (currentHash === downloadedHash) {
              // Contents are identical: converge manifest without overwriting
              this.manifestManager.setEntry({
                path: action.path,
                localHash: currentHash,
                localMtime: existingLocal.stat.mtime,
                localSize: existingLocal.stat.size,
                remoteHash: isEncrypted ? await this.cryptoService.computeHash(downloadedBuf) : downloadedHash,
                remoteEtag: action.remoteResource?.etag ?? `etag-${Date.now()}`,
                remoteModified: action.remoteResource?.modified ?? new Date().toISOString(),
                remoteSize: downloadedBuf.byteLength,
                encrypted: isEncrypted,
                tombstone: false,
                tombstoneTimestamp: null,
              });
              break;
            }

            // User edited the file while downloading: divert remote copy to conflict file!
            const conflictPath = DiffEngine.generateConflictPath(action.path);
            await this.atomicWriteToVault(conflictPath, finalContent);
            result.conflictFiles.push(conflictPath);
            break;
          }
        }

        await this.atomicWriteToVault(action.path, finalContent);

        const localHash = await this.cryptoService.computeHash(finalContent);
        const remoteHash = isEncrypted
          ? await this.cryptoService.computeHash(downloadedBuf)
          : localHash;

        const fsStat = await this.app.vault.adapter.stat(normalizeVaultPath(action.path));
        const writtenFile = findLocalFile(action.path);
        const localMtime = fsStat?.mtime ?? (isTFile(writtenFile) ? writtenFile.stat.mtime : Date.now());
        const localSize = fsStat?.size ?? finalContent.byteLength;

        this.manifestManager.setEntry({
          path: action.path,
          localHash,
          localMtime,
          localSize,
          remoteHash,
          remoteEtag: action.remoteResource?.etag ?? `etag-${Date.now()}`,
          remoteModified: action.remoteResource?.modified ?? new Date().toISOString(),
          remoteSize: downloadedBuf.byteLength,
          encrypted: isEncrypted,
          tombstone: false,
          tombstoneTimestamp: null,
        });

        result.downloadedFiles.push(action.path);
        break;
      }

      case 'CONFLICT_COPY':
      case 'REVIVE_BOTH': {
        // Zero data loss: keep local file intact, download remote to conflict path!
        const downloadedBuf = await this.client.downloadFile(remotePath);
        let conflictContent = downloadedBuf;
        let isEncrypted = false;

        if (this.cryptoService.isEncrypted(downloadedBuf)) {
          conflictContent = await this.cryptoService.decrypt(downloadedBuf);
          isEncrypted = true;
        }

        // R3: Content-Aware E2EE & Payload Convergence Check
        // In E2EE mode, random AES-GCM IVs produce different ciphertexts for identical plaintext.
        // Compare the decrypted remote plaintext hash with the current local file hash.
        const existingLocal = findLocalFile(action.path);
        let currentLocalHash = action.localFile?.hash;
        if (isTFile(existingLocal)) {
          const currentBuf = await this.app.vault.readBinary(existingLocal);
          currentLocalHash = await this.cryptoService.computeHash(currentBuf);
        }

        const remotePlaintextHash = await this.cryptoService.computeHash(conflictContent);

        if (currentLocalHash && remotePlaintextHash.toLowerCase() === currentLocalHash.toLowerCase()) {
          // Plaintexts are identical: converge manifest without creating redundant conflict file!
          const remoteCipherHash = isEncrypted
            ? await this.cryptoService.computeHash(downloadedBuf)
            : remotePlaintextHash;

          const fsStat = await this.app.vault.adapter.stat(normalizeVaultPath(action.path));
          this.manifestManager.setEntry({
            path: action.path,
            localHash: currentLocalHash,
            localMtime: fsStat?.mtime ?? (isTFile(existingLocal) ? existingLocal.stat.mtime : Date.now()),
            localSize: fsStat?.size ?? (isTFile(existingLocal) ? existingLocal.stat.size : conflictContent.byteLength),
            remoteHash: remoteCipherHash,
            remoteEtag: action.remoteResource?.etag ?? `etag-${Date.now()}`,
            remoteModified: action.remoteResource?.modified ?? new Date().toISOString(),
            remoteSize: downloadedBuf.byteLength,
            encrypted: isEncrypted,
            tombstone: false,
            tombstoneTimestamp: null,
          });
          break;
        }

        const conflictPath = action.conflictPath || DiffEngine.generateConflictPath(action.path);
        await this.atomicWriteToVault(conflictPath, conflictContent);

        result.conflictFiles.push(conflictPath);
        break;
      }

      case 'DELETE_REMOTE': {
        await this.client.deleteResource(remotePath);
        this.manifestManager.recordTombstone(action.path);
        result.deletedRemoteFiles.push(action.path);
        break;
      }

      case 'DELETE_LOCAL': {
        const file = findLocalFile(action.path);
        if (isTFile(file)) {
          const currentBuf = await this.app.vault.readBinary(file);
          const currentHash = await this.cryptoService.computeHash(currentBuf);
          const expectedHash = action.localFile?.hash ?? action.baseEntry?.localHash;

          // Pre-Write CAS Check on Local Deletions:
          // If the user modified the file locally while remote deletion was pending,
          // local edits take precedence over remote deletion: convert dynamically to UPLOAD_LOCAL_MOD (State 12)
          if (expectedHash && currentHash !== expectedHash) {
            let uploadPayload = currentBuf;
            let isEncrypted = false;

            if (this.settings.e2eeEnabled) {
              uploadPayload = await this.cryptoService.encrypt(currentBuf);
              isEncrypted = true;
            }

            const uploadRes: any = await this.client.uploadFile(remotePath, uploadPayload, true);
            const remoteHash = isEncrypted
              ? await this.cryptoService.computeHash(uploadPayload)
              : currentHash;

            const fsStat = await this.app.vault.adapter.stat(normalizeVaultPath(action.path));
            this.manifestManager.setEntry({
              path: action.path,
              localHash: currentHash,
              localMtime: fsStat?.mtime ?? file.stat.mtime,
              localSize: fsStat?.size ?? currentBuf.byteLength,
              remoteHash,
              remoteEtag: uploadRes?.etag ?? 'etag-synced',
              remoteModified: new Date().toISOString(),
              remoteSize: uploadPayload.byteLength,
              encrypted: isEncrypted,
              tombstone: false,
              tombstoneTimestamp: null,
            });

            result.uploadedFiles.push(action.path);
            break;
          }

          await this.app.vault.delete(file, false);
        }
        this.manifestManager.recordTombstone(action.path);
        result.deletedLocalFiles.push(action.path);
        break;
      }

      case 'CONVERGE_DELETE': {
        this.manifestManager.recordTombstone(action.path);
        break;
      }

      case 'PURGE_TOMBSTONE': {
        this.manifestManager.removeEntry(action.path);
        break;
      }

      case 'CONVERGE': {
        if (action.localFile?.hash) {
          const existing = this.manifestManager.getEntry(action.path);
          const fsStat = await this.app.vault.adapter.stat(normalizeVaultPath(action.path));
          this.manifestManager.setEntry({
            path: action.path,
            localHash: action.localFile.hash,
            localMtime: fsStat?.mtime ?? action.localFile.mtime ?? Date.now(),
            localSize: fsStat?.size ?? action.localFile.size ?? 0,
            remoteHash: action.remoteResource?.sha256 ?? existing?.remoteHash ?? action.localFile.hash,
            remoteEtag: action.remoteResource?.etag ?? existing?.remoteEtag ?? 'etag-synced',
            remoteModified: action.remoteResource?.modified ?? existing?.remoteModified ?? new Date().toISOString(),
            remoteSize: action.remoteResource?.size ?? existing?.remoteSize ?? action.localFile.size ?? 0,
            encrypted: Boolean(existing?.encrypted),
            tombstone: false,
            tombstoneTimestamp: null,
          });
        }
        break;
      }

      case 'NO_OP':
      case 'RETAIN_TOMBSTONE':
      default:
        break;
    }
  }

  /**
   * Writes content to a file in the Obsidian vault atomically, creating
   * any missing parent folders along the path.
   */
  private async atomicWriteToVault(path: string, content: ArrayBuffer): Promise<void> {
    const normalized = normalizeVaultPath(path);
    const slashIdx = normalized.lastIndexOf('/');

    if (slashIdx !== -1) {
      const parentDir = normalized.substring(0, slashIdx);
      await this.ensureLocalFolder(parentDir);
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (isTFile(existing)) {
      await this.app.vault.modifyBinary(existing, content);
    } else {
      await this.app.vault.createBinary(normalized, content);
    }
  }

  /**
   * Recursively ensures that a local vault directory exists.
   */
  private async ensureLocalFolder(folderPath: string): Promise<void> {
    const normalized = normalizeVaultPath(folderPath);
    if (!normalized) return;

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (isTFolder(existing)) {
      return;
    }

    const segments = normalized.split('/');
    let current = '';

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const folder = this.app.vault.getAbstractFileByPath(current);
      if (!folder) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Ignore if concurrently created
        }
      }
    }
  }
}
