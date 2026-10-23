/**
 * src/ui/status-bar.ts
 * Manages the Obsidian status bar item, displaying sync state and progress indicators.
 */

import { SyncStatus } from '../types';

export class SyncStatusBar {
  private statusBarEl: HTMLElement | null = null;
  private onClickCallback?: () => void;

  constructor(statusBarEl?: HTMLElement) {
    if (statusBarEl) {
      this.statusBarEl = statusBarEl;
      if (typeof this.statusBarEl.addClass === 'function') {
        this.statusBarEl.addClass('yandex-sync-status-bar');
      }
      if (typeof this.statusBarEl.addEventListener === 'function') {
        this.statusBarEl.addEventListener('click', () => {
          if (this.onClickCallback) {
            this.onClickCallback();
          }
        });
      }
      this.render({ state: 'idle', message: 'Idle' });
    }
  }

  public setOnClick(callback: () => void): void {
    this.onClickCallback = callback;
  }

  public update(status: SyncStatus): void {
    if (!this.statusBarEl) return;
    this.render(status);
  }

  private render(status: SyncStatus): void {
    if (!this.statusBarEl) return;

    this.statusBarEl.empty();
    const container = this.statusBarEl.createSpan({ cls: 'yandex-sync-status-container' });

    let icon = '☁';
    let label = 'Idle';
    let cls = 'status-idle';

    switch (status.state) {
      case 'idle':
        icon = '☁';
        label = status.lastSyncTime ? `Synced` : 'Ready';
        cls = 'status-idle';
        break;
      case 'scanning':
      case 'diffing':
        icon = '🔍';
        label = 'Scanning...';
        cls = 'status-syncing';
        break;
      case 'uploading':
      case 'downloading':
      case 'deleting':
        icon = '⚡';
        if (
          status.progressCurrent !== undefined &&
          status.progressTotal !== undefined &&
          status.progressTotal > 0
        ) {
          const pct = Math.min(100, Math.round((status.progressCurrent / status.progressTotal) * 100));
          label = `${pct}% (${status.progressCurrent}/${status.progressTotal})`;
        } else {
          label = 'Syncing...';
        }
        cls = 'status-syncing';
        break;
      case 'synced':
        icon = '✓';
        label = 'Synced';
        cls = 'status-synced';
        break;
      case 'conflict':
        icon = '⚠';
        label = 'Conflict';
        cls = 'status-conflict';
        break;
      case 'error':
        icon = '❌';
        label = 'Sync Error';
        cls = 'status-error';
        break;
    }

    container.addClass(cls);
    container.createSpan({ text: `${icon} Yandex: ${label}` });
    this.statusBarEl.title = `Yandex Disk Sync: ${status.message} (Click to sync)`;
  }
}
