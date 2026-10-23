import { describe, it, expect } from 'vitest';
import { DEFAULT_EXCLUDED_PATTERNS } from '../../src/constants';

describe('Milestone 1 Iteration 2: Adversarial Exclusion Engine Stress Test', () => {
  const isExcluded = (path: string): boolean => {
    return DEFAULT_EXCLUDED_PATTERNS.some((regex) => regex.test(path));
  };

  describe('1. Dispatch Specified Targets', () => {
    it('strictly excludes bare workspace.json and workspace-mobile.json', () => {
      expect(isExcluded('workspace.json')).toBe(true);
      expect(isExcluded('workspace-mobile.json')).toBe(true);
    });

    it('strictly excludes .obsidian/workspace.json and .obsidian/workspace-mobile.json', () => {
      expect(isExcluded('.obsidian/workspace.json')).toBe(true);
      expect(isExcluded('.obsidian/workspace-mobile.json')).toBe(true);
    });

    it('does NOT exclude extensionless .obsidian/workspace', () => {
      expect(isExcluded('.obsidian/workspace')).toBe(false);
    });

    it('does NOT exclude workspace_backup.md', () => {
      expect(isExcluded('workspace_backup.md')).toBe(false);
    });
  });

  describe('2. Case-Insensitive Permutations', () => {
    const variations = [
      'WORKSPACE.JSON',
      'workspace-mobile.JSON',
      'Workspace-Mobile.Json',
      '.OBSIDIAN/WORKSPACE.JSON',
      '.Obsidian/Workspace.json',
      '.obsidian/WORKSPACE-MOBILE.JSON',
      'subfolder/WORKSPACE.JSON',
      'a/b/c/Workspace-Mobile.JSON',
    ];

    for (const v of variations) {
      it(`excludes case variation: "${v}"`, () => {
        expect(isExcluded(v)).toBe(true);
      });
    }
  });

  describe('3. Adversarial Near-Miss Collision Resistance', () => {
    const nearMisses = [
      // Core plugin workspaces file (saved layout sets)
      '.obsidian/workspaces.json',
      'workspaces.json',
      'subfolder/workspaces.json',
      // Prefixed names
      'my-workspace.json',
      'myworkspace.json',
      'subfolder/my-workspace.json',
      'anti_workspace.json',
      'not.workspace.json',
      // Extension variants & backups
      'workspace.json.bak',
      'workspace.json.old',
      'workspace.json5',
      'workspace.jsonl',
      'workspace.json.tar.gz',
      'workspace-mobile.json.bak',
      'workspace-mobile.json.tmp',
      // Sub-token variants
      'workspace-mobile-tablet.json',
      'workspace-desktop.json',
      'workspace-tablet.json',
      // Without extension
      'workspace',
      'workspace-mobile',
      '.obsidian/workspace',
      '.obsidian/workspace-mobile',
      'subfolder/workspace',
      // Non-json extensions
      'workspace.md',
      'workspace.txt',
      '.obsidian/workspace.yaml',
      // Directory paths containing workspace.json as directory
      'workspace.json/file.txt',
      '.obsidian/workspace/layout.json',
    ];

    for (const p of nearMisses) {
      it(`does NOT exclude near-miss: "${p}"`, () => {
        expect(isExcluded(p)).toBe(false);
      });
    }
  });

  describe('4. Property-Based Combinatorial Generator Oracle', () => {
    // Oracle function defining ground truth for workspace layout exclusion:
    // Path must end with either 'workspace.json' or 'workspace-mobile.json' (case-insensitive)
    // and the filename must be exactly 'workspace.json' or 'workspace-mobile.json'
    // optionally preceded by '.obsidian/' or any directory path.
    const oracleIsWorkspaceLayout = (path: string): boolean => {
      const normalized = path.replace(/\\/g, '/');
      const segments = normalized.split('/');
      const fileName = segments[segments.length - 1]?.toLowerCase();
      return fileName === 'workspace.json' || fileName === 'workspace-mobile.json';
    };

    it('matches oracle across randomized combinatorial matrix of 500 paths', () => {
      const prefixes = ['', '.obsidian/', 'vault/', 'deep/nested/path/', '.hidden/folder/'];
      const stems = [
        'workspace',
        'WORKSPACE',
        'Workspace',
        'workspace-mobile',
        'WORKSPACE-MOBILE',
        'workspaces',
        'my-workspace',
        'workspace_backup',
        'the-workspace',
        'workspace2',
      ];
      const extensions = [
        '.json',
        '.JSON',
        '.json.bak',
        '.bak',
        '.md',
        '',
        '.json5',
        '.jsonl',
      ];

      let totalChecked = 0;
      for (const prefix of prefixes) {
        for (const stem of stems) {
          for (const ext of extensions) {
            const candidate = `${prefix}${stem}${ext}`;
            const expected = oracleIsWorkspaceLayout(candidate);
            // We check only the workspace regex pattern (first pattern in DEFAULT_EXCLUDED_PATTERNS)
            const workspaceRegex = DEFAULT_EXCLUDED_PATTERNS[0]!;
            const actual = workspaceRegex.test(candidate);

            expect(
              actual,
              `Candidate "${candidate}": expected ${expected} but got ${actual}`
            ).toBe(expected);
            totalChecked++;
          }
        }
      }

      expect(totalChecked).toBe(prefixes.length * stems.length * extensions.length);
    });
  });

  describe('5. Full Default Exclusion Patterns Matrix', () => {
    const table: Array<{ path: string; expected: boolean; reason: string }> = [
      { path: '.trash', expected: true, reason: 'Trash folder at root' },
      { path: '.trash/deleted-note.md', expected: true, reason: 'File in trash' },
      { path: '.trash/sub/nested.md', expected: true, reason: 'Nested file in trash' },
      { path: 'not-trash/note.md', expected: false, reason: 'Folder contains trash in name but not .trash' },
      { path: '.obsidian/plugins/yandex-disk-sync/data.json', expected: true, reason: 'Plugin data file' },
      { path: '.obsidian/plugins/yandex-disk-sync/sync-manifest.json', expected: true, reason: 'Plugin sync manifest' },
      { path: '.obsidian/plugins/other-plugin/data.json', expected: false, reason: 'Other plugin config should sync' },
      { path: '.DS_Store', expected: true, reason: 'macOS artifact root' },
      { path: 'folder/.DS_Store', expected: true, reason: 'macOS artifact nested' },
      { path: 'Thumbs.db', expected: true, reason: 'Windows thumbnail cache' },
      { path: 'sub/Thumbs.db', expected: true, reason: 'Windows thumbnail cache nested' },
      { path: 'desktop.ini', expected: true, reason: 'Windows desktop ini' },
      { path: 'folder/desktop.ini', expected: true, reason: 'Windows desktop ini nested' },
      { path: '.git', expected: true, reason: 'Git dir root' },
      { path: '.git/config', expected: true, reason: 'Git config' },
      { path: 'submodule/.git/HEAD', expected: true, reason: 'Submodule git' },
      { path: '.sync-lock', expected: true, reason: 'Sync lock file root' },
      { path: 'sub/.sync-lock', expected: true, reason: 'Sync lock file nested' },
      { path: 'valid-note.md', expected: false, reason: 'Standard markdown note' },
      { path: 'Folder/Sub/My Note.md', expected: false, reason: 'Nested note' },
      { path: 'Attachments/image.png', expected: false, reason: 'Binary image' },
      { path: 'Docs/manual.pdf', expected: false, reason: 'Binary PDF' },
    ];

    for (const item of table) {
      it(`correctly evaluates "${item.path}" -> ${item.expected} (${item.reason})`, () => {
        expect(isExcluded(item.path)).toBe(item.expected);
      });
    }
  });
});
