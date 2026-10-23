/**
 * src/ui/settings-tab.ts
 * Obsidian SettingsTab implementation for Yandex Disk Sync.
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type YandexDiskSyncPlugin from '../main';
import { SyncNotice } from './notices';

export class YandexSyncSettingTab extends PluginSettingTab {
  plugin: YandexDiskSyncPlugin;

  constructor(app: App, plugin: YandexDiskSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Yandex Disk Synchronization' });

    // -------------------------------------------------------------
    // Section 1: Authentication
    // -------------------------------------------------------------
    containerEl.createEl('h3', { text: '1. Authentication & Cloud Storage' });

    new Setting(containerEl)
      .setName('Yandex OAuth Access Token')
      .setDesc('Enter your personal OAuth access token with cloud_api:disk.app_folder scope.')
      .addText((text) => {
        text
          .setPlaceholder('OAuth y0_...')
          .setValue(this.plugin.settings.oauthToken)
          .onChange(async (value) => {
            this.plugin.settings.oauthToken = value.trim();
            await this.plugin.saveSettings();
          });
        if (text.inputEl) {
          text.inputEl.type = 'password';
        }
      });

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify OAuth token validity and retrieve Yandex Disk storage quotas.')
      .addButton((btn) => {
        btn
          .setButtonText('Test Connection')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText('Testing...');
            try {
              const info = await this.plugin.yandexClient.testConnection();
              const usedGb = (info.used_space / (1024 * 1024 * 1024)).toFixed(2);
              const totalGb = (info.total_space / (1024 * 1024 * 1024)).toFixed(2);
              SyncNotice.success(
                `Connected as @${info.user.login} (${usedGb} GB / ${totalGb} GB used)`
              );
            } catch (err: any) {
              SyncNotice.error(`Connection failed: ${err?.message || err}`);
            } finally {
              btn.setDisabled(false);
              btn.setButtonText('Test Connection');
            }
          });
      });

    new Setting(containerEl)
      .setName('Remote Folder')
      .setDesc('Subfolder within disk:/Приложения/ObsidianSync/ (leave blank for root app folder).')
      .addText((text) =>
        text
          .setPlaceholder('ObsidianVault')
          .setValue(this.plugin.settings.remoteFolder)
          .onChange(async (value) => {
            this.plugin.settings.remoteFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // -------------------------------------------------------------
    // Section 2: Sync Triggers
    // -------------------------------------------------------------
    containerEl.createEl('h3', { text: '2. Sync Triggers & Schedule' });

    new Setting(containerEl)
      .setName('Sync on Startup')
      .setDesc('Initiate synchronization automatically whenever Obsidian launches or vault opens.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Periodic Sync Interval (Minutes)')
      .setDesc('Automatically synchronize in the background every X minutes. Set to 0 to disable.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('0', 'Disabled (Manual only)')
          .addOption('5', 'Every 5 minutes')
          .addOption('10', 'Every 10 minutes')
          .addOption('15', 'Every 15 minutes')
          .addOption('30', 'Every 30 minutes')
          .addOption('60', 'Every 60 minutes')
          .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
          .onChange(async (value) => {
            this.plugin.settings.autoSyncIntervalMinutes = parseInt(value, 10);
            await this.plugin.saveSettings();
            this.plugin.resetPeriodicSync();
          })
      );

    new Setting(containerEl)
      .setName('Interactive Review (Подтверждение изменений)')
      .setDesc('При нажатии на значок синхронизации показывать окно выбора: какие файлы отправить на Диск, какие скачать, а какие оставить только на устройстве.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.interactiveSync)
          .onChange(async (value) => {
            this.plugin.settings.interactiveSync = value;
            await this.plugin.saveSettings();
          })
      );

    // -------------------------------------------------------------
    // Section 3: End-to-End Encryption (E2EE)
    // -------------------------------------------------------------
    containerEl.createEl('h3', { text: '3. End-to-End Encryption (E2EE)' });

    new Setting(containerEl)
      .setName('Enable Client-Side Encryption')
      .setDesc('Encrypt all notes and attachments locally using AES-256-GCM before uploading.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.e2eeEnabled)
          .onChange(async (value) => {
            this.plugin.settings.e2eeEnabled = value;
            await this.plugin.saveSettings();
            this.display(); // re-render to show/hide password
          })
      );

    if (this.plugin.settings.e2eeEnabled) {
      new Setting(containerEl)
        .setName('Master Passphrase')
        .setDesc('Passphrase for PBKDF2 key derivation. MUST BE IDENTICAL across all devices!')
        .addText((text) => {
          text
            .setPlaceholder('Enter secure passphrase...')
            .setValue(this.plugin.settings.e2eePassword)
            .onChange(async (value) => {
              this.plugin.settings.e2eePassword = value;
              await this.plugin.saveSettings();
            });
          if (text.inputEl) {
            text.inputEl.type = 'password';
          }
        });

      containerEl.createEl('p', {
        cls: 'yandex-sync-warning',
        text: '⚠ Warning: If you lose your passphrase, encrypted files on Yandex Disk cannot be recovered by anyone, including Yandex.',
      });
    }

    // -------------------------------------------------------------
    // Section 4: Manual Trigger & Status
    // -------------------------------------------------------------
    containerEl.createEl('h3', { text: '4. Manual Actions' });

    new Setting(containerEl)
      .setName('Synchronize Now')
      .setDesc('Manually trigger an immediate 3-way synchronization cycle.')
      .addButton((btn) =>
        btn
          .setButtonText('Sync Now')
          .setCta()
          .onClick(async () => {
            await this.plugin.triggerSync();
          })
      );
  }
}
