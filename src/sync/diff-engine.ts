/**
 * src/sync/diff-engine.ts
 * Deterministic 16-state 3-way synchronization diffing engine.
 * Immune to clock drift between Windows and Android; relies strictly on cryptographic
 * content hashes, remote ETags, and deletion tombstones.
 */

import {
  FileManifestEntry,
  SyncAction,
  SyncPlan,
  YandexResourceItem,
} from '../types';
import { TOMBSTONE_RETENTION_MS } from '../constants';
import { normalizeVaultPath } from './filter';

export interface LocalFileScan {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

export interface DiffInput {
  baseEntries: Record<string, FileManifestEntry>;
  localFiles: Map<string, LocalFileScan>;
  remoteFiles: Map<string, YandexResourceItem>;
}

export class DiffEngine {
  /**
   * Generates a conflict filename following the canonical pattern:
   * "folder/note.conflict-YYYYMMDD-HHmmss.md"
   */
  public static generateConflictPath(path: string, timestamp: number = Date.now()): string {
    const normalized = normalizeVaultPath(path);
    const date = new Date(timestamp);

    const pad = (n: number) => String(n).padStart(2, '0');
    const YYYY = date.getFullYear();
    const MM = pad(date.getMonth() + 1);
    const DD = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());

    const tag = `${YYYY}${MM}${DD}-${hh}${mm}${ss}`;

    const dotIndex = normalized.lastIndexOf('.');
    const slashIndex = normalized.lastIndexOf('/');

    if (dotIndex > slashIndex && dotIndex !== -1) {
      const base = normalized.substring(0, dotIndex);
      const ext = normalized.substring(dotIndex);
      return `${base}.conflict-${tag}${ext}`;
    }

    return `${normalized}.conflict-${tag}`;
  }

  /**
   * Evaluates the 16-state decision matrix across all discovered paths.
   */
  public computeDiff(input: DiffInput): SyncPlan {
    const { baseEntries, localFiles, remoteFiles } = input;
    const actions: SyncAction[] = [];

    // Collect the union of all known paths from Base, Local, and Remote
    const allPaths = new Set<string>();

    for (const p of Object.keys(baseEntries)) allPaths.add(normalizeVaultPath(p));
    for (const p of localFiles.keys()) allPaths.add(normalizeVaultPath(p));
    for (const p of remoteFiles.keys()) allPaths.add(normalizeVaultPath(p));

    const now = Date.now();
    const stats = {
      total: 0,
      uploads: 0,
      downloads: 0,
      deletions: 0,
      conflicts: 0,
      noops: 0,
      tombstonePurges: 0,
    };

    for (const path of allPaths) {
      const base = baseEntries[path];
      const local = localFiles.get(path);
      const remote = remoteFiles.get(path);

      const hasBase = Boolean(base && !base.tombstone);
      const isTombstone = Boolean(base?.tombstone);
      const hasLocal = Boolean(local);
      const hasRemote = Boolean(remote);

      // -------------------------------------------------------------
      // Case A: Tombstone Active in Manifest
      // -------------------------------------------------------------
      if (isTombstone) {
        if (!hasLocal && !hasRemote) {
          const age = now - (base!.tombstoneTimestamp ?? 0);
          if (age >= TOMBSTONE_RETENTION_MS) {
            actions.push({
              type: 'PURGE_TOMBSTONE',
              path,
              reason: 'Tombstone age exceeded 30-day retention threshold; purge from manifest.',
              baseEntry: base,
            });
            stats.tombstonePurges++;
          } else {
            actions.push({
              type: 'RETAIN_TOMBSTONE',
              path,
              reason: 'Tombstone active; neither side present; retain for propagation.',
              baseEntry: base,
            });
            stats.noops++;
          }
        } else if (hasLocal && !hasRemote) {
          actions.push({
            type: 'REVIVE_LOCAL',
            path,
            reason: 'File recreated locally after deletion; upload and clear tombstone.',
            baseEntry: base,
            localFile: local,
          });
          stats.uploads++;
        } else if (!hasLocal && hasRemote) {
          actions.push({
            type: 'REVIVE_REMOTE',
            path,
            reason: 'File recreated remotely after deletion; download and clear tombstone.',
            baseEntry: base,
            remoteResource: remote,
          });
          stats.downloads++;
        } else if (hasLocal && hasRemote) {
          actions.push({
            type: 'REVIVE_BOTH',
            path,
            conflictPath: DiffEngine.generateConflictPath(path, now),
            reason: 'File recreated on both sides concurrently after deletion; resolve collision.',
            baseEntry: base,
            localFile: local,
            remoteResource: remote,
          });
          stats.conflicts++;
        }
        continue;
      }

      // -------------------------------------------------------------
      // Case B: No Base Manifest (Newly added files)
      // -------------------------------------------------------------
      if (!hasBase) {
        if (hasLocal && !hasRemote) {
          actions.push({
            type: 'UPLOAD_LOCAL',
            path,
            reason: 'New file created locally; upload to remote.',
            localFile: local,
          });
          stats.uploads++;
        } else if (!hasLocal && hasRemote) {
          actions.push({
            type: 'DOWNLOAD_REMOTE',
            path,
            reason: 'New file discovered on remote; download to local vault.',
            remoteResource: remote,
          });
          stats.downloads++;
        } else if (hasLocal && hasRemote) {
          // Both created new file at the same path
          // If remote hash is available and matches local hash:
          const remoteHashMatch =
            remote?.sha256 && local?.hash && remote.sha256.toLowerCase() === local.hash.toLowerCase();

          if (remoteHashMatch) {
            actions.push({
              type: 'CONVERGE',
              path,
              reason: 'Identical file created independently on both sides; synchronize manifest.',
              localFile: local,
              remoteResource: remote,
            });
            stats.noops++;
          } else {
            actions.push({
              type: 'CONFLICT_COPY',
              path,
              conflictPath: DiffEngine.generateConflictPath(path, now),
              reason: 'Different files created independently on both sides; create conflict copy.',
              localFile: local,
              remoteResource: remote,
            });
            stats.conflicts++;
          }
        }
        continue;
      }

      // -------------------------------------------------------------
      // Case C: Base Manifest Exists
      // -------------------------------------------------------------
      const localChanged = Boolean(hasLocal && local!.hash !== base!.localHash);
      const remoteChanged = Boolean(
        hasRemote &&
          (remote!.sha256
            ? remote!.sha256.toLowerCase() !== base!.remoteHash.toLowerCase()
            : remote!.etag !== base!.remoteEtag)
      );

      if (hasLocal && hasRemote) {
        if (!localChanged && !remoteChanged) {
          actions.push({
            type: 'NO_OP',
            path,
            reason: 'Unmodified on both sides.',
            baseEntry: base,
            localFile: local,
            remoteResource: remote,
          });
          stats.noops++;
        } else if (localChanged && !remoteChanged) {
          actions.push({
            type: 'UPLOAD_LOCAL',
            path,
            reason: 'Modified locally, unchanged on remote; upload local changes.',
            baseEntry: base,
            localFile: local,
            remoteResource: remote,
          });
          stats.uploads++;
        } else if (!localChanged && remoteChanged) {
          actions.push({
            type: 'DOWNLOAD_REMOTE',
            path,
            reason: 'Unchanged locally, modified on remote; download remote changes.',
            baseEntry: base,
            localFile: local,
            remoteResource: remote,
          });
          stats.downloads++;
        } else {
          // Concurrent modification on both sides!
          const sameHash =
            remote?.sha256 && local?.hash && remote.sha256.toLowerCase() === local.hash.toLowerCase();

          if (sameHash) {
            actions.push({
              type: 'CONVERGE',
              path,
              reason: 'Modified on both sides to identical content; converge state.',
              baseEntry: base,
              localFile: local,
              remoteResource: remote,
            });
            stats.noops++;
          } else {
            actions.push({
              type: 'CONFLICT_COPY',
              path,
              conflictPath: DiffEngine.generateConflictPath(path, now),
              reason: 'Concurrent modifications on both sides; preserve local and write conflict copy.',
              baseEntry: base,
              localFile: local,
              remoteResource: remote,
            });
            stats.conflicts++;
          }
        }
      } else if (!hasLocal && hasRemote) {
        // Local missing
        if (!remoteChanged) {
          // Deleted locally, untouched on remote
          actions.push({
            type: 'DELETE_REMOTE',
            path,
            reason: 'Deleted locally, unmodified on remote; delete from remote storage.',
            baseEntry: base,
            remoteResource: remote,
          });
          stats.deletions++;
        } else {
          // Deleted locally, but edited on remote -> remote modification wins!
          actions.push({
            type: 'RESTORE_REMOTE_MOD',
            path,
            reason: 'Deleted locally but modified on remote; remote edit takes precedence.',
            baseEntry: base,
            remoteResource: remote,
          });
          stats.downloads++;
        }
      } else if (hasLocal && !hasRemote) {
        // Remote missing
        if (!localChanged) {
          // Untouched locally, deleted on remote
          actions.push({
            type: 'DELETE_LOCAL',
            path,
            reason: 'Unmodified locally, deleted on remote; delete local copy.',
            baseEntry: base,
            localFile: local,
          });
          stats.deletions++;
        } else {
          // Modified locally, deleted on remote -> local edit wins!
          actions.push({
            type: 'UPLOAD_LOCAL_MOD',
            path,
            reason: 'Modified locally but deleted on remote; local edit takes precedence.',
            baseEntry: base,
            localFile: local,
          });
          stats.uploads++;
        }
      } else if (!hasLocal && !hasRemote) {
        // Deleted on both sides
        actions.push({
          type: 'CONVERGE_DELETE',
          path,
          reason: 'Deleted on both sides; record tombstone.',
          baseEntry: base,
        });
        stats.deletions++;
      }
    }

    stats.total = actions.length;

    return {
      timestamp: now,
      actions,
      stats,
    };
  }
}
