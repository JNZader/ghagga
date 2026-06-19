/**
 * Type surface for the plain-JS boundary checker implementation
 * ({@link lint-boundary.impl.mjs}). Lets `lint-boundary.ts` import the runtime
 * function with a precise type WITHOUT enabling `allowJs` for the package.
 */

/** A single boundary violation. */
export interface BoundaryViolation {
  /** The offending import source/module specifier. */
  module: string;
  /** Why it violates the boundary. */
  reason: string;
}

/**
 * Scan a single source file's text for forge-boundary violations.
 *
 * @param rawSource the file contents to scan.
 * @returns the list of violations (empty when the file is clean).
 */
export function checkForgeBoundary(rawSource: string): BoundaryViolation[];
