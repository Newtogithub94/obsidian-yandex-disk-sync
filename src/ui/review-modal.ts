/**
 * src/ui/review-modal.ts
 * Interactive pre-sync review modal allowing users to inspect, cherry-pick,
 * and approve individual upload, download, and deletion actions before execution.
 */

import { App, Modal, Setting } from 'obsidian';
import { SyncAction, SyncPlan } from '../types';

export class SyncReviewModal extends Modal {
  private plan: SyncPlan;
  private onConfirm: (selected: SyncAction[]) => void;
  private onCancel: () => void;
  private actionableItems: SyncAction[];
  private selectedIndices: Set<number>;
  private isResolved: boolean = false;

  constructor(
    app: App,
    plan: SyncPlan,
    onConfirm: (selected: SyncAction[]) => void,
    onCancel: () => void
  ) {
    super(app);
    this.plan = plan;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;

    // Filter down to meaningful actionable operations
    this.actionableItems = plan.actions.filter(
      (a) => a.type !== 'NO_OP' && a.type !== 'RETAIN_TOMBSTONE'
    );

    // By default, all planned actions are checked
    this.selectedIndices = new Set(this.actionableItems.map((_, i) => i));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('yd-review-modal-container');

    // 1. Header
    const headerEl = contentEl.createEl('div', { cls: 'yd-review-header' });
    headerEl.createEl('h2', { text: 'Синхронизация с Яндекс Диском' });
    headerEl.createEl('p', {
      cls: 'yd-review-subtext',
      text: 'Выберите файлы для синхронизации. Снятые галочки не будут затронуты и останутся только на своём исходном месте.',
    });

    // 2. Summary statistics badges
    const statsEl = contentEl.createEl('div', { cls: 'yd-review-stats' });
    const uploadsCount = this.actionableItems.filter((a) =>
      a.type.startsWith('UPLOAD') || a.type === 'REVIVE_LOCAL'
    ).length;
    const downloadsCount = this.actionableItems.filter((a) =>
      a.type.startsWith('DOWNLOAD') || a.type === 'RESTORE_REMOTE_MOD' || a.type === 'REVIVE_REMOTE'
    ).length;
    const deletesCount = this.actionableItems.filter((a) =>
      a.type.startsWith('DELETE')
    ).length;
    const conflictsCount = this.actionableItems.filter((a) =>
      a.type === 'CONFLICT_COPY' || a.type === 'REVIVE_BOTH'
    ).length;

    if (uploadsCount > 0) {
      statsEl.createEl('span', {
        cls: 'yd-badge yd-badge-upload',
        text: `⬆️ На Диск: ${uploadsCount}`,
      });
    }
    if (downloadsCount > 0) {
      statsEl.createEl('span', {
        cls: 'yd-badge yd-badge-download',
        text: `⬇️ С Диска: ${downloadsCount}`,
      });
    }
    if (deletesCount > 0) {
      statsEl.createEl('span', {
        cls: 'yd-badge yd-badge-delete',
        text: `🗑️ Удаления: ${deletesCount}`,
      });
    }
    if (conflictsCount > 0) {
      statsEl.createEl('span', {
        cls: 'yd-badge yd-badge-conflict',
        text: `⚠️ Конфликты: ${conflictsCount}`,
      });
    }

    // 3. Selection toolbar
    const toolbarEl = contentEl.createEl('div', { cls: 'yd-review-toolbar' });
    const countInfoEl = toolbarEl.createEl('span', {
      cls: 'yd-review-count-info',
      text: `Выбрано: ${this.selectedIndices.size} из ${this.actionableItems.length}`,
    });

    const btnGroupEl = toolbarEl.createEl('div', { cls: 'yd-review-btn-group' });
    const selectAllBtn = btnGroupEl.createEl('button', {
      cls: 'yd-mini-btn',
      text: 'Выбрать все',
    });
    const deselectAllBtn = btnGroupEl.createEl('button', {
      cls: 'yd-mini-btn',
      text: 'Снять все',
    });

    // 4. Scrollable list of actionable files
    const listContainer = contentEl.createEl('div', { cls: 'yd-review-list' });
    const checkboxes: HTMLInputElement[] = [];

    this.actionableItems.forEach((action, index) => {
      const itemRow = listContainer.createEl('div', { cls: 'yd-review-item' });

      // Checkbox
      const checkbox = itemRow.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
      checkbox.checked = this.selectedIndices.has(index);
      checkboxes.push(checkbox);

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          this.selectedIndices.add(index);
        } else {
          this.selectedIndices.delete(index);
        }
        updateCounts();
      });

      // Type Badge & Path
      const typeInfo = this.getActionPresentation(action);
      const badge = itemRow.createEl('span', {
        cls: `yd-action-badge ${typeInfo.badgeClass}`,
        text: typeInfo.badgeText,
      });

      const textWrapper = itemRow.createEl('div', { cls: 'yd-item-details' });
      const pathEl = textWrapper.createEl('span', {
        cls: 'yd-item-path',
        text: action.path,
      });
      pathEl.title = action.path;

      const reasonEl = textWrapper.createEl('span', {
        cls: 'yd-item-reason',
        text: typeInfo.reasonText,
      });

      // Clicking row toggles checkbox
      itemRow.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
      });
    });

    // 5. Footer CTA buttons
    const footerEl = contentEl.createEl('div', { cls: 'yd-review-footer' });
    const cancelBtn = footerEl.createEl('button', {
      cls: 'mod-warning',
      text: 'Отмена',
    });
    const confirmBtn = footerEl.createEl('button', {
      cls: 'mod-cta',
      text: `Синхронизировать выбранное (${this.selectedIndices.size})`,
    });

    const updateCounts = () => {
      countInfoEl.setText(`Выбрано: ${this.selectedIndices.size} из ${this.actionableItems.length}`);
      confirmBtn.setText(`Синхронизировать выбранное (${this.selectedIndices.size})`);
      confirmBtn.disabled = this.selectedIndices.size === 0;
    };

    selectAllBtn.addEventListener('click', () => {
      this.actionableItems.forEach((_, i) => this.selectedIndices.add(i));
      checkboxes.forEach((cb) => (cb.checked = true));
      updateCounts();
    });

    deselectAllBtn.addEventListener('click', () => {
      this.selectedIndices.clear();
      checkboxes.forEach((cb) => (cb.checked = false));
      updateCounts();
    });

    cancelBtn.addEventListener('click', () => {
      this.isResolved = true;
      this.close();
      this.onCancel();
    });

    confirmBtn.addEventListener('click', () => {
      this.isResolved = true;
      this.close();
      const approved = this.actionableItems.filter((_, i) => this.selectedIndices.has(i));
      this.onConfirm(approved);
    });
  }

  onClose(): void {
    if (!this.isResolved) {
      this.isResolved = true;
      this.onCancel();
    }
  }

  private getActionPresentation(action: SyncAction): {
    badgeText: string;
    badgeClass: string;
    reasonText: string;
  } {
    const sizeStr = (bytes?: number) => {
      if (!bytes) return '';
      if (bytes < 1024) return ` (${bytes} B)`;
      if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`;
      return ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
    };

    switch (action.type) {
      case 'UPLOAD_LOCAL':
      case 'REVIVE_LOCAL':
        return {
          badgeText: '⬆️ На Диск',
          badgeClass: 'yd-badge-upload',
          reasonText: `Новый локальный файл${sizeStr(action.localFile?.size)}`,
        };
      case 'UPLOAD_LOCAL_MOD':
        return {
          badgeText: '⬆️ На Диск',
          badgeClass: 'yd-badge-upload',
          reasonText: `Локальный файл изменён${sizeStr(action.localFile?.size)}`,
        };
      case 'DOWNLOAD_REMOTE':
      case 'REVIVE_REMOTE':
        return {
          badgeText: '⬇️ С Диска',
          badgeClass: 'yd-badge-download',
          reasonText: `Новый файл на сервере${sizeStr(action.remoteResource?.size)}`,
        };
      case 'RESTORE_REMOTE_MOD':
        return {
          badgeText: '⬇️ С Диска',
          badgeClass: 'yd-badge-download',
          reasonText: `Файл обновлён на сервере${sizeStr(action.remoteResource?.size)}`,
        };
      case 'DELETE_REMOTE':
        return {
          badgeText: '🗑️ Удалить на сервере',
          badgeClass: 'yd-badge-delete',
          reasonText: 'Удалён локально -> удалить копию в облаке',
        };
      case 'DELETE_LOCAL':
        return {
          badgeText: '🗑️ Удалить локально',
          badgeClass: 'yd-badge-delete',
          reasonText: 'Удалён на сервере/другом устройстве -> удалить здесь',
        };
      case 'CONFLICT_COPY':
      case 'REVIVE_BOTH':
        return {
          badgeText: '⚠️ Конфликт',
          badgeClass: 'yd-badge-conflict',
          reasonText: 'Изменён на обоих устройствах -> скачать копию',
        };
      case 'CONVERGE':
        return {
          badgeText: '🔄 Совпадают',
          badgeClass: 'yd-badge-converge',
          reasonText: 'Идентичный файл создан на обоих устройствах',
        };
      default:
        return {
          badgeText: action.type,
          badgeClass: 'yd-badge-default',
          reasonText: action.reason || '',
        };
    }
  }
}
