/**
 * Git-style versioning for review memory.
 *
 * Provides branch, snapshot, merge, and rollback operations on top of
 * the existing SQLite memory storage. Uses composition — wraps a
 * SqliteMemoryStorage instance and operates on the versioning tables
 * (memory_branches, memory_snapshots, memory_branch_observations).
 *
 * The default branch is "main" (id=1). All observations created via
 * the standard MemoryStorage interface are automatically linked to main.
 */

import type {
  MemoryBranch,
  MemoryObservationRow,
  MemorySnapshot,
  MergeResult,
  VersioningConfig,
} from '../types.js';
import { DEFAULT_VERSIONING_CONFIG } from '../types.js';
import { detectContradictions } from './contradiction.js';
import type { SqliteMemoryStorage } from './sqlite.js';

// ─── Error Types ───────────────────────────────────────────────

export class SnapshotExistsError extends Error {
  constructor(name: string) {
    super(`Snapshot "${name}" already exists`);
    this.name = 'SnapshotExistsError';
  }
}

export class SnapshotNotFoundError extends Error {
  constructor(name: string) {
    super(`Snapshot "${name}" not found`);
    this.name = 'SnapshotNotFoundError';
  }
}

export class BranchExistsError extends Error {
  constructor(name: string) {
    super(`Branch "${name}" already exists`);
    this.name = 'BranchExistsError';
  }
}

export class BranchNotFoundError extends Error {
  constructor(name: string) {
    super(`Branch "${name}" not found`);
    this.name = 'BranchNotFoundError';
  }
}

export class ProtectedBranchError extends Error {
  constructor(name: string) {
    super(`Branch "${name}" is protected and cannot be deleted`);
    this.name = 'ProtectedBranchError';
  }
}

// ─── Database interface ────────────────────────────────────────

/**
 * Subset of the sql.js Database interface used by versioning.
 * Keeps the dependency on the concrete type minimal.
 */
interface VersioningDatabase {
  exec(
    sql: string,
    params?: (string | number | null)[],
  ): Array<{ columns: string[]; values: unknown[][] }>;
  run(sql: string, params?: (string | number | null)[]): void;
  prepare(sql: string): {
    bind(params: (string | number | null)[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
  getRowsModified(): number;
}

// ─── Main Class ────────────────────────────────────────────────

export class MemoryVersioning {
  private db: VersioningDatabase;
  private config: VersioningConfig;

  constructor(storage: SqliteMemoryStorage, config: VersioningConfig = DEFAULT_VERSIONING_CONFIG) {
    this.db = storage.getDatabase() as unknown as VersioningDatabase;
    this.config = config;
  }

  // ── Branch Operations ──────────────────────────────────────────

  /**
   * List all branches.
   */
  listBranches(): MemoryBranch[] {
    const stmt = this.db.prepare(
      'SELECT id, name, parent_id, created_at FROM memory_branches ORDER BY id',
    );
    stmt.bind([]);

    const branches: MemoryBranch[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      branches.push({
        id: row.id as number,
        name: row.name as string,
        parentId: (row.parent_id as number) ?? null,
        createdAt: row.created_at as string,
      });
    }
    stmt.free();
    return branches;
  }

  /**
   * Get a branch by name. Returns null if not found.
   */
  getBranch(name: string): MemoryBranch | null {
    const stmt = this.db.prepare(
      'SELECT id, name, parent_id, created_at FROM memory_branches WHERE name = ?',
    );
    stmt.bind([name]);

    if (!stmt.step()) {
      stmt.free();
      return null;
    }

    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id as number,
      name: row.name as string,
      parentId: (row.parent_id as number) ?? null,
      createdAt: row.created_at as string,
    };
  }

  /**
   * Create a new branch from an existing parent branch.
   * Copies all observation links from the parent to the new branch.
   *
   * @param name - Unique branch name
   * @param parentName - Parent branch to fork from (default: "main")
   * @throws BranchExistsError if name is taken
   * @throws BranchNotFoundError if parent doesn't exist
   */
  createBranch(name: string, parentName = 'main'): MemoryBranch {
    // Check if name is taken
    const existing = this.getBranch(name);
    if (existing) throw new BranchExistsError(name);

    // Find parent
    const parent = this.getBranch(parentName);
    if (!parent) throw new BranchNotFoundError(parentName);

    // Create branch
    const result = this.db.exec(
      `INSERT INTO memory_branches (name, parent_id) VALUES (?, ?)
       RETURNING id, name, parent_id, created_at`,
      [name, parent.id],
    );

    const row = result[0]?.values[0];
    if (!row) throw new Error('Failed to create branch');

    const branchId = row[0] as number;

    // Copy observation links from parent
    this.db.run(
      `INSERT OR IGNORE INTO memory_branch_observations (branch_id, observation_id)
       SELECT ?, observation_id FROM memory_branch_observations WHERE branch_id = ?`,
      [branchId, parent.id],
    );

    return {
      id: branchId,
      name: row[1] as string,
      parentId: (row[2] as number) ?? null,
      createdAt: row[3] as string,
    };
  }

  /**
   * Delete a branch and its exclusive observations.
   * Observations shared with other branches are preserved.
   *
   * @throws ProtectedBranchError if trying to delete "main"
   * @throws BranchNotFoundError if branch doesn't exist
   */
  deleteBranch(name: string): void {
    if (name === 'main') throw new ProtectedBranchError(name);

    const branch = this.getBranch(name);
    if (!branch) throw new BranchNotFoundError(name);

    // Find observations exclusive to this branch (not linked to any other branch)
    const exclusiveResult = this.db.exec(
      `SELECT bo.observation_id FROM memory_branch_observations bo
       WHERE bo.branch_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM memory_branch_observations bo2
           WHERE bo2.observation_id = bo.observation_id
             AND bo2.branch_id != ?
         )`,
      [branch.id, branch.id],
    );

    // Delete exclusive observations
    if (exclusiveResult.length > 0 && exclusiveResult[0]?.values.length > 0) {
      const ids = exclusiveResult[0].values.map((r) => r[0] as number);
      const placeholders = ids.map(() => '?').join(',');
      this.db.run(
        `DELETE FROM memory_observations WHERE id IN (${placeholders})`,
        ids,
      );
    }

    // Delete branch (CASCADE removes branch_observations links and snapshots)
    this.db.run('DELETE FROM memory_branches WHERE id = ?', [branch.id]);
  }

  /**
   * Get observation IDs linked to a branch.
   */
  getBranchObservationIds(branchName: string): number[] {
    const branch = this.getBranch(branchName);
    if (!branch) throw new BranchNotFoundError(branchName);

    const stmt = this.db.prepare(
      'SELECT observation_id FROM memory_branch_observations WHERE branch_id = ? ORDER BY observation_id',
    );
    stmt.bind([branch.id]);

    const ids: number[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      ids.push(row.observation_id as number);
    }
    stmt.free();
    return ids;
  }

  /**
   * Get full observation rows for a branch.
   */
  private getBranchObservations(branchName: string): MemoryObservationRow[] {
    const branch = this.getBranch(branchName);
    if (!branch) throw new BranchNotFoundError(branchName);

    const stmt = this.db.prepare(
      `SELECT o.id, o.type, o.title, o.content, o.file_paths, o.severity
       FROM memory_observations o
       JOIN memory_branch_observations bo ON bo.observation_id = o.id
       WHERE bo.branch_id = ?
       ORDER BY o.id`,
    );
    stmt.bind([branch.id]);

    const rows: MemoryObservationRow[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        id: row.id as number,
        type: row.type as string,
        title: row.title as string,
        content: row.content as string,
        filePaths: row.file_paths ? JSON.parse(row.file_paths as string) : null,
        severity: (row.severity as string) ?? null,
      });
    }
    stmt.free();
    return rows;
  }

  // ── Snapshot Operations ────────────────────────────────────────

  /**
   * Create a named snapshot of a branch's current state.
   *
   * @throws SnapshotExistsError if name is taken
   * @throws BranchNotFoundError if branch doesn't exist
   */
  createSnapshot(name: string, branchName = 'main'): MemorySnapshot {
    // Check if name is taken
    const existingStmt = this.db.prepare(
      'SELECT id FROM memory_snapshots WHERE name = ?',
    );
    existingStmt.bind([name]);
    const exists = existingStmt.step();
    existingStmt.free();
    if (exists) throw new SnapshotExistsError(name);

    const branch = this.getBranch(branchName);
    if (!branch) throw new BranchNotFoundError(branchName);

    // Get current observation IDs
    const observationIds = this.getBranchObservationIds(branchName);
    const idsJson = JSON.stringify(observationIds);

    const result = this.db.exec(
      `INSERT INTO memory_snapshots (name, branch_id, observation_ids)
       VALUES (?, ?, ?)
       RETURNING id, name, branch_id, observation_ids, created_at`,
      [name, branch.id, idsJson],
    );

    const row = result[0]?.values[0];
    if (!row) throw new Error('Failed to create snapshot');

    return {
      id: row[0] as number,
      name: row[1] as string,
      branchId: row[2] as number,
      observationIds: JSON.parse(row[3] as string),
      createdAt: row[4] as string,
    };
  }

  /**
   * List all snapshots, optionally filtered by branch.
   */
  listSnapshots(branchName?: string): MemorySnapshot[] {
    let sql = 'SELECT id, name, branch_id, observation_ids, created_at FROM memory_snapshots';
    const params: (string | number | null)[] = [];

    if (branchName) {
      const branch = this.getBranch(branchName);
      if (!branch) throw new BranchNotFoundError(branchName);
      sql += ' WHERE branch_id = ?';
      params.push(branch.id);
    }

    sql += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const snapshots: MemorySnapshot[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      snapshots.push({
        id: row.id as number,
        name: row.name as string,
        branchId: row.branch_id as number,
        observationIds: JSON.parse(row.observation_ids as string),
        createdAt: row.created_at as string,
      });
    }
    stmt.free();
    return snapshots;
  }

  // ── Merge ──────────────────────────────────────────────────────

  /**
   * Merge observations from source branch into target branch.
   * Detects contradictions but does NOT auto-resolve them — both
   * observations end up on the target branch.
   *
   * @throws BranchNotFoundError if either branch doesn't exist
   */
  mergeBranch(sourceName: string, targetName: string): MergeResult {
    const source = this.getBranch(sourceName);
    if (!source) throw new BranchNotFoundError(sourceName);

    const target = this.getBranch(targetName);
    if (!target) throw new BranchNotFoundError(targetName);

    // Find observation IDs exclusive to source (not already on target)
    const exclusiveResult = this.db.exec(
      `SELECT bo.observation_id FROM memory_branch_observations bo
       WHERE bo.branch_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM memory_branch_observations bo2
           WHERE bo2.observation_id = bo.observation_id
             AND bo2.branch_id = ?
         )`,
      [source.id, target.id],
    );

    const mergedIds: number[] = [];
    if (exclusiveResult.length > 0 && exclusiveResult[0]?.values.length > 0) {
      for (const row of exclusiveResult[0].values) {
        mergedIds.push(row[0] as number);
      }
    }

    // Detect contradictions before merging
    const sourceObs = this.getBranchObservations(sourceName);
    const targetObs = this.getBranchObservations(targetName);

    // Only check source-exclusive obs against target
    const sourceExclusiveObs = sourceObs.filter((o) => mergedIds.includes(o.id));
    const contradictions = detectContradictions(sourceExclusiveObs, targetObs, this.config);

    // Link source-exclusive observations to target branch
    for (const id of mergedIds) {
      this.db.run(
        'INSERT OR IGNORE INTO memory_branch_observations (branch_id, observation_id) VALUES (?, ?)',
        [target.id, id],
      );
    }

    return { merged: mergedIds, contradictions };
  }

  // ── Rollback ───────────────────────────────────────────────────

  /**
   * Rollback a branch to a named snapshot.
   * Removes observations added after the snapshot was taken.
   *
   * @throws SnapshotNotFoundError if snapshot doesn't exist
   */
  rollback(snapshotName: string): void {
    const stmt = this.db.prepare(
      'SELECT id, name, branch_id, observation_ids, created_at FROM memory_snapshots WHERE name = ?',
    );
    stmt.bind([snapshotName]);

    if (!stmt.step()) {
      stmt.free();
      throw new SnapshotNotFoundError(snapshotName);
    }

    const row = stmt.getAsObject();
    stmt.free();

    const branchId = row.branch_id as number;
    const snapshotIds: number[] = JSON.parse(row.observation_ids as string);

    // Find observation IDs on this branch that are NOT in the snapshot
    const currentIds = this.db.exec(
      'SELECT observation_id FROM memory_branch_observations WHERE branch_id = ?',
      [branchId],
    );

    const currentIdSet = new Set<number>();
    if (currentIds.length > 0 && currentIds[0]?.values.length > 0) {
      for (const r of currentIds[0].values) {
        currentIdSet.add(r[0] as number);
      }
    }

    const snapshotIdSet = new Set(snapshotIds);
    const idsToRemove = [...currentIdSet].filter((id) => !snapshotIdSet.has(id));

    if (idsToRemove.length === 0) return;

    // Remove branch links for post-snapshot observations
    const placeholders = idsToRemove.map(() => '?').join(',');
    this.db.run(
      `DELETE FROM memory_branch_observations
       WHERE branch_id = ? AND observation_id IN (${placeholders})`,
      [branchId, ...idsToRemove],
    );

    // Delete observations that are no longer linked to ANY branch
    this.db.run(
      `DELETE FROM memory_observations
       WHERE id IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM memory_branch_observations WHERE observation_id = memory_observations.id
         )`,
      idsToRemove,
    );
  }
}
