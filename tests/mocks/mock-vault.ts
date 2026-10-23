/**
 * tests/mocks/mock-vault.ts
 * In-memory implementation of Obsidian's Vault API.
 */

import { MockDataAdapter, Stat, DataWriteOptions } from './mock-adapter';

export interface EventRef {
  id: string;
}

export abstract class MockTAbstractFile {
  vault: MockVault;
  path: string;
  name: string;
  parent: MockTFolder | null;

  constructor(vault: MockVault, path: string, parent: MockTFolder | null = null) {
    this.vault = vault;
    this.path = path;
    const segments = path.split('/');
    this.name = segments[segments.length - 1] ?? '';
    this.parent = parent;
  }
}

export class MockTFile extends MockTAbstractFile {
  stat: Stat;
  basename: string;
  extension: string;

  constructor(vault: MockVault, path: string, stat?: Partial<Stat>, parent: MockTFolder | null = null) {
    super(vault, path, parent);
    const lastDot = this.name.lastIndexOf('.');
    if (lastDot > 0) {
      this.basename = this.name.substring(0, lastDot);
      this.extension = this.name.substring(lastDot + 1);
    } else {
      this.basename = this.name;
      this.extension = '';
    }
    this.stat = {
      type: 'file',
      ctime: stat?.ctime ?? Date.now(),
      mtime: stat?.mtime ?? Date.now(),
      size: stat?.size ?? 0,
    };
  }
}

export class MockTFolder extends MockTAbstractFile {
  children: MockTAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === '' || this.path === '/';
  }
}

type EventCallback = (...args: any[]) => any;

export class MockVault {
  adapter: MockDataAdapter;
  private fileMap = new Map<string, MockTFile>();
  private folderMap = new Map<string, MockTFolder>();
  private listeners = new Map<string, Map<string, EventCallback>>();
  private nextEventId = 1;
  root: MockTFolder;

  constructor(adapter?: MockDataAdapter) {
    this.adapter = adapter ?? new MockDataAdapter();
    this.root = new MockTFolder(this, '');
    this.folderMap.set('', this.root);
  }

  getName(): string {
    return 'MockVault';
  }

  getRoot(): MockTFolder {
    return this.root;
  }

  getOrCreateFolder(path: string): MockTFolder {
    const norm = this.adapter.normalizePath(path);
    if (norm === '' || norm === '/') {
      return this.root;
    }
    const existing = this.folderMap.get(norm);
    if (existing) {
      return existing;
    }

    const parentPath = norm.includes('/') ? norm.substring(0, norm.lastIndexOf('/')) : '';
    const parentFolder = this.getOrCreateFolder(parentPath);
    const folder = new MockTFolder(this, norm, parentFolder);
    if (!parentFolder.children.includes(folder)) {
      parentFolder.children.push(folder);
    }
    this.folderMap.set(norm, folder);
    return folder;
  }

  on(name: string, callback: EventCallback): EventRef {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Map());
    }
    const id = `event_${this.nextEventId++}`;
    this.listeners.get(name)!.set(id, callback);
    return { id };
  }

  offref(ref: EventRef): void {
    for (const map of this.listeners.values()) {
      map.delete(ref.id);
    }
  }

  trigger(name: string, ...args: any[]): void {
    const map = this.listeners.get(name);
    if (map) {
      for (const cb of map.values()) {
        cb(...args);
      }
    }
  }

  getAbstractFileByPath(path: string): MockTAbstractFile | null {
    const norm = this.adapter.normalizePath(path);
    return this.fileMap.get(norm) ?? this.folderMap.get(norm) ?? null;
  }

  getFileByPath(path: string): MockTFile | null {
    const norm = this.adapter.normalizePath(path);
    return this.fileMap.get(norm) ?? null;
  }

  getFolderByPath(path: string): MockTFolder | null {
    const norm = this.adapter.normalizePath(path);
    return this.folderMap.get(norm) ?? null;
  }

  getFiles(): MockTFile[] {
    return Array.from(this.fileMap.values());
  }

  getMarkdownFiles(): MockTFile[] {
    return this.getFiles().filter((f) => f.extension.toLowerCase() === 'md');
  }

  getAllLoadedFiles(): MockTAbstractFile[] {
    return [...Array.from(this.folderMap.values()), ...Array.from(this.fileMap.values())];
  }

  async read(file: MockTFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async cachedRead(file: MockTFile): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: MockTFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  async create(path: string, data: string, options?: DataWriteOptions): Promise<MockTFile> {
    const norm = this.adapter.normalizePath(path);
    if (this.fileMap.has(norm)) {
      throw new Error(`File already exists: ${norm}`);
    }
    await this.adapter.write(norm, data, options);
    const stat = await this.adapter.stat(norm);
    const parentPath = norm.includes('/') ? norm.substring(0, norm.lastIndexOf('/')) : '';
    const parentFolder = this.getOrCreateFolder(parentPath);
    const file = new MockTFile(this, norm, stat ?? undefined, parentFolder);
    if (!parentFolder.children.includes(file)) {
      parentFolder.children.push(file);
    }
    this.fileMap.set(norm, file);
    this.trigger('create', file);
    return file;
  }

  async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<MockTFile> {
    const norm = this.adapter.normalizePath(path);
    if (this.fileMap.has(norm)) {
      throw new Error(`File already exists: ${norm}`);
    }
    await this.adapter.writeBinary(norm, data, options);
    const stat = await this.adapter.stat(norm);
    const parentPath = norm.includes('/') ? norm.substring(0, norm.lastIndexOf('/')) : '';
    const parentFolder = this.getOrCreateFolder(parentPath);
    const file = new MockTFile(this, norm, stat ?? undefined, parentFolder);
    if (!parentFolder.children.includes(file)) {
      parentFolder.children.push(file);
    }
    this.fileMap.set(norm, file);
    this.trigger('create', file);
    return file;
  }

  async createFolder(path: string): Promise<MockTFolder> {
    const norm = this.adapter.normalizePath(path);
    if (this.folderMap.has(norm)) {
      return this.folderMap.get(norm)!;
    }
    await this.adapter.mkdir(norm);
    const folder = this.getOrCreateFolder(norm);
    this.trigger('create', folder);
    return folder;
  }

  async modify(file: MockTFile, data: string, options?: DataWriteOptions): Promise<void> {
    await this.adapter.write(file.path, data, options);
    const stat = await this.adapter.stat(file.path);
    if (stat) {
      file.stat = stat;
    }
    this.trigger('modify', file);
  }

  async modifyBinary(file: MockTFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    await this.adapter.writeBinary(file.path, data, options);
    const stat = await this.adapter.stat(file.path);
    if (stat) {
      file.stat = stat;
    }
    this.trigger('modify', file);
  }

  async delete(file: MockTAbstractFile, _force?: boolean): Promise<void> {
    const norm = this.adapter.normalizePath(file.path);
    if (file.parent) {
      const idx = file.parent.children.indexOf(file);
      if (idx !== -1) {
        file.parent.children.splice(idx, 1);
      }
    }
    if (file instanceof MockTFile) {
      await this.adapter.remove(norm);
      this.fileMap.delete(norm);
    } else if (file instanceof MockTFolder) {
      await this.adapter.rmdir(norm, true);
      this.folderMap.delete(norm);
      const prefix = `${norm}/`;
      for (const p of Array.from(this.fileMap.keys())) {
        if (p.startsWith(prefix)) {
          this.fileMap.delete(p);
        }
      }
      for (const p of Array.from(this.folderMap.keys())) {
        if (p.startsWith(prefix)) {
          this.folderMap.delete(p);
        }
      }
    }
    this.trigger('delete', file);
  }

  async trash(file: MockTAbstractFile, system: boolean): Promise<void> {
    const norm = this.adapter.normalizePath(file.path);
    await this.adapter.trash(norm, system);
    if (file.parent) {
      const idx = file.parent.children.indexOf(file);
      if (idx !== -1) {
        file.parent.children.splice(idx, 1);
      }
    }
    if (file instanceof MockTFile) {
      this.fileMap.delete(norm);
    } else if (file instanceof MockTFolder) {
      this.folderMap.delete(norm);
      const prefix = `${norm}/`;
      for (const p of Array.from(this.fileMap.keys())) {
        if (p.startsWith(prefix)) {
          this.fileMap.delete(p);
        }
      }
      for (const p of Array.from(this.folderMap.keys())) {
        if (p.startsWith(prefix)) {
          this.folderMap.delete(p);
        }
      }
    }
    this.trigger('delete', file);
  }

  async rename(file: MockTAbstractFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    const normNew = this.adapter.normalizePath(newPath);
    await this.adapter.rename(oldPath, normNew);

    // Unlink from old parent
    if (file.parent) {
      const idx = file.parent.children.indexOf(file);
      if (idx !== -1) {
        file.parent.children.splice(idx, 1);
      }
    }

    // Link to new parent
    const newParentPath = normNew.includes('/') ? normNew.substring(0, normNew.lastIndexOf('/')) : '';
    const newParent = this.getOrCreateFolder(newParentPath);
    file.parent = newParent;
    if (!newParent.children.includes(file)) {
      newParent.children.push(file);
    }

    if (file instanceof MockTFile) {
      this.fileMap.delete(oldPath);
      file.path = normNew;
      const segments = normNew.split('/');
      file.name = segments[segments.length - 1] ?? '';
      const lastDot = file.name.lastIndexOf('.');
      file.basename = lastDot > 0 ? file.name.substring(0, lastDot) : file.name;
      file.extension = lastDot > 0 ? file.name.substring(lastDot + 1) : '';
      this.fileMap.set(normNew, file);
    } else if (file instanceof MockTFolder) {
      this.folderMap.delete(oldPath);
      file.path = normNew;
      const segments = normNew.split('/');
      file.name = segments[segments.length - 1] ?? '';
      this.folderMap.set(normNew, file);

      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${normNew}/`;

      // Update descendant folders
      for (const [fPath, fObj] of Array.from(this.folderMap.entries())) {
        if (fPath.startsWith(oldPrefix)) {
          this.folderMap.delete(fPath);
          const childNewPath = `${newPrefix}${fPath.slice(oldPrefix.length)}`;
          fObj.path = childNewPath;
          const childSegs = childNewPath.split('/');
          fObj.name = childSegs[childSegs.length - 1] ?? '';
          this.folderMap.set(childNewPath, fObj);
        }
      }

      // Update descendant files
      for (const [filePath, fileObj] of Array.from(this.fileMap.entries())) {
        if (filePath.startsWith(oldPrefix)) {
          this.fileMap.delete(filePath);
          const childNewPath = `${newPrefix}${filePath.slice(oldPrefix.length)}`;
          fileObj.path = childNewPath;
          const childSegs = childNewPath.split('/');
          fileObj.name = childSegs[childSegs.length - 1] ?? '';
          const dotIdx = fileObj.name.lastIndexOf('.');
          fileObj.basename = dotIdx > 0 ? fileObj.name.substring(0, dotIdx) : fileObj.name;
          fileObj.extension = dotIdx > 0 ? fileObj.name.substring(dotIdx + 1) : '';
          this.fileMap.set(childNewPath, fileObj);
        }
      }
    }

    this.trigger('rename', file, oldPath);
  }

  async seed(files: Record<string, string | ArrayBuffer>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        await this.create(path, content);
      } else {
        await this.createBinary(path, content);
      }
    }
  }

  reset(): void {
    this.adapter.reset();
    this.fileMap.clear();
    this.folderMap.clear();
    this.root = new MockTFolder(this, '');
    this.folderMap.set('', this.root);
  }
}
