import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SyncNotice, SyncProgressNotice } from '../../src/ui/notices';
import { SyncStatus } from '../../src/types';

describe('Sync UI Notices & Progress HUD Suite', () => {
  describe('1. SyncNotice Basic Notifications', () => {
    it('creates info, success, warn, error, and conflict notices', () => {
      const info = SyncNotice.info('Test info');
      expect(info).toBeDefined();

      const success = SyncNotice.success('Test success');
      expect(success).toBeDefined();

      const warn = SyncNotice.warn('Test warn');
      expect(warn).toBeDefined();

      const err = SyncNotice.error('Test error');
      expect(err).toBeDefined();

      const conflict = SyncNotice.conflict('doc.md', 'doc.conflict.md');
      expect(conflict).toBeDefined();
    });
  });

  describe('2. SyncProgressNotice Wave Ripples & Waving Letters', () => {
    let progressNotice: SyncProgressNotice;

    beforeEach(() => {
      progressNotice = new SyncProgressNotice();
    });

    it('creates HUD card structure with light-purple wave backdrop layers', () => {
      const card = (progressNotice as any).containerEl;
      expect(card).toBeDefined();
      expect(card.hasClass('yd-progress-notice-card')).toBe(true);
      expect(card.hasClass('yd-gemini-border')).toBe(true);

      const waveContainer = (progressNotice as any).waveContainerEl;
      expect(waveContainer).toBeDefined();
      expect(waveContainer.hasClass('yd-progress-waves-container')).toBe(true);

      // Verify all 5 wave caustics and ripple layers exist
      const waveChildren = waveContainer.children;
      expect(waveChildren.length).toBe(5);

      const classSets = waveChildren.map((c: any) => Array.from(c.classList));
      expect(classSets[0]).toContain('yd-wave-ambient-glow');
      expect(classSets[1]).toContain('yd-wave-layer-back');
      expect(classSets[2]).toContain('yd-wave-layer-mid');
      expect(classSets[3]).toContain('yd-wave-layer-front');
      expect(classSets[4]).toContain('yd-wave-caustic-shimmer');
    });

    it('breaks title text into individual harmonic wave letters with staggered phase delays', () => {
      const titleEl = (progressNotice as any).titleEl;
      expect(titleEl).toBeDefined();

      const letterSpans = titleEl.children.filter((c: any) => c.hasClass('yd-wave-letter'));
      expect(letterSpans.length).toBeGreaterThan(0);

      // Verify staggered animation delays: 0.00s, 0.08s, 0.16s, ...
      expect(letterSpans[0].style.animationDelay).toBe('0.00s');
      expect(letterSpans[1].style.animationDelay).toBe('0.08s');
      expect(letterSpans[2].style.animationDelay).toBe('0.16s');

      // Verify text content is accessible
      expect(titleEl.textContent).toBe('Синхронизация...');
    });

    it('updates smoothly across scanning, diffing, uploading, and error states', () => {
      const titleEl = (progressNotice as any).titleEl;
      const pctEl = (progressNotice as any).pctEl;
      const barFillEl = (progressNotice as any).barFillEl;
      const detailEl = (progressNotice as any).detailEl;
      const countEl = (progressNotice as any).countEl;

      // Scanning state
      const scanStatus: SyncStatus = {
        state: 'scanning',
        message: 'Сканирование хранилища...',
      };
      progressNotice.update(scanStatus);

      expect(titleEl.textContent).toBe('Анализ изменений...');
      expect(detailEl.textContent).toBe('Сканирование хранилища...');
      expect(pctEl.textContent).toBe('');
      expect(barFillEl.hasClass('yd-progress-indeterminate')).toBe(true);
      expect(barFillEl.style.width).toBe('15%');

      // Uploading state
      const uploadStatus: SyncStatus = {
        state: 'uploading',
        message: 'Processing notes/test.md',
        progressCurrent: 3,
        progressTotal: 6,
      };
      progressNotice.update(uploadStatus);

      expect(titleEl.textContent).toBe('Синхронизация...');
      expect(pctEl.textContent).toBe('50%');
      expect(barFillEl.style.width).toBe('50%');
      expect(barFillEl.hasClass('yd-progress-indeterminate')).toBe(false);
      expect(detailEl.textContent).toBe('notes/test.md');
      expect(countEl.textContent).toBe('3 / 6');
    });

    it('handles finish state gracefully by calming waves and docking text', () => {
      const card = (progressNotice as any).containerEl;
      const titleEl = (progressNotice as any).titleEl;
      const pctEl = (progressNotice as any).pctEl;
      const barFillEl = (progressNotice as any).barFillEl;
      const detailEl = (progressNotice as any).detailEl;
      const countEl = (progressNotice as any).countEl;

      progressNotice.finish(true, 'Успешно: ↑2 ↓0 ✕0');

      expect(card.hasClass('yd-gemini-success')).toBe(true);
      expect(card.hasClass('yd-sync-finished')).toBe(true);
      expect(titleEl.textContent).toBe('Синхронизация завершена');
      expect(pctEl.textContent).toBe('100%');
      expect(barFillEl.style.width).toBe('100%');
      expect(barFillEl.hasClass('yd-progress-success')).toBe(true);
      expect(detailEl.textContent).toBe('Успешно: ↑2 ↓0 ✕0');
      expect(countEl.textContent).toBe('✓');
    });

    it('handles finish error state with error styling', () => {
      const card = (progressNotice as any).containerEl;
      const titleEl = (progressNotice as any).titleEl;
      const barFillEl = (progressNotice as any).barFillEl;
      const detailEl = (progressNotice as any).detailEl;

      progressNotice.finish(false, 'Сетевая ошибка');

      expect(card.hasClass('yd-gemini-error')).toBe(true);
      expect(card.hasClass('yd-sync-finished')).toBe(true);
      expect(titleEl.textContent).toBe('Синхронизация остановлена');
      expect(barFillEl.hasClass('yd-progress-error')).toBe(true);
      expect(detailEl.textContent).toBe('Сетевая ошибка');
    });

    it('does not re-render DOM spans when title text and waving state remain identical', () => {
      const titleEl = (progressNotice as any).titleEl;
      const initialSpans = [...titleEl.children];

      // Update with identical title
      const upload1: SyncStatus = {
        state: 'uploading',
        message: 'file1.md',
        progressCurrent: 1,
        progressTotal: 10,
      };
      progressNotice.update(upload1);

      const upload2: SyncStatus = {
        state: 'uploading',
        message: 'file2.md',
        progressCurrent: 2,
        progressTotal: 10,
      };
      progressNotice.update(upload2);

      // Title spans should be preserved without continuous destruction/re-creation
      expect(titleEl.children.length).toBe(initialSpans.length);
    });

    it('cleans up and hides safely', () => {
      const hideSpy = vi.spyOn((progressNotice as any).notice, 'hide');
      progressNotice.hide();
      expect(hideSpy).toHaveBeenCalled();
      expect((progressNotice as any).notice).toBeNull();
    });
  });
});
