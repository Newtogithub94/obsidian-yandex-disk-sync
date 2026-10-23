/**
 * tests/mocks/mock-yandex-disk.ts
 * In-memory Yandex Disk REST API mock server with app:/ sandboxing and fault injection.
 */

import { YandexResourceItem, YandexDiskInfo, YandexResourceList } from '../../src/types';
import { YANDEX_APP_FOLDER_PREFIX } from '../../src/constants';

interface RemoteFileEntry {
  data: Uint8Array;
  sha256: string;
  md5: string;
  size: number;
  etag: string;
  modified: string;
  created: string;
}

export class MockYandexDiskServer {
  private remoteFiles = new Map<string, RemoteFileEntry>();
  private remoteFolders = new Set<string>();
  private failNextNRequests = 0;
  private failStatusCode = 500;
  private rateLimitRemaining = 0;

  constructor() {
    this.remoteFolders.add(YANDEX_APP_FOLDER_PREFIX);
  }

  private validateSandboxedPath(remotePath: string): string {
    if (!remotePath.startsWith(YANDEX_APP_FOLDER_PREFIX)) {
      throw new Error(`Forbidden: Path '${remotePath}' must start with '${YANDEX_APP_FOLDER_PREFIX}'`);
    }
    return remotePath.replace(/\\/g, '/');
  }

  injectFailures(count: number, statusCode: number = 500): void {
    this.failNextNRequests = count;
    this.failStatusCode = statusCode;
  }

  injectRateLimit(count: number): void {
    this.rateLimitRemaining = count;
  }

  private checkFailure(): void {
    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining--;
      const err: any = new Error('Rate limit exceeded');
      err.status = 429;
      throw err;
    }
    if (this.failNextNRequests > 0) {
      this.failNextNRequests--;
      const err: any = new Error(`Simulated HTTP ${this.failStatusCode}`);
      err.status = this.failStatusCode;
      throw err;
    }
  }

  async getDiskInfo(): Promise<YandexDiskInfo> {
    this.checkFailure();
    let totalUsed = 0;
    for (const entry of this.remoteFiles.values()) {
      totalUsed += entry.size;
    }
    return {
      user: { login: 'mock-user', uid: '12345678' },
      total_space: 10 * 1024 * 1024 * 1024, // 10 GB
      used_space: totalUsed,
      trash_size: 0,
    };
  }

  async listDirectory(remotePath: string): Promise<YandexResourceList> {
    this.checkFailure();
    const path = this.validateSandboxedPath(remotePath);
    const prefix = path.endsWith('/') ? path : `${path}/`;

    const items: YandexResourceItem[] = [];
    const directDirs = new Set<string>();

    for (const [filePath, entry] of this.remoteFiles.entries()) {
      if (filePath.startsWith(prefix)) {
        const sub = filePath.substring(prefix.length);
        const slashIdx = sub.indexOf('/');
        if (slashIdx === -1) {
          items.push({
            name: sub,
            path: filePath,
            type: 'file',
            size: entry.size,
            sha256: entry.sha256,
            md5: entry.md5,
            etag: entry.etag,
            modified: entry.modified,
            created: entry.created,
          });
        } else {
          directDirs.add(prefix + sub.substring(0, slashIdx));
        }
      }
    }

    for (const dirPath of this.remoteFolders) {
      if (dirPath !== path && dirPath.startsWith(prefix)) {
        const sub = dirPath.substring(prefix.length);
        const slashIdx = sub.indexOf('/');
        if (slashIdx === -1) {
          directDirs.add(dirPath);
        } else {
          directDirs.add(prefix + sub.substring(0, slashIdx));
        }
      }
    }

    for (const dir of directDirs) {
      const name = dir.substring(dir.lastIndexOf('/') + 1);
      items.push({
        name,
        path: dir,
        type: 'dir',
      });
    }

    return {
      path,
      items,
      limit: 1000,
      offset: 0,
      total: items.length,
    };
  }

  async ensureDirectory(remotePath: string): Promise<void> {
    this.checkFailure();
    const path = this.validateSandboxedPath(remotePath);
    const parts = path.substring(YANDEX_APP_FOLDER_PREFIX.length).split('/');
    let current = YANDEX_APP_FOLDER_PREFIX;
    for (const part of parts) {
      if (!part) continue;
      current = current.endsWith('/') ? `${current}${part}` : `${current}/${part}`;
      this.remoteFolders.add(current);
    }
  }

  async uploadFile(remotePath: string, content: ArrayBuffer, overwrite: boolean = true): Promise<void> {
    this.checkFailure();
    const path = this.validateSandboxedPath(remotePath);
    if (!overwrite && this.remoteFiles.has(path)) {
      const err: any = new Error(`Resource already exists: ${path}`);
      err.status = 409;
      throw err;
    }

    const uint8 = new Uint8Array(content.slice(0));
    const hashBuffer = await crypto.subtle.digest('SHA-256', uint8);
    const sha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const now = new Date().toISOString();
    this.remoteFiles.set(path, {
      data: uint8,
      sha256,
      md5: sha256.substring(0, 32),
      size: uint8.byteLength,
      etag: `etag_${Date.now()}`,
      modified: now,
      created: this.remoteFiles.get(path)?.created ?? now,
    });
  }

  async downloadFile(remotePath: string): Promise<ArrayBuffer> {
    this.checkFailure();
    const path = this.validateSandboxedPath(remotePath);
    const entry = this.remoteFiles.get(path);
    if (!entry) {
      const err: any = new Error(`Resource not found: ${path}`);
      err.status = 404;
      throw err;
    }
    const copy = new Uint8Array(entry.data.byteLength);
    copy.set(entry.data);
    return copy.buffer;
  }

  async deleteResource(remotePath: string): Promise<void> {
    this.checkFailure();
    const path = this.validateSandboxedPath(remotePath);
    const prefix = `${path}/`;
    this.remoteFiles.delete(path);
    this.remoteFolders.delete(path);

    for (const f of Array.from(this.remoteFiles.keys())) {
      if (f.startsWith(prefix)) this.remoteFiles.delete(f);
    }
    for (const d of Array.from(this.remoteFolders)) {
      if (d.startsWith(prefix)) this.remoteFolders.delete(d);
    }
  }

  reset(): void {
    this.remoteFiles.clear();
    this.remoteFolders.clear();
    this.remoteFolders.add(YANDEX_APP_FOLDER_PREFIX);
    this.failNextNRequests = 0;
    this.rateLimitRemaining = 0;
  }
}
