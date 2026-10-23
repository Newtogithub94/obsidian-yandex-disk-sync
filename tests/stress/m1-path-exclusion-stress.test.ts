import { describe, it, expect } from 'vitest';
import { DEFAULT_EXCLUDED_PATTERNS } from '../../src/constants';

describe('Milestone 1 Empirical Challenger: Path Exclusion Boundary Stress Harness', () => {
  const isExcluded = (path: string): boolean => {
    return DEFAULT_EXCLUDED_PATTERNS.some((regex) => regex.test(path));
  };

  describe('1. Boundary Path Verification (Specified in Dispatch)', () => {
    it('.obsidian/workspace.json is excluded', () => {
      expect(isExcluded('.obsidian/workspace.json')).toBe(true);
    });

    it('.obsidian/workspace-mobile.json is excluded', () => {
      expect(isExcluded('.obsidian/workspace-mobile.json')).toBe(true);
    });

    it('.trash/note.md is excluded', () => {
      expect(isExcluded('.trash/note.md')).toBe(true);
    });

    it('folder/sub/.DS_Store is excluded', () => {
      expect(isExcluded('folder/sub/.DS_Store')).toBe(true);
    });

    it('valid-note.md is NOT excluded (no false positive)', () => {
      expect(isExcluded('valid-note.md')).toBe(false);
    });

    it('workspace_backup.md is NOT excluded (no false positive)', () => {
      expect(isExcluded('workspace_backup.md')).toBe(false);
    });
  });

  describe('2. Extended Boundary Cases & OS Artifacts', () => {
    it('excludes all OS desktop metadata artifacts at root and nested', () => {
      const osArtifacts = [
        '.DS_Store',
        'subfolder/.DS_Store',
        'deep/nested/sub/.DS_Store',
        'Thumbs.db',
        'images/Thumbs.db',
        'desktop.ini',
        'docs/desktop.ini',
      ];
      for (const p of osArtifacts) {
        expect(isExcluded(p), `Expected "${p}" to be excluded`).toBe(true);
      }
    });

    it('excludes Git directories and sync lock files', () => {
      const gitAndLocks = [
        '.git/config',
        'submodule/.git/HEAD',
        '.sync-lock',
        'folder/.sync-lock',
      ];
      for (const p of gitAndLocks) {
        expect(isExcluded(p), `Expected "${p}" to be excluded`).toBe(true);
      }
    });

    it('excludes plugin data and manifest storage directory', () => {
      expect(isExcluded('.obsidian/plugins/yandex-disk-sync/data.json')).toBe(true);
      expect(isExcluded('.obsidian/plugins/yandex-disk-sync/sync-manifest.json')).toBe(true);
      // Other plugins should NOT be excluded by default
      expect(isExcluded('.obsidian/plugins/other-plugin/main.js')).toBe(false);
    });

    it('does NOT exclude valid user notes with similar names', () => {
      const validNotes = [
        'Notes/git-tutorial.md',
        'Projects/trash-collection-system.md',
        'DS_Store_analysis.md',
        'sync-lock-investigation.md',
      ];
      for (const p of validNotes) {
        expect(isExcluded(p), `Expected valid note "${p}" to NOT be excluded`).toBe(false);
      }
    });
  });

  describe('3. Empirical Defect Identification: Bare Workspace Layout Files', () => {
    it('DEFECT 1 REMEDIATED: Bare "workspace.json" and "workspace-mobile.json" are successfully excluded', () => {
      const bareWorkspace = isExcluded('workspace.json');
      const bareMobileWorkspace = isExcluded('workspace-mobile.json');

      expect(bareWorkspace).toBe(true);
      expect(bareMobileWorkspace).toBe(true);
    });

    it('DEFECT 2 REMEDIATED: Pattern does not match ".obsidian/workspace" without extension', () => {
      const matchesNoExtension = isExcluded('.obsidian/workspace');
      expect(matchesNoExtension).toBe(false);
    });

    it('MITIGATION PROOF: Proposed regex resolves both defects without false positives', () => {
      const proposedRegex = /(^|\/)(\.obsidian\/)?workspace(-mobile)?\.json$/i;

      // Positive matches (should be excluded)
      expect(proposedRegex.test('workspace.json')).toBe(true);
      expect(proposedRegex.test('workspace-mobile.json')).toBe(true);
      expect(proposedRegex.test('.obsidian/workspace.json')).toBe(true);
      expect(proposedRegex.test('.obsidian/workspace-mobile.json')).toBe(true);
      expect(proposedRegex.test('folder/workspace.json')).toBe(true);

      // Negative matches (should NOT be excluded)
      expect(proposedRegex.test('workspace_backup.md')).toBe(false);
      expect(proposedRegex.test('valid-note.md')).toBe(false);
      expect(proposedRegex.test('.obsidian/workspace')).toBe(false);
      expect(proposedRegex.test('workspace.json.bak')).toBe(false);
    });
  });
});
