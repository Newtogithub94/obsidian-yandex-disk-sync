/**
 * src/constants.ts
 * System constants, default settings, cryptographic envelope definitions, and exclusion rules.
 */

import { YandexSyncSettings } from './types';

// ==========================================
// 1. Plugin Identification
// ==========================================

export const PLUGIN_ID = 'yandex-disk-sync';
export const PLUGIN_NAME = 'Yandex Disk Sync';
export const APP_FOLDER_NAME = 'ObsidianSync';

// ==========================================
// 2. Yandex Disk REST API & OAuth Constants
// ==========================================

export const YANDEX_API_BASE_URL = 'https://cloud-api.yandex.net/v1/disk';
export const YANDEX_RESOURCES_URL = `${YANDEX_API_BASE_URL}/resources`;
export const YANDEX_UPLOAD_URL = `${YANDEX_API_BASE_URL}/resources/upload`;
export const YANDEX_DOWNLOAD_URL = `${YANDEX_API_BASE_URL}/resources/download`;

/** Application sandbox folder URI prefix. Strict requirement under cloud_api:disk.app_folder scope. */
export const YANDEX_APP_FOLDER_PREFIX = 'app:/';
export const YANDEX_OAUTH_SCOPE = 'cloud_api:disk.app_folder';
export const YANDEX_OAUTH_AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=';

// ==========================================
// 3. Cryptographic Envelope & Cipher Constants
// ==========================================

export const ENVELOPE_MAGIC_STRING = 'OYDS';
export const ENVELOPE_MAGIC_BYTES = new Uint8Array([0x4F, 0x59, 0x44, 0x53]); // ASCII "OYDS"
export const ENVELOPE_VERSION = 1; // 0x01
export const CIPHER_ALGORITHM_AES_256_GCM = 1; // 0x01
export const PBKDF2_SALT_LENGTH = 16; // 16 bytes (128 bits)
export const AES_GCM_IV_LENGTH = 12; // 12 bytes (96 bits)
export const AES_GCM_TAG_LENGTH = 16; // 16 bytes (128 bits)
export const AES_KEY_BIT_LENGTH = 256; // 256 bits
export const PBKDF2_ITERATIONS = 100_000; // OWASP recommendation for PBKDF2-HMAC-SHA256
export const ENVELOPE_HEADER_LENGTH = 36; // 4 (magic) + 1 (ver) + 1 (algo) + 2 (reserved) + 16 (salt) + 12 (iv) = 36 bytes

// ==========================================
// 4. Default Exclusion Rules (RegExp)
// ==========================================

/**
 * Default patterns excluded from synchronization:
 * 1. .obsidian/workspace*.json: Mobile/Desktop layout state must not cross-pollinate.
 * 2. .trash: Obsidian local deleted notes cache.
 * 3. Plugin configuration & local manifests.
 * 4. OS desktop artifacts (.DS_Store, Thumbs.db, desktop.ini).
 * 5. Git repository directory and sync lock files.
 */
export const DEFAULT_EXCLUDED_PATTERNS: RegExp[] = [
  /(^|\/)(\.obsidian\/)?workspace(-mobile)?\.json$/i,
  /^\.trash(\/|$)/i,
  /^\.obsidian\/plugins\/yandex-disk-sync(\/|$)/i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)desktop\.ini$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.sync-lock$/i,
];

// ==========================================
// 5. Manifest Storage & Lifecycle Constants
// ==========================================

export const MANIFEST_FILE_NAME = 'sync-manifest.json';
export const MANIFEST_STORAGE_DIR = `.obsidian/plugins/${PLUGIN_ID}`;
export const MANIFEST_STORAGE_PATH = `${MANIFEST_STORAGE_DIR}/${MANIFEST_FILE_NAME}`;
export const MANIFEST_SCHEMA_VERSION = 1;

/** Retention duration for deletion tombstones before GC: 30 days in ms */
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ==========================================
// 6. Conflict Management Constants
// ==========================================

export const CONFLICT_TAG = 'conflict';
export const CONFLICT_FILE_REGEX = /\.conflict-(\d{8}-\d{6})/;
export const CONFLICT_NOTICE_TIMEOUT_MS = 10_000;

// ==========================================
// 7. Network Reliability, Timeouts & Backoff
// ==========================================

export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
export const RETRY_INITIAL_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 30_000;
export const RETRY_BACKOFF_FACTOR = 2.0;
export const RETRY_MAX_ATTEMPTS = 5;
export const RETRY_JITTER_RATIO = 0.2; // +/- 20% random jitter

export const HTTP_STATUS_OK = 200;
export const HTTP_STATUS_CREATED = 201;
export const HTTP_STATUS_NO_CONTENT = 204;
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_FORBIDDEN = 403;
export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_CONFLICT = 409;
export const HTTP_STATUS_RATE_LIMITED = 429;
export const HTTP_STATUS_SERVER_ERROR_MIN = 500;
export const HTTP_STATUS_SERVER_ERROR_MAX = 599;

// ==========================================
// 8. Default Plugin Settings
// ==========================================

export const DEFAULT_SETTINGS: YandexSyncSettings = {
  oauthToken: '',
  remoteFolder: '',
  autoSyncOnStartup: true,
  autoSyncIntervalMinutes: 15,
  interactiveSync: true,
  e2eeEnabled: false,
  e2eePassword: '',
  vaultSalt: '',
  customExcludedPatterns: [],
  lastSyncTimestamp: 0,
  debugLogging: false,
};
