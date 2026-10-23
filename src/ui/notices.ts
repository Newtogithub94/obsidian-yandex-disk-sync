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
  private waveContainerEl: HTMLElement | null = null;
  private currentTitleText: string = '';
  private isWaving: boolean = false;

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

      // Transparent animated light-purple wave backdrop inside the card frame
      const waveContainer = inner.createDiv({ cls: 'yd-progress-waves-container' });
      this.waveContainerEl = waveContainer;
      if (typeof (waveContainer as any).setAttribute === 'function') {
        (waveContainer as any).setAttribute('aria-hidden', 'true');
      }
      waveContainer.createDiv({ cls: 'yd-wave-ambient-glow' });
      waveContainer.createDiv({ cls: 'yd-wave-layer yd-wave-layer-back' });
      waveContainer.createDiv({ cls: 'yd-wave-layer yd-wave-layer-mid' });
      waveContainer.createDiv({ cls: 'yd-wave-layer yd-wave-layer-front' });
      waveContainer.createDiv({ cls: 'yd-wave-caustic-shimmer' });

      // Top row: Icon + Title + Pct (rendered with z-index: 1 on top of waves)
      const topRow = inner.createDiv({ cls: 'yd-progress-top-row' });
      topRow.createSpan({ cls: 'yd-progress-icon', text: '✨' });
      this.titleEl = topRow.createSpan({ cls: 'yd-progress-title' });
      this.pctEl = topRow.createSpan({ cls: 'yd-progress-pct', text: '0%' });
      this.setTitle('Синхронизация...', true);

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

  /**
   * Sets title text with optional gentle harmonic letter waving animation.
   * If waving is enabled, each character gently bobs in a phase-staggered harmonic wave.
   */
  private setTitle(text: string, waving: boolean = true): void {
    if (!this.titleEl) return;
    if (this.currentTitleText === text && this.isWaving === waving) {
      return;
    }
    this.currentTitleText = text;
    this.isWaving = waving;

    if (typeof this.titleEl.empty === 'function') {
      this.titleEl.empty();
    } else {
      (this.titleEl as any).innerHTML = '';
    }

    if (!waving) {
      if (typeof this.titleEl.setText === 'function') {
        this.titleEl.setText(text);
      } else {
        this.titleEl.textContent = text;
      }
      return;
    }

    // Render individual animated wave letters with harmonic delays
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === ' ') {
        this.titleEl.createSpan({ cls: 'yd-wave-letter-space', text: ' ' });
      } else {
        const span = this.titleEl.createSpan({ cls: 'yd-wave-letter', text: char });
        const delay = (i * 0.08).toFixed(2);
        if (span && span.style) {
          (span.style as any).animationDelay = `${delay}s`;
        }
      }
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
      this.setTitle('Анализ изменений...', true);
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

    if (
      status.state === 'uploading' ||
      status.state === 'downloading' ||
      status.state === 'deleting'
    ) {
      this.setTitle('Синхронизация...', true);
      const cleanMsg = status.message.replace(/^Processing\s+/i, '');
      this.detailEl?.setText(cleanMsg);

      if (status.progressTotal && status.progressTotal > 0) {
        const current = status.progressCurrent ?? 0;
        const total = status.progressTotal;
        const pct = Math.min(100, Math.round((current / total) * 100));

        this.pctEl?.setText(`${pct}%`);
        if (this.barFillEl) {
          this.barFillEl.style.width = `${pct}%`;
          if (typeof this.barFillEl.removeClass === 'function') {
            this.barFillEl.removeClass('yd-progress-indeterminate');
          }
        }
        this.countEl?.setText(`${current} / ${total}`);
      } else {
        this.pctEl?.setText('');
        if (this.barFillEl) {
          this.barFillEl.style.width = '30%';
          if (typeof this.barFillEl.addClass === 'function') {
            this.barFillEl.addClass('yd-progress-indeterminate');
          }
        }
        this.countEl?.setText('');
      }
      return;
    }

    // Generic fallback for any other state (idle awaiting review, error, etc.)
    if (this.barFillEl && typeof this.barFillEl.removeClass === 'function') {
      this.barFillEl.removeClass('yd-progress-indeterminate');
    }
    this.setTitle(status.state === 'error' ? 'Ошибка' : 'Синхронизация...', true);
    this.detailEl?.setText(status.message);
  }

  public finish(success: boolean, summaryText: string): void {
    if (!this.containerEl) {
      this.hide();
      return;
    }

    if (success) {
      if (this.containerEl && typeof this.containerEl.addClass === 'function') {
        this.containerEl.addClass('yd-gemini-success', 'yd-sync-finished');
      }
      this.setTitle('Синхронизация завершена', true);
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
        this.containerEl.addClass('yd-gemini-error', 'yd-sync-finished');
      }
      this.setTitle('Синхронизация остановлена', true);
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
