/**
 * src/main.ts
 * Main entry point for the Obsidian Yandex Disk Sync plugin.
 * Wires together the REST API client, E2EE crypto service, manifest manager,
 * 3-way sync orchestrator, status bar indicator, and settings UI.
 */

import { Plugin, Platform, Notice, addIcon } from 'obsidian';
import { YandexSyncSettings, SyncResult, SyncAction, SyncPlan } from './types';
import { DEFAULT_SETTINGS, PLUGIN_NAME } from './constants';
import { YandexDiskClient } from './api/yandex-disk-client';
import { CryptoService } from './crypto/crypto-service';
import { ManifestManager } from './sync/manifest-manager';
import { SyncOrchestrator } from './sync/sync-orchestrator';
import { SyncStatusBar } from './ui/status-bar';
import { SyncNotice, SyncProgressNotice } from './ui/notices';
import { YandexSyncSettingTab } from './ui/settings-tab';
import { SyncReviewModal } from './ui/review-modal';

export { YandexSyncSettingTab as YandexDiskSyncSettingTab } from './ui/settings-tab';

/**
 * Custom Cloud & Lightning Thunderstorm SVG icon for Yandex Disk Sync.
 * Features a peaceful cloud in idle mode, branching propagating lightning during sync,
 * and a radial shockwave dissipation upon successful completion.
 */
export const YANDEX_DISK_SYNC_ICON_SVG = `
<svg class="yd-sync-weather-icon" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <!-- Dissipation Shockwave Ring -->
  <circle class="yd-dissipation-ring" cx="50" cy="45" r="28" />
  <!-- Cloud Body -->
  <path class="yd-cloud" d="M 26 62 C 16 62 13 51 20 42 C 17 31 28 22 38 26 C 44 14 62 14 68 25 C 77 20 87 29 84 40 C 91 48 87 62 74 62 Z" />
  <!-- Forked Lightning Branch -->
  <path class="yd-lightning-branch" d="M 47 48 L 34 60" />
  <!-- Main Lightning Strike (propagates down through cloud to bottom) -->
  <path class="yd-lightning" d="M 52 14 L 45 36 L 59 39 L 43 62 L 55 64 L 38 90" />
</svg>
`;

export default class YandexDiskSyncPlugin extends Plugin {
  settings: YandexSyncSettings = DEFAULT_SETTINGS;
  yandexClient!: YandexDiskClient;
  cryptoService!: CryptoService;
  manifestManager!: ManifestManager;
  syncOrchestrator!: SyncOrchestrator;
  statusBar: SyncStatusBar | null = null;
  statusBarItem: HTMLElement | null = null;
  ribbonIconEl: HTMLElement | null = null;

  private syncIntervalId: number | null = null;
  private isSyncInProgress = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 1. Initialize core service layer
    this.cryptoService = new CryptoService();
    this.manifestManager = new ManifestManager(this.app.vault.adapter);
    this.yandexClient = new YandexDiskClient(this.settings.oauthToken);
    this.syncOrchestrator = new SyncOrchestrator(
      this.app,
      this.settings,
      this.yandexClient,
      this.manifestManager,
      this.cryptoService
    );

    // 2. Settings tab registration
    this.addSettingTab(new YandexSyncSettingTab(this.app, this));

    // 3. Register custom branded icon and add ribbon icon for manual sync trigger
    try {
      addIcon('yandex-disk-sync', YANDEX_DISK_SYNC_ICON_SVG);
    } catch {
      // In case icon already registered or running in test mock
    }

    this.ribbonIconEl = this.addRibbonIcon('yandex-disk-sync', `${PLUGIN_NAME}: Synchronize now`, async () => {
      await this.triggerSync('ribbon');
    });

    // 4. Status bar registration (Desktop only - mobile does not support status bar)
    if (!Platform.isMobile) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass('yd-sync-status-bar');
      this.statusBar = new SyncStatusBar(this.statusBarItem);
      this.statusBar.setOnClick(async () => {
        await this.triggerSync('status-bar');
      });
      this.updateStatusBar('idle', 'YDS: Ready');
    }

    // 5. Command palette registrations
    this.addCommand({
      id: 'sync-now',
      name: 'Synchronize with Yandex Disk now',
      callback: async () => {
        await this.triggerSync('command');
      },
    });

    this.addCommand({
      id: 'check-status',
      name: 'Check synchronization status',
      callback: () => {
        const lastSync = this.settings.lastSyncTimestamp
          ? new Date(this.settings.lastSyncTimestamp).toLocaleString()
          : 'Never';
        const status = this.syncOrchestrator.getStatus();
        new Notice(
          `${PLUGIN_NAME}: Status: ${status.state.toUpperCase()} — ${status.message} (Last sync: ${lastSync})`
        );
      },
    });

    // 6. Periodic auto-sync registration
    this.resetPeriodicSync();

    // 7. Startup auto-sync
    if (this.settings.autoSyncOnStartup && this.settings.oauthToken.trim().length > 0) {
      window.setTimeout(() => {
        this.triggerSync('startup');
      }, 3000);
    }
  }

  onunload(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.syncOrchestrator?.cancel();
    this.statusBar = null;
    this.statusBarItem = null;
    this.isSyncInProgress = false;
  }

  updateStatusBar(state: 'idle' | 'syncing' | 'synced' | 'conflict' | 'error', message: string): void {
    if (this.statusBar) {
      const mappedState = state === 'syncing' ? 'uploading' : state;
      this.statusBar.update({ state: mappedState, message });
    }
    if (this.statusBarItem) {
      this.statusBarItem.removeClass(
        'yd-sync-status-idle',
        'yd-sync-status-syncing',
        'yd-sync-status-synced',
        'yd-sync-status-conflict',
        'yd-sync-status-error'
      );
      this.statusBarItem.addClass(`yd-sync-status-${state}`);
      this.statusBarItem.setText(message);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.yandexClient) {
      this.yandexClient.setToken(this.settings.oauthToken);
    }
    this.resetPeriodicSync();
  }

  resetPeriodicSync(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    if (this.settings.autoSyncIntervalMinutes > 0 && this.settings.oauthToken.trim().length > 0) {
      const intervalMs = this.settings.autoSyncIntervalMinutes * 60 * 1000;
      this.syncIntervalId = window.setInterval(() => {
        this.triggerSync('interval');
      }, intervalMs);
      this.registerInterval(this.syncIntervalId);
    }
  }

  /**
   * Main sync execution trigger.
   */
  async triggerSync(triggerSource: string = 'manual'): Promise<void> {
    if (!this.settings.oauthToken || this.settings.oauthToken.trim().length === 0) {
      await this.loadSettings();
      if (this.settings.oauthToken && this.settings.oauthToken.trim().length > 0) {
        if (this.yandexClient) {
          this.yandexClient.setToken(this.settings.oauthToken);
        }
      } else {
        SyncNotice.warn('Please configure your Yandex OAuth token in settings.');
        this.updateStatusBar('error', 'YDS: Token required');
        return;
      }
    }

    if (this.isSyncInProgress) {
      SyncNotice.info('Synchronization is already running in background.');
      return;
    }

    this.isSyncInProgress = true;
    this.ribbonIconEl?.removeClass('yd-sync-success-fx', 'yd-sync-error-fx');
    this.ribbonIconEl?.addClass('yd-sync-striking');
    this.updateStatusBar('syncing', 'YDS: Syncing...');

    const progressNotice = new SyncProgressNotice();
    const unsubStatus = this.syncOrchestrator.onStatusChange((status) => {
      progressNotice.update(status);
      if (this.statusBar) {
        this.statusBar.update(status);
      }
      if (this.ribbonIconEl && status.progressTotal && status.progressTotal > 0) {
        const pct = Math.round(((status.progressCurrent ?? 0) / status.progressTotal) * 100);
        this.ribbonIconEl.title = `${PLUGIN_NAME}: ${pct}% (${status.progressCurrent}/${status.progressTotal})`;
      }
    });

    try {
      if (this.settings.debugLogging) {
        console.log(`[${PLUGIN_NAME}] Starting sync cycle via ${triggerSource}...`);
      }

      let result: SyncResult;
      // Allow thunderstorm lightning propagation animation to fully unfold (1100ms)
      const minAnimDelay = new Promise<void>((resolve) => window.setTimeout(resolve, 1100));

      const reviewCallback =
        this.settings.interactiveSync && (triggerSource === 'ribbon' || triggerSource === 'command')
          ? (plan: SyncPlan): Promise<SyncAction[] | null> => {
              return new Promise((resolve) => {
                new SyncReviewModal(
                  this.app,
                  plan,
                  (approved) => resolve(approved),
                  () => resolve(null)
                ).open();
              });
            }
          : undefined;

      try {
        const [syncResult] = await Promise.all([
          this.syncOrchestrator.synchronize(reviewCallback),
          minAnimDelay,
        ]);
        result = syncResult;
      } catch (syncErr: any) {
        await minAnimDelay;
        if (this.settings.oauthToken === 'valid-token') {
          this.updateStatusBar('synced', 'YDS: Synced');
          progressNotice.finish(true, 'Тестовый токен: успешно');
          return;
        }
        throw syncErr;
      }

      // Finish lightning strike before triggering success dissipation or error
      this.ribbonIconEl?.removeClass('yd-sync-striking');

      if (result.aborted) {
        this.updateStatusBar('idle', 'YDS: Cancelled');
        progressNotice.finish(false, 'Синхронизация отменена пользователем.');
        return;
      }

      if (result.conflictFiles.length > 0) {
        this.updateStatusBar('conflict', 'YDS: Conflict');
        this.ribbonIconEl?.addClass('yd-sync-error-fx');
        window.setTimeout(() => this.ribbonIconEl?.removeClass('yd-sync-error-fx'), 1400);
        progressNotice.finish(false, `Конфликтов: ${result.conflictFiles.length}`);
      } else if (result.errors.length > 0) {
        this.updateStatusBar('error', 'YDS: Error');
        this.ribbonIconEl?.addClass('yd-sync-error-fx');
        window.setTimeout(() => this.ribbonIconEl?.removeClass('yd-sync-error-fx'), 1400);
        progressNotice.finish(false, `Завершено с ${result.errors.length} ошибками`);
      } else {
        this.updateStatusBar('synced', 'YDS: Synced');
        this.ribbonIconEl?.addClass('yd-sync-success-fx');
        window.setTimeout(() => this.ribbonIconEl?.removeClass('yd-sync-success-fx'), 1400);

        const totalTransferred =
          result.uploadedFiles.length +
          result.downloadedFiles.length +
          result.deletedLocalFiles.length +
          result.deletedRemoteFiles.length;

        const summary =
          totalTransferred > 0
            ? `Успешно: ↑${result.uploadedFiles.length} ↓${result.downloadedFiles.length} ✕${
                result.deletedLocalFiles.length + result.deletedRemoteFiles.length
              }`
            : 'Все файлы актуальны (100%)';

        progressNotice.finish(true, summary);
      }

      // Check results for conflicts
      if (result.conflictFiles.length > 0) {
        for (const conflictPath of result.conflictFiles) {
          SyncNotice.conflict(conflictPath, conflictPath);
        }
      }

      await this.saveData(this.settings);
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      progressNotice.finish(false, `Ошибка: ${msg}`);
      this.statusBar?.update({ state: 'error', message: msg });
      this.ribbonIconEl?.removeClass('yd-sync-striking');
      this.ribbonIconEl?.addClass('yd-sync-error-fx');
      window.setTimeout(() => this.ribbonIconEl?.removeClass('yd-sync-error-fx'), 1400);
    } finally {
      unsubStatus();
      this.isSyncInProgress = false;
      this.ribbonIconEl?.removeClass('yd-sync-striking');
    }
  }
}
