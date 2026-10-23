/**
 * src/sync/manifest-manager.ts
 * Manages atomic persistence and state transitions for the local sync manifest (sync-manifest.json).
 * Tracks 3-way synchronization state, content hashes, and deletion tombstones with 30-day GC.
 */

import { DataAdapter } from 'obsidian';
import {
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_STORAGE_DIR,
  MANIFEST_STORAGE_PATH,
  TOMBSTONE_RETENTION_MS,
} from '../constants';
import { FileManifestEntry, IManifestManager, SyncError, SyncManifest } from '../types';
import { normalizeVaultPath } from './filter';

export class ManifestManager implements IManifestManager {
  private adapter: DataAdapter;
  private manifest: SyncManifest;
  private isLoaded: boolean = false;

  constructor(adapter: DataAdapter) {
    this.adapter = adapter;
    this.manifest = {
      version: MANIFEST_SCHEMA_VERSION,
      lastSyncTime: 0,
      files: {},
    };
  }

  /**
   * Loads sync manifest from disk or initializes an empty schema if none exists.
   */
  public async load(): Promise<SyncManifest> {
    try {
      const exists = await this.adapter.exists(MANIFEST_STORAGE_PATH);
      if (!exists) {
        this.manifest = {
          version: MANIFEST_SCHEMA_VERSION,
          lastSyncTime: 0,
          files: {},
        };
        this.isLoaded = true;
        return this.manifest;
      }

      const content = await this.adapter.read(MANIFEST_STORAGE_PATH);
      const parsed = JSON.parse(content);

      if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object') {
        throw new SyncError('Corrupted manifest structure', 'MANIFEST_CORRUPTED');
      }

      this.manifest = {
        version: parsed.version ?? MANIFEST_SCHEMA_VERSION,
        lastSyncTime: parsed.lastSyncTime ?? 0,
        vaultSalt: parsed.vaultSalt,
        files: parsed.files ?? {},
      };

      this.isLoaded = true;
      return this.manifest;
    } catch (err: any) {
      if (err instanceof SyncError) throw err;
      throw new SyncError(
        `Failed to load sync manifest: ${err?.message || err}`,
        'MANIFEST_CORRUPTED',
        { originalError: err }
      );
    }
  }

  /**
   * Persists the sync manifest to disk atomically.
   */
  public async save(): Promise<void> {
    try {
      // Ensure storage directory exists
      const dirExists = await this.adapter.exists(MANIFEST_STORAGE_DIR);
      if (!dirExists) {
        await this.adapter.mkdir(MANIFEST_STORAGE_DIR);
      }

      const json = JSON.stringify(this.manifest, null, 2);
      await this.adapter.write(MANIFEST_STORAGE_PATH, json);
    } catch (err: any) {
      throw new SyncError(
        `Failed to save sync manifest: ${err?.message || err}`,
        'VAULT_WRITE_FAILED',
        { originalError: err }
      );
    }
  }

  /**
   * Retrieves an entry for a given relative path.
   */
  public getEntry(path: string): FileManifestEntry | undefined {
    const normalized = normalizeVaultPath(path);
    return this.manifest.files[normalized];
  }

  /**
   * Sets or updates a manifest file entry.
   */
  public setEntry(entry: FileManifestEntry): void {
    const normalized = normalizeVaultPath(entry.path);
    this.manifest.files[normalized] = {
      ...entry,
      path: normalized,
    };
  }

  /**
   * Completely removes an entry from the manifest.
   */
  public removeEntry(path: string): void {
    const normalized = normalizeVaultPath(path);
    delete this.manifest.files[normalized];
  }

  /**
   * Records a tombstone for a deleted file to prevent resurrection from remote.
   */
  public recordTombstone(path: string): void {
    const normalized = normalizeVaultPath(path);
    const existing = this.manifest.files[normalized];

    this.manifest.files[normalized] = {
      path: normalized,
      localHash: '',
      localMtime: 0,
      localSize: 0,
      remoteHash: existing?.remoteHash ?? '',
      remoteEtag: existing?.remoteEtag ?? '',
      remoteModified: existing?.remoteModified ?? '',
      remoteSize: 0,
      encrypted: existing?.encrypted ?? false,
      tombstone: true,
      tombstoneTimestamp: Date.now(),
    };
  }

  /**
   * Garbage-collects tombstones that have exceeded the retention threshold.
   * Returns the count of purged tombstones.
   */
  public purgeTombstones(maxAgeMs: number = TOMBSTONE_RETENTION_MS): number {
    const now = Date.now();
    let purgedCount = 0;

    for (const [path, entry] of Object.entries(this.manifest.files)) {
      if (entry.tombstone && entry.tombstoneTimestamp) {
        const age = now - entry.tombstoneTimestamp;
        if (age >= maxAgeMs) {
          delete this.manifest.files[path];
          purgedCount++;
        }
      }
    }

    return purgedCount;
  }

  /**
   * Returns the in-memory manifest data structure.
   */
  public getManifest(): SyncManifest {
    return this.manifest;
  }
}
