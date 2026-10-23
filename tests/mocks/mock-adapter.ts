/**
 * tests/mocks/mock-adapter.ts
 * In-memory implementation of Obsidian's DataAdapter for fast, hermetic testing.
 */

export interface MockFileRecord {
  data: Uint8Array;
  ctime: number;
  mtime: number;
}

export interface Stat {
  type: 'file' | 'folder';
  ctime: number;
  mtime: number;
  size: number;
}

export interface ListedFiles {
  files: string[];
  folders: string[];
}

export interface DataWriteOptions {
  ctime?: number;
  mtime?: number;
}

export class MockDataAdapter {
  private files = new Map<string, MockFileRecord>();
  private folders = new Set<string>();
  private faultInjections = new Map<string, { op: string; error: Error }>();

  constructor() {
    this.folders.add('');
  }

  getName(): string {
    return 'MockDataAdapter';
  }

  normalizePath(path: string): string {
    return path.normalize('NFC').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  }

  private checkFault(normalizedPath: string, op: string): void {
    const fault = this.faultInjections.get(`${op}:${normalizedPath}`);
    if (fault) {
      throw fault.error;
    }
  }

  injectFault(normalizedPath: string, op: 'read' | 'write' | 'remove' | 'stat', error: Error): void {
    this.faultInjections.set(`${op}:${this.normalizePath(normalizedPath)}`, { op, error });
  }

  clearFaults(): void {
    this.faultInjections.clear();
  }

  private ensureParentFolders(normalizedPath: string): void {
    const parts = normalizedPath.split('/');
    parts.pop(); // Remove file name
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }

  async exists(normalizedPath: string): Promise<boolean> {
    const path = this.normalizePath(normalizedPath);
    this.checkFault(path, 'stat');
    return this.files.has(path) || this.folders.has(path);
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    const path = this.normalizePath(normalizedPath);
    this.checkFault(path, 'stat');
    if (this.folders.has(path)) {
      return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
    }
    const entry = this.files.get(path);
    if (!entry) return null;
    return {
      type: 'file',
      ctime: entry.ctime,
      mtime: entry.mtime,
      size: entry.data.byteLength,
    };
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    const dir = this.normalizePath(normalizedPath);
    const prefix = dir ? `${dir}/` : '';
    const files: string[] = [];
    const directFolders = new Set<string>();

    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const sub = filePath.substring(prefix.length);
        const slashIdx = sub.indexOf('/');
        if (slashIdx === -1) {
          files.push(filePath);
        } else {
          directFolders.add(prefix + sub.substring(0, slashIdx));
        }
      }
    }

    for (const folderPath of this.folders) {
      if (folderPath && folderPath !== dir && folderPath.startsWith(prefix)) {
        const sub = folderPath.substring(prefix.length);
        const slashIdx = sub.indexOf('/');
        if (slashIdx === -1) {
          directFolders.add(folderPath);
        } else {
          directFolders.add(prefix + sub.substring(0, slashIdx));
        }
      }
    }

    return {
      files,
      folders: Array.from(directFolders),
    };
  }

  async read(normalizedPath: string): Promise<string> {
    const path = this.normalizePath(normalizedPath);
    this.checkFault(path, 'read');
    const entry = this.files.get(path);
    if (!entry) throw new Error(`File does not exist: ${path}`);
    return new TextDecoder('utf-8').decode(entry.data);
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const path = this.normalizePath(normalizedPath);
    this.checkFault(path, 'read');
    const entry = this.files.get(path);
    if (!entry) throw new Error(`File does not exist: ${path}`);
    const copy = new Uint8Array(entry.data.byteLength);
    copy.set(entry.data);
    return copy.buffer;
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const encoded = new TextEncoder().encode(data);
    await this.writeBinary(normalizedPath, encoded.buffer, options);
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const path = this.normalizePath(normalizedPath);
    this.checkFault(path, 'write');
    this.ensureParentFolders(path);

    const now = Date.now();
    const existing = this.files.get(path);
    const uint8 = new Uint8Array(data.slice(0));

    this.files.set(path, {
      data: uint8,
      ctime: options?.ctime ?? existing?.ctime ?? now,
      mtime: options?.mtime ?? now,
    });
  }

  async remove(normalizedPath: string): Promise<void> {
    const path = this.normalizePath(normalizedPath);
    this.checkFault(path, 'remove');
    this.files.delete(path);
  }

  async mkdir(normalizedPath: string): Promise<void> {
    const path = this.normalizePath(normalizedPath);
    this.ensureParentFolders(path);
    this.folders.add(path);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    const path = this.normalizePath(normalizedPath);
    const prefix = `${path}/`;
    if (recursive) {
      for (const f of Array.from(this.files.keys())) {
        if (f.startsWith(prefix)) this.files.delete(f);
      }
      for (const d of Array.from(this.folders)) {
        if (d.startsWith(prefix)) this.folders.delete(d);
      }
    }
    this.folders.delete(path);
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const oldPath = this.normalizePath(normalizedPath);
    const newPath = this.normalizePath(normalizedNewPath);

    // Support directory renames
    if (this.folders.has(oldPath)) {
      this.ensureParentFolders(newPath);
      this.folders.delete(oldPath);
      this.folders.add(newPath);

      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${newPath}/`;

      // Update nested folders
      for (const folder of Array.from(this.folders)) {
        if (folder.startsWith(oldPrefix)) {
          this.folders.delete(folder);
          this.folders.add(`${newPrefix}${folder.slice(oldPrefix.length)}`);
        }
      }

      // Update nested files
      for (const [filePath, fileRecord] of Array.from(this.files.entries())) {
        if (filePath.startsWith(oldPrefix)) {
          this.files.delete(filePath);
          this.files.set(`${newPrefix}${filePath.slice(oldPrefix.length)}`, fileRecord);
        }
      }
      return;
    }

    const entry = this.files.get(oldPath);
    if (!entry) throw new Error(`Source file does not exist: ${oldPath}`);
    this.ensureParentFolders(newPath);
    this.files.set(newPath, entry);
    this.files.delete(oldPath);
  }

  async trash(normalizedPath: string, _system: boolean): Promise<void> {
    const path = this.normalizePath(normalizedPath);
    const trashPath = `.trash/${path}`;
    await this.rename(path, trashPath);
  }

  reset(): void {
    this.files.clear();
    this.folders.clear();
    this.folders.add('');
    this.faultInjections.clear();
  }

  setFileMtime(normalizedPath: string, mtime: number): void {
    const path = this.normalizePath(normalizedPath);
    const entry = this.files.get(path);
    if (entry) {
      entry.mtime = mtime;
    }
  }

  dump(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, r] of this.files.entries()) {
      out[p] = new TextDecoder('utf-8').decode(r.data);
    }
    return out;
  }
}
