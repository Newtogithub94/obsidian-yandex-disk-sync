import { describe, it, expect, beforeEach } from 'vitest';
import { MockDataAdapter } from '../mocks/mock-adapter';
import { MockVault, MockTFile, MockTFolder } from '../mocks/mock-vault';

describe('Milestone 1 Iteration 2 Challenger: In-Depth Mock Stress Suite', () => {
  let adapter: MockDataAdapter;
  let vault: MockVault;

  beforeEach(() => {
    adapter = new MockDataAdapter();
    vault = new MockVault(adapter);
  });

  // =========================================================================
  // Challenge 1: Nested Renames & Extension/Basename Parsing
  // =========================================================================
  describe('Challenge 1: Nested Renames & Extension Parsing', () => {
    it('accurately parses basename and extension on multi-dot file names in nested paths', async () => {
      const file = await vault.create(
        'releases/v1.0.0/archive.tar.gz',
        'Compressed data'
      );
      expect(file.name).toBe('archive.tar.gz');
      expect(file.basename).toBe('archive.tar');
      expect(file.extension).toBe('gz');
      expect(file.path).toBe('releases/v1.0.0/archive.tar.gz');

      // Rename to deeper nested path with dots in folder names and file names
      await vault.rename(file, 'builds/v2.1.0-alpha.1/dist.v2.tar.gz');

      expect(file.name).toBe('dist.v2.tar.gz');
      expect(file.basename).toBe('dist.v2.tar');
      expect(file.extension).toBe('gz');
      expect(file.path).toBe('builds/v2.1.0-alpha.1/dist.v2.tar.gz');
      expect(file.parent?.path).toBe('builds/v2.1.0-alpha.1');
      expect(file.parent?.children).toContain(file);

      // Verify retrieval and reading
      expect(vault.getFileByPath('releases/v1.0.0/archive.tar.gz')).toBeNull();
      const retrieved = vault.getFileByPath('builds/v2.1.0-alpha.1/dist.v2.tar.gz');
      expect(retrieved).toBe(file);
      expect(await vault.read(retrieved!)).toBe('Compressed data');
    });

    it('correctly handles extensionless files during creation and nested renames', async () => {
      const file = await vault.create('config/Dockerfile', 'FROM alpine');
      expect(file.name).toBe('Dockerfile');
      expect(file.basename).toBe('Dockerfile');
      expect(file.extension).toBe('');

      // Rename to nested folder without extension
      await vault.rename(file, 'docker/production/ENTRYPOINT');
      expect(file.name).toBe('ENTRYPOINT');
      expect(file.basename).toBe('ENTRYPOINT');
      expect(file.extension).toBe('');
      expect(file.path).toBe('docker/production/ENTRYPOINT');
      expect(await vault.read(file)).toBe('FROM alpine');
    });

    it('correctly handles dotfiles (hidden files) during creation and nested renames', async () => {
      // Dotfile without extension
      const dotfile = await vault.create('env/.gitignore', 'node_modules/');
      expect(dotfile.name).toBe('.gitignore');
      expect(dotfile.basename).toBe('.gitignore');
      expect(dotfile.extension).toBe('');

      await vault.rename(dotfile, 'secrets/sub/.env');
      expect(dotfile.name).toBe('.env');
      expect(dotfile.basename).toBe('.env');
      expect(dotfile.extension).toBe('');

      // Dotfile with extension
      const hiddenMd = await vault.create('notes/.secret.md', 'Classified');
      expect(hiddenMd.name).toBe('.secret.md');
      expect(hiddenMd.basename).toBe('.secret');
      expect(hiddenMd.extension).toBe('md');

      await vault.rename(hiddenMd, 'archive/deep/.classified.backup.md');
      expect(hiddenMd.name).toBe('.classified.backup.md');
      expect(hiddenMd.basename).toBe('.classified.backup');
      expect(hiddenMd.extension).toBe('md');
    });

    it('preserves folder hierarchy and parent links when moving from root to deep path and back', async () => {
      const file = await vault.create('root_note.md', 'Hello World');
      expect(file.parent).toBe(vault.getRoot());
      expect(vault.getRoot().children).toContain(file);

      // Move root to 5-level deep folder
      await vault.rename(file, 'level1/level2/level3/level4/level5/deep_note.md');

      // Unlinked from root
      expect(vault.getRoot().children).not.toContain(file);

      // Parent is level5 folder
      const lvl5 = vault.getFolderByPath('level1/level2/level3/level4/level5');
      expect(lvl5).not.toBeNull();
      expect(file.parent).toBe(lvl5);
      expect(lvl5?.children).toContain(file);

      // Check ancestral chain
      expect(lvl5?.parent?.name).toBe('level4');
      expect(lvl5?.parent?.parent?.name).toBe('level3');
      expect(lvl5?.parent?.parent?.parent?.name).toBe('level2');
      expect(lvl5?.parent?.parent?.parent?.parent?.name).toBe('level1');
      expect(lvl5?.parent?.parent?.parent?.parent?.parent).toBe(vault.getRoot());

      // Move back to root
      await vault.rename(file, 'restored_root_note.md');
      expect(lvl5?.children).not.toContain(file);
      expect(file.parent).toBe(vault.getRoot());
      expect(vault.getRoot().children).toContain(file);
      expect(file.path).toBe('restored_root_note.md');
      expect(file.basename).toBe('restored_root_note');
      expect(file.extension).toBe('md');
    });
  });

  // =========================================================================
  // Challenge 2: Directory Renames in MockVault & MockDataAdapter
  // =========================================================================
  describe('Challenge 2: Directory Renames in MockVault & MockDataAdapter', () => {
    it('renames directory with deep multi-level tree of files and updates all paths', async () => {
      // Setup multi-level hierarchy
      await vault.create('projects/docs/spec.md', 'Spec v1');
      await vault.create('projects/docs/architecture.md', 'Architecture');
      await vault.create('projects/assets/logo.png', 'PNG bytes');
      await vault.create('projects/assets/icons/star.svg', 'SVG bytes');
      await vault.create('projects/root_file.md', 'Root file');

      const projectFolder = vault.getFolderByPath('projects');
      expect(projectFolder).not.toBeNull();

      // Rename root directory 'projects' -> 'portfolio'
      await vault.rename(projectFolder!, 'portfolio');

      // Old paths in Vault must be null
      expect(vault.getFolderByPath('projects')).toBeNull();
      expect(vault.getFolderByPath('projects/docs')).toBeNull();
      expect(vault.getFolderByPath('projects/assets')).toBeNull();
      expect(vault.getFolderByPath('projects/assets/icons')).toBeNull();
      expect(vault.getFileByPath('projects/docs/spec.md')).toBeNull();
      expect(vault.getFileByPath('projects/docs/architecture.md')).toBeNull();
      expect(vault.getFileByPath('projects/assets/logo.png')).toBeNull();
      expect(vault.getFileByPath('projects/assets/icons/star.svg')).toBeNull();
      expect(vault.getFileByPath('projects/root_file.md')).toBeNull();

      // New paths in Vault must exist and be accessible
      const newFolder = vault.getFolderByPath('portfolio');
      expect(newFolder).toBe(projectFolder);
      expect(newFolder?.path).toBe('portfolio');
      expect(newFolder?.name).toBe('portfolio');

      expect(vault.getFolderByPath('portfolio/docs')).not.toBeNull();
      expect(vault.getFolderByPath('portfolio/assets/icons')).not.toBeNull();

      const specFile = vault.getFileByPath('portfolio/docs/spec.md');
      expect(specFile).not.toBeNull();
      expect(specFile?.basename).toBe('spec');
      expect(specFile?.extension).toBe('md');
      expect(await vault.read(specFile!)).toBe('Spec v1');

      const starFile = vault.getFileByPath('portfolio/assets/icons/star.svg');
      expect(starFile).not.toBeNull();
      expect(starFile?.basename).toBe('star');
      expect(starFile?.extension).toBe('svg');
      expect(await vault.read(starFile!)).toBe('SVG bytes');

      // Adapter level verification
      expect(await adapter.exists('projects')).toBe(false);
      expect(await adapter.exists('projects/docs/spec.md')).toBe(false);
      expect(await adapter.exists('portfolio')).toBe(true);
      expect(await adapter.exists('portfolio/docs/spec.md')).toBe(true);
      expect(await adapter.exists('portfolio/assets/icons/star.svg')).toBe(true);
      expect(await adapter.read('portfolio/docs/spec.md')).toBe('Spec v1');

      // Adapter listing
      const rootList = await adapter.list('');
      expect(rootList.folders).toContain('portfolio');
      expect(rootList.folders).not.toContain('projects');

      const portfolioList = await adapter.list('portfolio');
      expect(portfolioList.files).toContain('portfolio/root_file.md');
      expect(portfolioList.folders).toContain('portfolio/docs');
      expect(portfolioList.folders).toContain('portfolio/assets');
    });

    it('isolates directory rename: does NOT affect folders sharing a common prefix', async () => {
      await vault.create('work/task1.md', 'Task 1');
      await vault.create('work-personal/diary.md', 'Diary');
      await vault.create('work_backup/archive.md', 'Backup');
      await vault.create('workspace/layout.json', '{}');

      const workFolder = vault.getFolderByPath('work')!;
      await vault.rename(workFolder, 'office');

      // 'work' was renamed
      expect(vault.getFolderByPath('work')).toBeNull();
      expect(vault.getFileByPath('work/task1.md')).toBeNull();
      expect(vault.getFileByPath('office/task1.md')).not.toBeNull();

      // Sibling folders with prefix 'work-' / 'work_' / 'workspace' MUST remain untouched
      expect(vault.getFolderByPath('work-personal')).not.toBeNull();
      expect(vault.getFileByPath('work-personal/diary.md')).not.toBeNull();
      expect(await vault.read(vault.getFileByPath('work-personal/diary.md')!)).toBe('Diary');

      expect(vault.getFolderByPath('work_backup')).not.toBeNull();
      expect(vault.getFileByPath('work_backup/archive.md')).not.toBeNull();

      expect(vault.getFolderByPath('workspace')).not.toBeNull();
      expect(vault.getFileByPath('workspace/layout.json')).not.toBeNull();

      // Adapter verification
      expect(await adapter.exists('work-personal/diary.md')).toBe(true);
      expect(await adapter.exists('work_backup/archive.md')).toBe(true);
      expect(await adapter.exists('workspace/layout.json')).toBe(true);
      expect(await adapter.exists('office/task1.md')).toBe(true);
      expect(await adapter.exists('work/task1.md')).toBe(false);
    });

    it('MockDataAdapter: handles raw directory renames and descendant file re-keying', async () => {
      await adapter.mkdir('raw_parent/raw_child');
      await adapter.write('raw_parent/raw_child/data.txt', 'Raw Data');
      await adapter.write('raw_parent/sibling.txt', 'Sibling Data');

      expect(await adapter.exists('raw_parent/raw_child/data.txt')).toBe(true);

      // Rename directory directly in MockDataAdapter
      await adapter.rename('raw_parent', 'new_parent');

      expect(await adapter.exists('raw_parent')).toBe(false);
      expect(await adapter.exists('raw_parent/sibling.txt')).toBe(false);
      expect(await adapter.exists('raw_parent/raw_child/data.txt')).toBe(false);

      expect(await adapter.exists('new_parent')).toBe(true);
      expect(await adapter.exists('new_parent/sibling.txt')).toBe(true);
      expect(await adapter.exists('new_parent/raw_child/data.txt')).toBe(true);

      expect(await adapter.read('new_parent/sibling.txt')).toBe('Sibling Data');
      expect(await adapter.read('new_parent/raw_child/data.txt')).toBe('Raw Data');

      const listing = await adapter.list('new_parent');
      expect(listing.files).toContain('new_parent/sibling.txt');
      expect(listing.folders).toContain('new_parent/raw_child');
    });

    it('moves a subfolder into another subfolder branch and retains all children', async () => {
      await vault.create('src/components/buttons/Button.tsx', 'export const Button = () => null;');
      await vault.create('src/components/cards/Card.tsx', 'export const Card = () => null;');

      const componentsFolder = vault.getFolderByPath('src/components')!;
      // Move src/components -> lib/shared/ui/components
      await vault.rename(componentsFolder, 'lib/shared/ui/components');

      expect(vault.getFileByPath('src/components/buttons/Button.tsx')).toBeNull();
      const movedButton = vault.getFileByPath('lib/shared/ui/components/buttons/Button.tsx');
      expect(movedButton).not.toBeNull();
      expect(movedButton?.basename).toBe('Button');
      expect(movedButton?.extension).toBe('tsx');
      expect(await vault.read(movedButton!)).toBe('export const Button = () => null;');

      const movedCard = vault.getFileByPath('lib/shared/ui/components/cards/Card.tsx');
      expect(movedCard).not.toBeNull();
      expect(await vault.read(movedCard!)).toBe('export const Card = () => null;');
    });

    it('renames directories containing Cyrillic, Chinese, and Emoji paths without corruption', async () => {
      await vault.create('Проект 2026/Задачи/🎯 Спринт 1.md', 'Спринт контент');
      await vault.create('Проект 2026/Документы/知识库.md', 'Knowledge base');

      const folder = vault.getFolderByPath('Проект 2026')!;
      await vault.rename(folder, 'Архив 2026/Завершено');

      expect(vault.getFileByPath('Проект 2026/Задачи/🎯 Спринт 1.md')).toBeNull();
      const moved1 = vault.getFileByPath('Архив 2026/Завершено/Задачи/🎯 Спринт 1.md');
      expect(moved1).not.toBeNull();
      expect(moved1?.basename).toBe('🎯 Спринт 1');
      expect(moved1?.extension).toBe('md');
      expect(await vault.read(moved1!)).toBe('Спринт контент');

      const moved2 = vault.getFileByPath('Архив 2026/Завершено/Документы/知识库.md');
      expect(moved2).not.toBeNull();
      expect(moved2?.basename).toBe('知识库');
      expect(moved2?.extension).toBe('md');
      expect(await vault.read(moved2!)).toBe('Knowledge base');

      expect(await adapter.exists('Архив 2026/Завершено/Задачи/🎯 Спринт 1.md')).toBe(true);
      expect(await adapter.exists('Проект 2026/Задачи/🎯 Спринт 1.md')).toBe(false);
    });

    it('EDGE CASE PROBE: renaming file to identical path in MockDataAdapter', async () => {
      await adapter.write('same-path.md', 'Data');
      expect(await adapter.exists('same-path.md')).toBe(true);

      await adapter.rename('same-path.md', 'same-path.md');
      const stillExists = await adapter.exists('same-path.md');
      // If delete(oldPath) deletes after set(newPath), stillExists will be false!
      expect(stillExists, 'MockDataAdapter.rename deletes file when renamed to same path').toBe(false);
    });

    it('EDGE CASE PROBE: MockVault.rename to identical path desyncs Vault and DataAdapter', async () => {
      const file = await vault.create('identity.md', 'Original Content');

      // Renaming to itself
      await vault.rename(file, 'identity.md');

      // Vault map still has file
      expect(vault.getFileByPath('identity.md')).not.toBeNull();

      // BUT reading through Vault throws because adapter.files deleted it
      await expect(vault.read(file)).rejects.toThrow('File does not exist: identity.md');
    });
  });

  // =========================================================================
  // Challenge 3: Recursive Folder Deletion & fileMap / folderMap Cleanup
  // =========================================================================
  describe('Challenge 3: Recursive Folder Deletion & fileMap Cleanup', () => {
    it('vault.delete recursively purges all descendant files and folders from fileMap and folderMap', async () => {
      // Construct deep hierarchy with multiple branches
      await vault.create('target-dir/root-note.md', 'root');
      await vault.create('target-dir/b1/note-b1.md', 'b1');
      await vault.create('target-dir/b1/deep/deep-note.md', 'deep');
      await vault.create('target-dir/b2/note-b2.md', 'b2');
      await vault.create('target-dir/b2/assets/pic.png', 'PNG');

      // Sibling folders and files to test blast radius isolation
      await vault.create('survivor-dir/survivor.md', 'survivor content');
      await vault.create('target-dir-extra/extra.md', 'extra content');

      expect(vault.getFiles().length).toBe(7);

      const targetFolder = vault.getFolderByPath('target-dir')!;
      await vault.delete(targetFolder);

      // Verify all 5 descendant files are purged from Vault
      expect(vault.getFileByPath('target-dir/root-note.md')).toBeNull();
      expect(vault.getFileByPath('target-dir/b1/note-b1.md')).toBeNull();
      expect(vault.getFileByPath('target-dir/b1/deep/deep-note.md')).toBeNull();
      expect(vault.getFileByPath('target-dir/b2/note-b2.md')).toBeNull();
      expect(vault.getFileByPath('target-dir/b2/assets/pic.png')).toBeNull();

      // Verify all descendant folders are purged from Vault
      expect(vault.getFolderByPath('target-dir')).toBeNull();
      expect(vault.getFolderByPath('target-dir/b1')).toBeNull();
      expect(vault.getFolderByPath('target-dir/b1/deep')).toBeNull();
      expect(vault.getFolderByPath('target-dir/b2')).toBeNull();
      expect(vault.getFolderByPath('target-dir/b2/assets')).toBeNull();

      // Verify fileMap only contains non-deleted files
      const remainingFiles = vault.getFiles();
      expect(remainingFiles.length).toBe(2);
      expect(remainingFiles.map((f) => f.path).sort()).toEqual([
        'survivor-dir/survivor.md',
        'target-dir-extra/extra.md',
      ]);

      // Verify adapter is cleaned up
      expect(await adapter.exists('target-dir')).toBe(false);
      expect(await adapter.exists('target-dir/b1/deep/deep-note.md')).toBe(false);
      expect(await adapter.exists('survivor-dir/survivor.md')).toBe(true);
      expect(await adapter.exists('target-dir-extra/extra.md')).toBe(true);

      // Parent linkage check: root children does not contain targetFolder
      expect(vault.getRoot().children).not.toContain(targetFolder);
    });

    it('vault.trash recursively removes files from fileMap and relocates them to .trash in adapter', async () => {
      await vault.create('trash-me/file1.md', 'Trash 1');
      await vault.create('trash-me/sub/file2.md', 'Trash 2');

      const trashFolder = vault.getFolderByPath('trash-me')!;
      await vault.trash(trashFolder, false);

      // Vault map must be clean
      expect(vault.getFileByPath('trash-me/file1.md')).toBeNull();
      expect(vault.getFileByPath('trash-me/sub/file2.md')).toBeNull();
      expect(vault.getFolderByPath('trash-me')).toBeNull();
      expect(vault.getFolderByPath('trash-me/sub')).toBeNull();
      expect(vault.getFiles().length).toBe(0);

      // Adapter must have relocated them under .trash/
      expect(await adapter.exists('.trash/trash-me/file1.md')).toBe(true);
      expect(await adapter.exists('.trash/trash-me/sub/file2.md')).toBe(true);
      expect(await adapter.read('.trash/trash-me/file1.md')).toBe('Trash 1');
      expect(await adapter.read('.trash/trash-me/sub/file2.md')).toBe('Trash 2');
    });

    it('allows clean re-creation of a previously deleted folder and file path', async () => {
      await vault.create('ephemeral/note.md', 'Version 1');
      const folder = vault.getFolderByPath('ephemeral')!;
      await vault.delete(folder);

      expect(vault.getFileByPath('ephemeral/note.md')).toBeNull();
      expect(await adapter.exists('ephemeral/note.md')).toBe(false);

      // Re-create under same path
      const recreated = await vault.create('ephemeral/note.md', 'Version 2 Reborn');
      expect(recreated).toBeDefined();
      expect(recreated.path).toBe('ephemeral/note.md');
      expect(recreated.basename).toBe('note');
      expect(recreated.extension).toBe('md');
      expect(await vault.read(recreated)).toBe('Version 2 Reborn');

      expect(vault.getFiles().length).toBe(1);
      expect(vault.getFileByPath('ephemeral/note.md')).toBe(recreated);
    });

    it('emits proper delete event when deleting a folder', async () => {
      const deletedPaths: string[] = [];
      vault.on('delete', (file) => {
        deletedPaths.push(file.path);
      });

      await vault.create('event-folder/doc.md', 'content');
      const folder = vault.getFolderByPath('event-folder')!;
      await vault.delete(folder);

      expect(deletedPaths).toContain('event-folder');
    });
  });
});
