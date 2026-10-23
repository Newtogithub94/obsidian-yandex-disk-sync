/**
 * tests/unit/diff-engine.test.ts
 * Unit tests validating the 16-state 3-way synchronization decision matrix.
 */

import { describe, it, expect } from 'vitest';
import { DiffEngine, DiffInput, LocalFileScan } from '../../src/sync/diff-engine';
import { FileManifestEntry, YandexResourceItem } from '../../src/types';
import { TOMBSTONE_RETENTION_MS } from '../../src/constants';

describe('DiffEngine 16-State Decision Matrix Suite', () => {
  const engine = new DiffEngine();

  function makeBase(path: string, hash: string, etag: string, tombstone = false, tombstoneAge = 0): FileManifestEntry {
    return {
      path,
      localHash: hash,
      localMtime: 1000,
      localSize: 100,
      remoteHash: hash,
      remoteEtag: etag,
      remoteModified: '2026-10-21T10:00:00Z',
      remoteSize: 100,
      encrypted: false,
      tombstone,
      tombstoneTimestamp: tombstone ? Date.now() - tombstoneAge : null,
    };
  }

  function makeLocal(path: string, hash: string): LocalFileScan {
    return {
      path,
      hash,
      mtime: 2000,
      size: 100,
    };
  }

  function makeRemote(path: string, etag: string, hash?: string): YandexResourceItem {
    return {
      name: path.split('/').pop()!,
      path: `app:/${path}`,
      type: 'file',
      size: 100,
      etag,
      sha256: hash,
      modified: '2026-10-21T12:00:00Z',
    };
  }

  it('State 1: New local file (Base: -, Local: +, Remote: -) -> UPLOAD_LOCAL', () => {
    const input: DiffInput = {
      baseEntries: {},
      localFiles: new Map([['Notes/New.md', makeLocal('Notes/New.md', 'hash1')]]),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('UPLOAD_LOCAL');
    expect(plan.actions[0]!.path).toBe('Notes/New.md');
  });

  it('State 2: New remote file (Base: -, Local: -, Remote: +) -> DOWNLOAD_REMOTE', () => {
    const input: DiffInput = {
      baseEntries: {},
      localFiles: new Map(),
      remoteFiles: new Map([['Notes/Remote.md', makeRemote('Notes/Remote.md', 'etag1', 'hash1')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('DOWNLOAD_REMOTE');
    expect(plan.actions[0]!.path).toBe('Notes/Remote.md');
  });

  it('State 3a: Both created same content (Base: -, Local: +, Remote: +, Hashes equal) -> CONVERGE', () => {
    const input: DiffInput = {
      baseEntries: {},
      localFiles: new Map([['Notes/Same.md', makeLocal('Notes/Same.md', 'hash1')]]),
      remoteFiles: new Map([['Notes/Same.md', makeRemote('Notes/Same.md', 'etag1', 'hash1')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('CONVERGE');
  });

  it('State 3b: Both created different content (Base: -, Local: +, Remote: +, Hashes differ) -> CONFLICT_COPY', () => {
    const input: DiffInput = {
      baseEntries: {},
      localFiles: new Map([['Notes/Conflict.md', makeLocal('Notes/Conflict.md', 'hashA')]]),
      remoteFiles: new Map([['Notes/Conflict.md', makeRemote('Notes/Conflict.md', 'etag1', 'hashB')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('CONFLICT_COPY');
    expect(plan.actions[0]!.conflictPath).toMatch(/Notes\/Conflict\.conflict-\d{8}-\d{6}\.md/);
  });

  it('State 4: Unmodified on both sides (Base: +, Local: =, Remote: =) -> NO_OP', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hash1', 'etag1') },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hash1')]]),
      remoteFiles: new Map([['Notes/Note.md', makeRemote('Notes/Note.md', 'etag1', 'hash1')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('NO_OP');
  });

  it('State 5: Modified locally, unchanged remotely -> UPLOAD_LOCAL', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hashOld', 'etag1') },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hashNew')]]),
      remoteFiles: new Map([['Notes/Note.md', makeRemote('Notes/Note.md', 'etag1', 'hashOld')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('UPLOAD_LOCAL');
  });

  it('State 6: Unchanged locally, modified remotely -> DOWNLOAD_REMOTE', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hashOld', 'etagOld') },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hashOld')]]),
      remoteFiles: new Map([['Notes/Note.md', makeRemote('Notes/Note.md', 'etagNew', 'hashNew')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('DOWNLOAD_REMOTE');
  });

  it('State 7: Concurrent modification on both sides -> CONFLICT_COPY', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hashOld', 'etagOld') },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hashLocal')]]),
      remoteFiles: new Map([['Notes/Note.md', makeRemote('Notes/Note.md', 'etagRemote', 'hashRemote')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('CONFLICT_COPY');
    expect(plan.actions[0]!.conflictPath).toBeDefined();
  });

  it('State 8: Deleted locally, unchanged remotely -> DELETE_REMOTE', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hash1', 'etag1') },
      localFiles: new Map(),
      remoteFiles: new Map([['Notes/Note.md', makeRemote('Notes/Note.md', 'etag1', 'hash1')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('DELETE_REMOTE');
  });

  it('State 9: Unchanged locally, deleted remotely -> DELETE_LOCAL', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hash1', 'etag1') },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hash1')]]),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('DELETE_LOCAL');
  });

  it('State 10: Deleted on both sides -> CONVERGE_DELETE', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hash1', 'etag1') },
      localFiles: new Map(),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('CONVERGE_DELETE');
  });

  it('State 11: Deleted locally, modified remotely -> RESTORE_REMOTE_MOD (remote mod wins)', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hashOld', 'etagOld') },
      localFiles: new Map(),
      remoteFiles: new Map([['Notes/Note.md', makeRemote('Notes/Note.md', 'etagNew', 'hashNew')]]),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('RESTORE_REMOTE_MOD');
  });

  it('State 12: Modified locally, deleted remotely -> UPLOAD_LOCAL_MOD (local mod wins)', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', 'hashOld', 'etagOld') },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hashNew')]]),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('UPLOAD_LOCAL_MOD');
  });

  it('State 13: Tombstone under 30 days retained -> RETAIN_TOMBSTONE', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', '', '', true, 5000) },
      localFiles: new Map(),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('RETAIN_TOMBSTONE');
  });

  it('State 14: Tombstone over 30 days purged -> PURGE_TOMBSTONE', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', '', '', true, TOMBSTONE_RETENTION_MS + 1000) },
      localFiles: new Map(),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('PURGE_TOMBSTONE');
  });

  it('State 15: Revived locally after tombstone -> REVIVE_LOCAL', () => {
    const input: DiffInput = {
      baseEntries: { 'Notes/Note.md': makeBase('Notes/Note.md', '', '', true, 5000) },
      localFiles: new Map([['Notes/Note.md', makeLocal('Notes/Note.md', 'hashRevived')]]),
      remoteFiles: new Map(),
    };
    const plan = engine.computeDiff(input);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.type).toBe('REVIVE_LOCAL');
  });
});
