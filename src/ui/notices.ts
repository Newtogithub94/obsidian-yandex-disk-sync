/**
 * src/ui/notices.ts
 * User notification helper using standard Obsidian Notice API.
 */

import { Notice } from 'obsidian';
import { SyncStatus } from '../types';

export class SyncNotice {
  public static info(message: string, durationMs: number = 4000): Notice {
    return new Notice(`[Yandex Disk Sync] ${message}`, durationMs);
  }

  public static success(message: string, durationMs: number = 5000): Notice {
    return new Notice(`[Yandex Disk Sync] ✓ ${message}`, durationMs);
  }

  public static warn(message: string, durationMs: number = 8000): Notice {
    return new Notice(`[Yandex Disk Sync] ⚠ ${message}`, durationMs);
  }

  public static error(message: string, durationMs: number = 10000): Notice {
    return new Notice(`[Yandex Disk Sync] ❌ Error: ${message}`, durationMs);
  }

  public static conflict(path: string, conflictPath: string): Notice {
    return new Notice(
      `[Yandex Disk Sync] Conflict detected for "${path}"!\nRemote copy saved to "${conflictPath}".`,
      12000
    );
  }
}

/**
 * Real-time HUD progress notice with live percentage, animated bar, and current file tracking.
 * Persistent throughout the sync cycle and self-dismisses upon completion.
 */
export class SyncProgressNotice {
  private notice: Notice | null = null;
  private containerEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private pctEl: HTMLElement | null = null;
  private barFillEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;

  constructor() {
    this.notice = new Notice('', 0);
    const root = (this.notice as any).noticeEl || (this.notice as any).containerEl;

    if (root && typeof root.createDiv === 'function') {
      root.empty();
      if (typeof root.addClass === 'function') {
        root.addClass('yd-progress-notice-root');
      }

      const card = root.createDiv({ cls: 'yd-progress-notice-card yd-gemini-border' });
      this.containerEl = card;
      const inner = card.createDiv({ cls: 'yd-progress-card-inner' });

      // Top row: Icon + Title + Pct
      const topRow = inner.createDiv({ cls: 'yd-progress-top-row' });
      topRow.createSpan({ cls: 'yd-progress-icon', text: '✨' });
      this.titleEl = topRow.createSpan({ cls: 'yd-progress-title', text: 'Синхронизация...' });
      this.pctEl = topRow.createSpan({ cls: 'yd-progress-pct', text: '0%' });

      // Middle row: Progress track + fill
      const track = inner.createDiv({ cls: 'yd-progress-track' });
      const fill = track.createDiv({ cls: 'yd-progress-fill' });
      this.barFillEl = fill;
      fill.style.width = '0%';

      // Bottom row: Detail (current file) + Count (X / Y)
      const bottomRow = inner.createDiv({ cls: 'yd-progress-bottom-row' });
      this.detailEl = bottomRow.createSpan({ cls: 'yd-progress-detail', text: 'Подготовка...' });
      this.countEl = bottomRow.createSpan({ cls: 'yd-progress-count', text: '' });
    }
  }

  public update(status: SyncStatus): void {
    if (!this.containerEl) {
      if (this.notice && typeof this.notice.setMessage === 'function') {
        const pct = status.progressTotal && status.progressTotal > 0
          ? `${Math.round(((status.progressCurrent ?? 0) / status.progressTotal) * 100)}% `
          : '';
        this.notice.setMessage(`[YDS] ${pct}${status.message}`);
      }
      return;
    }

    if (status.state === 'scanning' || status.state === 'diffing') {
      this.titleEl?.setText('Анализ изменений...');
      this.detailEl?.setText(status.message);
      this.pctEl?.setText('');
      if (this.barFillEl) {
        this.barFillEl.style.width = '15%';
        if (typeof this.barFillEl.addClass === 'function') {
          this.barFillEl.addClass('yd-progress-indeterminate');
        }
      }
      return;
    }

    if (this.barFillEl && typeof this.barFillEl.removeClass === 'function') {
      this.barFillEl.removeClass('yd-progress-indeterminate');
    }

    if (
      (status.state === 'uploading' || status.state === 'downloading' || status.state === 'deleting') &&
      status.progressTotal &&
      status.progressTotal > 0
    ) {
      const current = status.progressCurrent ?? 0;
      const total = status.progressTotal;
      const pct = Math.min(100, Math.round((current / total) * 100));

      this.titleEl?.setText('Синхронизация...');
      this.pctEl?.setText(`${pct}%`);
      if (this.barFillEl) {
        this.barFillEl.style.width = `${pct}%`;
      }
      const cleanMsg = status.message.replace(/^Processing\s+/i, '');
      this.detailEl?.setText(cleanMsg);
      this.countEl?.setText(`${current} / ${total}`);
    }
  }

  public finish(success: boolean, summaryText: string): void {
    if (!this.containerEl) {
      this.hide();
      return;
    }

    if (success) {
      if (this.containerEl && typeof this.containerEl.addClass === 'function') {
        this.containerEl.addClass('yd-gemini-success');
      }
      this.titleEl?.setText('Синхронизация завершена');
      this.pctEl?.setText('100%');
      if (this.barFillEl) {
        this.barFillEl.style.width = '100%';
        if (typeof this.barFillEl.addClass === 'function') {
          this.barFillEl.addClass('yd-progress-success');
        }
      }
      this.detailEl?.setText(summaryText);
      this.countEl?.setText('✓');
    } else {
      if (this.containerEl && typeof this.containerEl.addClass === 'function') {
        this.containerEl.addClass('yd-gemini-error');
      }
      this.titleEl?.setText('Синхронизация остановлена');
      if (this.barFillEl && typeof this.barFillEl.addClass === 'function') {
        this.barFillEl.addClass('yd-progress-error');
      }
      this.detailEl?.setText(summaryText);
    }

    window.setTimeout(() => {
      this.hide();
    }, 2800);
  }

  public hide(): void {
    if (this.notice) {
      try {
        this.notice.hide();
      } catch {
        // Safe disposal
      }
      this.notice = null;
    }
  }
}
