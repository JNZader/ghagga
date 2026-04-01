import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMemoryStorage } from './sqlite.js';
import {
  BranchExistsError,
  BranchNotFoundError,
  MemoryVersioning,
  ProtectedBranchError,
  SnapshotExistsError,
  SnapshotNotFoundError,
} from './versioning.js';

// ─── Setup ──────────────────────────────────────────────────────

let storage: SqliteMemoryStorage;
let versioning: MemoryVersioning;
let testCounter = 0;

async function freshSetup() {
  testCounter++;
  // Each test gets a fresh temporary file path to avoid any state leak
  const tmpPath = `/tmp/ghagga-versioning-test-${Date.now()}-${testCounter}.db`;
  storage = await SqliteMemoryStorage.create(tmpPath);
  versioning = new MemoryVersioning(storage);
}

// ─── Helper ─────────────────────────────────────────────────────

async function addObservation(project = 'test/repo', title = 'test finding') {
  return storage.saveObservation({
    project,
    type: 'discovery',
    title,
    content: `[HIGH] security\nFile: src/auth.ts\nIssue: ${title}`,
    filePaths: ['src/auth.ts'],
    severity: 'high',
  });
}

// biome-ignore lint/suspicious/noExplicitAny: test access to raw db
function rawDb(): any {
  return storage.getDatabase();
}

// ─── Branch Operations ──────────────────────────────────────────

describe('branches', () => {
  beforeEach(async () => {
    await freshSetup();
  });

  it('lists the default main branch', () => {
    const branches = versioning.listBranches();
    expect(branches).toHaveLength(1);
    expect(branches[0]?.name).toBe('main');
    expect(branches[0]?.parentId).toBeNull();
  });

  it('creates a new branch from main', () => {
    const branch = versioning.createBranch('experiment');
    expect(branch.name).toBe('experiment');
    expect(branch.parentId).toBe(1); // main's id

    const branches = versioning.listBranches();
    expect(branches).toHaveLength(2);
  });

  it('copies observation links when creating a branch', async () => {
    await addObservation('p', 'obs1');
    await addObservation('p', 'obs2');

    versioning.createBranch('exp');

    const mainIds = versioning.getBranchObservationIds('main');
    const expIds = versioning.getBranchObservationIds('exp');
    expect(expIds).toEqual(mainIds);
  });

  it('isolates new observations on branch', async () => {
    versioning.createBranch('exp');

    // Add an observation — it goes to main (default behavior of saveObservation)
    await addObservation('p', 'main-only');

    const mainIds = versioning.getBranchObservationIds('main');
    const expIds = versioning.getBranchObservationIds('exp');

    // Main has the new observation, exp does not
    expect(mainIds.length).toBe(expIds.length + 1);
  });

  it('throws BranchExistsError for duplicate name', () => {
    versioning.createBranch('exp');
    expect(() => versioning.createBranch('exp')).toThrow(BranchExistsError);
  });

  it('throws BranchNotFoundError for nonexistent parent', () => {
    expect(() => versioning.createBranch('x', 'nonexistent')).toThrow(BranchNotFoundError);
  });

  it('throws ProtectedBranchError when deleting main', () => {
    expect(() => versioning.deleteBranch('main')).toThrow(ProtectedBranchError);
  });

  it('throws BranchNotFoundError when deleting nonexistent branch', () => {
    expect(() => versioning.deleteBranch('nonexistent')).toThrow(BranchNotFoundError);
  });

  it('deletes branch and its exclusive observations', async () => {
    await addObservation('p', 'shared');

    versioning.createBranch('exp');

    // Add observation only to exp (remove from main, add to exp)
    const obs = await addObservation('p', 'exp-only');
    const expBranch = versioning.getBranch('exp');
    rawDb().run(
      'DELETE FROM memory_branch_observations WHERE branch_id = 1 AND observation_id = ?',
      [obs.id],
    );
    rawDb().run(
      'INSERT OR IGNORE INTO memory_branch_observations (branch_id, observation_id) VALUES (?, ?)',
      [expBranch!.id, obs.id],
    );

    versioning.deleteBranch('exp');

    const branches = versioning.listBranches();
    expect(branches).toHaveLength(1);
    expect(branches[0]?.name).toBe('main');
  });
});

// ─── Snapshot Operations ────────────────────────────────────────

describe('snapshots', () => {
  beforeEach(async () => {
    await freshSetup();
  });

  it('creates a snapshot with current observation IDs', async () => {
    await addObservation('p', 'obs1');
    await addObservation('p', 'obs2');

    const snapshot = versioning.createSnapshot('v1');
    expect(snapshot.name).toBe('v1');
    expect(snapshot.observationIds).toHaveLength(2);
  });

  it('throws SnapshotExistsError for duplicate name', () => {
    versioning.createSnapshot('v1');
    expect(() => versioning.createSnapshot('v1')).toThrow(SnapshotExistsError);
  });

  it('throws BranchNotFoundError for nonexistent branch', () => {
    expect(() => versioning.createSnapshot('v1', 'nonexistent')).toThrow(BranchNotFoundError);
  });

  it('lists snapshots', async () => {
    await addObservation('p', 'obs1');
    versioning.createSnapshot('v1');
    versioning.createSnapshot('v2');

    const snapshots = versioning.listSnapshots();
    expect(snapshots).toHaveLength(2);
  });

  it('filters snapshots by branch', () => {
    versioning.createBranch('exp');
    versioning.createSnapshot('snap-main', 'main');
    versioning.createSnapshot('snap-exp', 'exp');

    const mainSnapshots = versioning.listSnapshots('main');
    expect(mainSnapshots).toHaveLength(1);
    expect(mainSnapshots[0]?.name).toBe('snap-main');
  });
});

// ─── Merge ──────────────────────────────────────────────────────

describe('merge', () => {
  beforeEach(async () => {
    await freshSetup();
  });

  it('merges source-exclusive observations into target', async () => {
    await addObservation('p', 'shared');
    versioning.createBranch('exp');

    // Add observation only to exp
    const obs = await addObservation('p', 'exp-new');
    const expBranch = versioning.getBranch('exp');
    rawDb().run(
      'DELETE FROM memory_branch_observations WHERE branch_id = 1 AND observation_id = ?',
      [obs.id],
    );
    rawDb().run(
      'INSERT OR IGNORE INTO memory_branch_observations (branch_id, observation_id) VALUES (?, ?)',
      [expBranch!.id, obs.id],
    );

    const result = versioning.mergeBranch('exp', 'main');
    expect(result.merged).toContain(obs.id);

    const mainIds = versioning.getBranchObservationIds('main');
    expect(mainIds).toContain(obs.id);
  });

  it('returns empty merge for identical branches', async () => {
    await addObservation('p', 'shared');
    versioning.createBranch('exp');

    const result = versioning.mergeBranch('exp', 'main');
    expect(result.merged).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('detects contradictions during merge', async () => {
    await addObservation('p', 'Use prepared statements');
    versioning.createBranch('exp');

    // Add contradicting observation to exp only
    const obs2 = await addObservation('p', 'Raw SQL is fine here');
    const expBranch = versioning.getBranch('exp');
    rawDb().run(
      'DELETE FROM memory_branch_observations WHERE branch_id = 1 AND observation_id = ?',
      [obs2.id],
    );
    // Change severity to create contradiction
    rawDb().run('UPDATE memory_observations SET severity = ? WHERE id = ?', ['low', obs2.id]);
    rawDb().run(
      'INSERT OR IGNORE INTO memory_branch_observations (branch_id, observation_id) VALUES (?, ?)',
      [expBranch!.id, obs2.id],
    );

    const result = versioning.mergeBranch('exp', 'main');
    expect(result.merged).toContain(obs2.id);
    expect(result.contradictions.length).toBeGreaterThanOrEqual(1);
  });

  it('throws BranchNotFoundError for nonexistent source', () => {
    expect(() => versioning.mergeBranch('nonexistent', 'main')).toThrow(BranchNotFoundError);
  });

  it('throws BranchNotFoundError for nonexistent target', () => {
    versioning.createBranch('exp');
    expect(() => versioning.mergeBranch('exp', 'nonexistent')).toThrow(BranchNotFoundError);
  });
});

// ─── Rollback ───────────────────────────────────────────────────

describe('rollback', () => {
  beforeEach(async () => {
    await freshSetup();
  });

  it('restores branch to snapshot state', async () => {
    await addObservation('p', 'obs1');
    await addObservation('p', 'obs2');
    versioning.createSnapshot('v1');

    // Add more observations after snapshot
    await addObservation('p', 'obs3');
    await addObservation('p', 'obs4');

    expect(versioning.getBranchObservationIds('main')).toHaveLength(4);

    versioning.rollback('v1');

    expect(versioning.getBranchObservationIds('main')).toHaveLength(2);
  });

  it('throws SnapshotNotFoundError for nonexistent snapshot', () => {
    expect(() => versioning.rollback('nonexistent')).toThrow(SnapshotNotFoundError);
  });

  it('is a no-op when branch already matches snapshot', async () => {
    await addObservation('p', 'obs1');
    versioning.createSnapshot('v1');

    // Rollback when nothing changed — should not throw
    versioning.rollback('v1');
    expect(versioning.getBranchObservationIds('main')).toHaveLength(1);
  });
});
