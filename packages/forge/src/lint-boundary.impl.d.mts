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

/** The 11 @internal client.ts forge-adapter fns banned outside the factory. */
export const BANNED_CLIENT_FORGE_FNS: readonly string[];

/**
 * Scan an apps/server source file for direct use of the 11 @internal client.ts
 * forge-adapter fns. Catches NAMED imports, the NAMESPACE-alias member-access
 * bypass, dynamic `import()`/`require()` member access, re-export laundering
 * (`export { ... } from` / `export * from`), and destructuring off a namespace
 * or dynamic-import alias — all the forms Biome's `noRestrictedImports` cannot
 * see.
 *
 * @param filePath the file path (used only in the violation message).
 * @param rawSource the file contents to scan.
 * @returns the list of violations (empty when the file is clean).
 */
export function checkServerForgeClientBoundary(
  filePath: string,
  rawSource: string,
): BoundaryViolation[];
