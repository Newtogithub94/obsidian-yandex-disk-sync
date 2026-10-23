/**
 * tests/mocks/mock-app.ts
 * In-memory Mock of Obsidian App instance.
 */

import { MockVault } from './mock-vault';
import { MockDataAdapter } from './mock-adapter';

export class MockApp {
  vault: MockVault;
  workspace = {
    getActiveFile: () => null,
    on: () => ({ id: 'workspace-ref' }),
  };
  metadataCache = {
    getFileCache: () => null,
    on: () => ({ id: 'cache-ref' }),
  };

  constructor(vault?: MockVault) {
    this.vault = vault ?? new MockVault(new MockDataAdapter());
  }
}
