/**
 * The adapter registry (task 0.7).
 *
 * Resolves a {@link ForgeAdapter} from a {@link RepoRef} by its `kind`. A lookup
 * miss is a TYPED failure (R-RESOLVE): {@link ForgeRegistry.resolve} throws
 * {@link UnknownForgeError} rather than returning `undefined` and letting a
 * caller blow up later on `undefined.fetchDiff(...)`.
 */

import type { ForgeAdapter } from './ports/forge-adapter.js';
import type { ForgeKind, RepoRef } from './types.js';

/**
 * Thrown when the registry has no adapter registered for a repo's forge kind.
 *
 * R-RESOLVE: a typed, named error — callers can `instanceof`-narrow it instead
 * of guessing why an adapter was `undefined`.
 */
export class UnknownForgeError extends Error {
  /** The forge kind that had no registered adapter. */
  readonly kind: ForgeKind;

  constructor(kind: ForgeKind) {
    super(`No forge adapter registered for kind "${kind}"`);
    this.name = 'UnknownForgeError';
    this.kind = kind;
    // Preserve prototype chain across down-level transpilation targets.
    Object.setPrototypeOf(this, UnknownForgeError.prototype);
  }
}

/** Looks up forge adapters by forge kind. */
export interface ForgeRegistry {
  /**
   * Register an adapter for a forge kind. A later registration for the same kind
   * overrides the earlier one.
   */
  register(kind: ForgeKind, adapter: ForgeAdapter): void;

  /** Whether an adapter is registered for `kind`. */
  has(kind: ForgeKind): boolean;

  /**
   * Resolve the adapter for `repo.kind`.
   *
   * @throws {UnknownForgeError} when no adapter is registered for the kind.
   */
  resolve(repo: RepoRef): ForgeAdapter;
}

/**
 * In-memory {@link ForgeRegistry}.
 *
 * The default registry implementation: a simple `Map` keyed by forge kind.
 * `resolve` is where R-RESOLVE lives — a miss throws {@link UnknownForgeError},
 * never returns `undefined`.
 */
export class MapForgeRegistry implements ForgeRegistry {
  private readonly adapters = new Map<ForgeKind, ForgeAdapter>();

  register(kind: ForgeKind, adapter: ForgeAdapter): void {
    this.adapters.set(kind, adapter);
  }

  has(kind: ForgeKind): boolean {
    return this.adapters.has(kind);
  }

  resolve(repo: RepoRef): ForgeAdapter {
    const adapter = this.adapters.get(repo.kind);
    if (adapter === undefined) {
      throw new UnknownForgeError(repo.kind);
    }
    return adapter;
  }
}
