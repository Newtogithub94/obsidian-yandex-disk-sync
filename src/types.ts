/**
 * src/types.ts
 * Authoritative domain models and interface contracts for Obsidian Yandex Disk Sync.
 */

// ==========================================
// 1. Plugin Settings
// ==========================================

export interface YandexSyncSettings {
  /** OAuth access token obtained from Yandex OAuth */
  oauthToken: string;

  /** Target subfolder within the sandboxed app folder (empty string = root app:/) */
  remoteFolder: string;

  /** Whether to initiate sync automatically upon plugin load / vault open */
  autoSyncOnStartup: boolean;

  /** Periodic sync interval in minutes. 0 indicates manual-only sync. */
  autoSyncIntervalMinutes: number;

  /** Whether client-side End-to-End Encryption (AES-256-GCM) is enabled */
  e2eeEnabled: boolean;

  /** Master passphrase used for PBKDF2 key derivation */
  e2eePassword: string;

  /** Random salt generated for PBKDF2 vault derivation (hex string) */
  vaultSalt: string;

  /** User-defined exclusion regex patterns in addition to default system exclusions */
  customExcludedPatterns: string[];

  /** Timestamp (epoch ms) of the last successful sync cycle */
  lastSyncTimestamp: number;

  /** Whether to prompt user with an interactive diff review modal before applying sync actions */
  interactiveSync: boolean;

  /** Whether verbose debug logging is enabled in developer console */
  debugLogging: boolean;
}

// ==========================================
// 2. Manifest Models
// ==========================================

export interface FileManifestEntry {
  /** Normalized relative vault path using forward slashes (e.g. "Notes/Work.md") */
  path: string;

  /** Cryptographic SHA-256 hash of the local plaintext content (hex string) */
  localHash: string;

  /** Local modification time (epoch ms) from Obsidian Stat. Used solely for dirty-check cache optimization. */
  localMtime: number;

  /** Local file size in bytes from Obsidian Stat. Used solely for dirty-check cache optimization. */
  localSize: number;

  /** Remote file SHA-256 hash (or ciphertext hash if E2EE is enabled). */
  remoteHash: string;

  /** Remote revision/ETag string reported by Yandex Disk */
  remoteEtag: string;

  /** Remote modification timestamp as reported by Yandex Disk (ISO 8601 string) */
  remoteModified: string;

  /** Remote file size in bytes */
  remoteSize: number;

  /** Whether the file is stored in encrypted form (OYDS envelope) on Yandex Disk */
  encrypted: boolean;

  /** Whether this entry represents a deleted resource awaiting propagation/GC */
  tombstone: boolean;

  /** Timestamp (epoch ms) when the tombstone was marked, or null if active */
  tombstoneTimestamp: number | null;
}

export interface SyncManifest {
  /** Schema version of the manifest file format (currently 1) */
  version: number;

  /** Timestamp (epoch ms) of the last completed sync cycle */
  lastSyncTime: number;

  /** Vault-wide salt used for PBKDF2 key derivation (hex string) */
  vaultSalt?: string;

  /** Dictionary mapping normalized relative file paths to their manifest entries */
  files: Record<string, FileManifestEntry>;
}

// ==========================================
// 3. Yandex Disk REST API Models
// ==========================================

export type YandexResourceType = 'file' | 'dir';

export interface YandexResourceItem {
  name: string;
  path: string; // e.g. "app:/Folder/file.md"
  type: YandexResourceType;
  size?: number;
  sha256?: string;
  md5?: string;
  etag?: string;
  modified?: string; // ISO 8601
  created?: string;  // ISO 8601
  mime_type?: string;
}

export interface YandexResourceList {
  path: string;
  items: YandexResourceItem[];
  limit: number;
  offset: number;
  total: number;
}

export interface YandexDiskInfo {
  user: {
    login: string;
    uid: string;
    display_name?: string;
  };
  total_space: number;
  used_space: number;
  trash_size: number;
}

export interface YandexUploadLink {
  href: string;
  method: string;
  templated?: boolean;
}

export interface YandexDownloadLink {
  href: string;
  method: string;
  templated?: boolean;
}

// ==========================================
// 4. 3-Way Sync Diff & Action Models
// ==========================================

export type SyncStatusState =
  | 'idle'
  | 'scanning'
  | 'diffing'
  | 'uploading'
  | 'downloading'
  | 'deleting'
  | 'synced'
  | 'conflict'
  | 'error';

export interface SyncStatus {
  state: SyncStatusState;
  message: string;
  progressCurrent?: number;
  progressTotal?: number;
  lastSyncTime?: number;
}

export type SyncActionType =
  | 'UPLOAD_LOCAL'             // Local new/modified -> upload to remote
  | 'DOWNLOAD_REMOTE'          // Remote new/modified -> download to local
  | 'DELETE_REMOTE'            // Local deleted -> delete on remote, record tombstone
  | 'DELETE_LOCAL'             // Remote deleted -> delete local file, record tombstone
  | 'CONFLICT_COPY'            // Concurrent edits -> keep local, download remote as .conflict-...
  | 'CONVERGE'                 // Equal content on both -> sync manifest hashes without transfer
  | 'NO_OP'                    // Neither changed -> nothing to do
  | 'RESTORE_REMOTE_MOD'       // Local delete vs Remote modified -> remote edits win, restore local
  | 'UPLOAD_LOCAL_MOD'         // Local modified vs Remote deleted -> local edits win, re-upload
  | 'CONVERGE_DELETE'          // Deleted on both sides -> tombstone retain
  | 'RETAIN_TOMBSTONE'         // Tombstone age < 30 days -> keep tombstone
  | 'PURGE_TOMBSTONE'          // Tombstone age >= 30 days -> remove from manifest
  | 'REVIVE_LOCAL'             // Recreated locally after deletion -> re-upload, clear tombstone
  | 'REVIVE_REMOTE'            // Recreated remotely after deletion -> download, clear tombstone
  | 'REVIVE_BOTH';             // Recreated on both sides -> apply collision rules

export interface SyncAction {
  type: SyncActionType;
  path: string;
  conflictPath?: string;
  reason: string;
  baseEntry?: FileManifestEntry;
  localFile?: {
    path: string;
    hash?: string;
    mtime?: number;
    size?: number;
  };
  remoteResource?: YandexResourceItem;
}

export interface SyncPlan {
  timestamp: number;
  actions: SyncAction[];
  stats: {
    total: number;
    uploads: number;
    downloads: number;
    deletions: number;
    conflicts: number;
    noops: number;
    tombstonePurges: number;
  };
}

export interface SyncErrorItem {
  path?: string;
  action?: SyncActionType;
  message: string;
  code?: string;
  timestamp: number;
}

export interface SyncResult {
  success: boolean;
  startTime: number;
  endTime: number;
  durationMs: number;
  plan: SyncPlan;
  uploadedFiles: string[];
  downloadedFiles: string[];
  deletedLocalFiles: string[];
  deletedRemoteFiles: string[];
  conflictFiles: string[];
  errors: SyncErrorItem[];
  aborted?: boolean;
}

// ==========================================
// 5. Cryptographic Models & Envelope
// ==========================================

export interface EnvelopeHeader {
  magic: string;          // "OYDS"
  version: number;        // 1
  cipherAlgo: number;     // 1 (AES-256-GCM)
  reserved: number;       // 0
  salt: Uint8Array;       // 16 bytes PBKDF2 salt
  iv: Uint8Array;         // 12 bytes AES-GCM IV/nonce
}

export interface EncryptedPayload {
  header: EnvelopeHeader;
  rawHeader: Uint8Array;  // 36-byte binary header (also used as AAD)
  ciphertext: Uint8Array; // Ciphertext + 16-byte GCM authentication tag
  buffer: ArrayBuffer;    // Complete continuous ArrayBuffer ready for disk/network
}

export interface ICryptoService {
  initializeKey(passphrase: string, vaultSalt?: string): Promise<string>;
  encrypt(plaintext: ArrayBuffer): Promise<ArrayBuffer>;
  decrypt(envelope: ArrayBuffer): Promise<ArrayBuffer>;
  isEncrypted(buffer: ArrayBuffer): boolean;
  computeHash(data: ArrayBuffer): Promise<string>;
  getSalt(): string | undefined;
}

// ==========================================
// 6. Service Contracts
// ==========================================

export interface IYandexDiskClient {
  testConnection(): Promise<YandexDiskInfo>;
  listDirectory(remotePath: string): Promise<YandexResourceList>;
  ensureDirectory(remotePath: string): Promise<void>;
  uploadFile(remotePath: string, content: ArrayBuffer, overwrite?: boolean): Promise<void>;
  downloadFile(remotePath: string): Promise<ArrayBuffer>;
  deleteResource(remotePath: string): Promise<void>;
}

export interface IManifestManager {
  load(): Promise<SyncManifest>;
  save(): Promise<void>;
  getEntry(path: string): FileManifestEntry | undefined;
  setEntry(entry: FileManifestEntry): void;
  removeEntry(path: string): void;
  recordTombstone(path: string): void;
  purgeTombstones(maxAgeMs?: number): number;
  getManifest(): SyncManifest;
}

export interface ISyncOrchestrator {
  synchronize(
    filterActionsCallback?: (plan: SyncPlan) => Promise<SyncAction[] | null>
  ): Promise<SyncResult>;
  cancel(): void;
  getStatus(): SyncStatus;
}

// ==========================================
// 7. Domain Error Hierarchy
// ==========================================

export type SyncErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'NETWORK_OFFLINE'
  | 'NETWORK_TIMEOUT'
  | 'RATE_LIMITED'
  | 'REMOTE_FORBIDDEN'
  | 'REMOTE_NOT_FOUND'
  | 'REMOTE_CONFLICT'
  | 'REMOTE_SERVER_ERROR'
  | 'CRYPTO_PASSWORD_REQUIRED'
  | 'CRYPTO_INVALID_PASSWORD'
  | 'CRYPTO_CORRUPTED_ENVELOPE'
  | 'CRYPTO_UNSUPPORTED_VERSION'
  | 'CRYPTO_TAG_VERIFICATION_FAILED'
  | 'VAULT_FILE_NOT_FOUND'
  | 'VAULT_WRITE_FAILED'
  | 'MANIFEST_CORRUPTED'
  | 'LOCK_ACQUISITION_TIMEOUT';

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly recoverable: boolean;
  readonly path?: string;
  readonly originalError?: unknown;

  constructor(
    message: string,
    code: SyncErrorCode,
    options?: {
      recoverable?: boolean;
      path?: string;
      originalError?: unknown;
    }
  ) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    this.path = options?.path;
    this.originalError = options?.originalError;
  }
}
