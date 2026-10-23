import { vi } from 'vitest';

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

/**
 * Universal in-memory mock of Obsidian's requestUrl utility
 */
export const requestUrl = vi.fn(async (request: RequestUrlParam | string): Promise<RequestUrlResponse> => {
  return {
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: {},
    text: '',
  };
});

/**
 * Normalizes vault paths to forward slashes without leading/trailing slashes
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export class TAbstractFile {
  path: string = '';
  name: string = '';
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  stat = { ctime: Date.now(), mtime: Date.now(), size: 0 };
  basename: string = '';
  extension: string = '';
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  message: string;
  noticeEl: any;
  constructor(message: string, public timeout?: number) {
    this.message = message;
    this.noticeEl = createMockElement('div');
  }
  setMessage(msg: string): this {
    this.message = msg;
    return this;
  }
  hide(): void {}
}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isMacOS: false,
  isWin: true,
  isLinux: false,
  isIos: false,
  isAndroid: false,
};

export function createMockElement(tag: string = 'div'): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    children: [] as any[],
    classList: new Set<string>(),
    textContent: '',
    style: {},
    empty() {
      this.children = [];
      this.textContent = '';
    },
    createEl(t: string, opts?: any) {
      const child = createMockElement(t);
      if (opts?.text) child.textContent = opts.text;
      if (opts?.cls) child.addClass(opts.cls);
      this.children.push(child);
      return child;
    },
    createDiv(opts?: any) {
      return this.createEl('div', opts);
    },
    createSpan(opts?: any) {
      return this.createEl('span', opts);
    },
    setText(text: string) {
      this.textContent = text;
    },
    addClass(...classes: string[]) {
      for (const c of classes) {
        if (c) {
          for (const part of c.split(/\s+/)) {
            if (part) this.classList.add(part);
          }
        }
      }
    },
    removeClass(...classes: string[]) {
      for (const c of classes) {
        if (c) {
          for (const part of c.split(/\s+/)) {
            if (part) this.classList.delete(part);
          }
        }
      }
    },
    hasClass(c: string) {
      return this.classList.has(c);
    },
  };
  return el;
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any;

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createMockElement('div');
  }

  display(): void {}
  hide(): void {}
}

export class SettingTextComponent {
  value = '';
  placeholder = '';
  changeCallback?: (val: string) => any;

  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }

  setValue(v: string): this {
    this.value = v;
    return this;
  }

  onChange(cb: (val: string) => any): this {
    this.changeCallback = cb;
    return this;
  }
}

export class SettingToggleComponent {
  value = false;
  changeCallback?: (val: boolean) => any;

  setValue(v: boolean): this {
    this.value = v;
    return this;
  }

  onChange(cb: (val: boolean) => any): this {
    this.changeCallback = cb;
    return this;
  }
}

export class Setting {
  containerEl: any;

  constructor(containerEl: any) {
    this.containerEl = containerEl;
  }

  setName(_name: string): this {
    return this;
  }

  setDesc(_desc: string): this {
    return this;
  }

  addText(cb: (text: SettingTextComponent) => any): this {
    const comp = new SettingTextComponent();
    cb(comp);
    return this;
  }

  addToggle(cb: (toggle: SettingToggleComponent) => any): this {
    const comp = new SettingToggleComponent();
    cb(comp);
    return this;
  }

  addDropdown(_cb: (dropdown: any) => any): this {
    return this;
  }

  addButton(_cb: (btn: any) => any): this {
    return this;
  }
}

export class App {
  vault: any;
  workspace: any = {
    getActiveFile: () => null,
    on: () => ({ id: 'mock-ref' }),
  };
  metadataCache: any = {
    getFileCache: () => null,
    on: () => ({ id: 'mock-ref' }),
  };

  constructor() {
    this.vault = null;
  }
}

export class Modal {
  app: App;
  contentEl: HTMLElement;
  titleEl: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.contentEl = createMockElement('div') as unknown as HTMLElement;
    this.titleEl = createMockElement('div') as unknown as HTMLElement;
  }

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}

export function addIcon(_id: string, _svg: string): void {}

export class Plugin {
  app: any;
  manifest: any;
  private static pluginStorage = new Map<string, any>();

  static resetStorage(): void {
    Plugin.pluginStorage.clear();
  }

  constructor(app: any, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<any> {
    const id = this.manifest?.id ?? 'default';
    const data = Plugin.pluginStorage.get(id);
    return data ? JSON.parse(JSON.stringify(data)) : {};
  }

  async saveData(data: any): Promise<void> {
    const id = this.manifest?.id ?? 'default';
    Plugin.pluginStorage.set(id, JSON.parse(JSON.stringify(data)));
  }

  addSettingTab(_tab: PluginSettingTab): void {}

  addStatusBarItem(): HTMLElement {
    return createMockElement('div') as unknown as HTMLElement;
  }

  addRibbonIcon(_icon: string, _title: string, _callback: (evt: MouseEvent) => any): HTMLElement {
    return createMockElement('div') as unknown as HTMLElement;
  }

  addCommand(command: any): any {
    return command;
  }

  registerEvent(_eventRef: any): void {}

  registerInterval(id: number): number {
    return id;
  }
}
