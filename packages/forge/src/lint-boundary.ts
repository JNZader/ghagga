/**
 * Forge-internal boundary checker (task 0.8).
 *
 * Enforces the R-AGNOSTIC import rules that Biome 2.5 cannot express on its own,
 * specifically the TYPE-vs-VALUE distinction for forge→core imports:
 *
 *   - `import type { X } from 'ghagga-core'`            ✅ allowed (type position)
 *   - `import { type X } from 'ghagga-core'`            ✅ allowed (all specifiers inline-type)
 *   - `import { X } from 'ghagga-core'`                 ❌ forbidden (value position)
 *   - `export { X } from 'ghagga-core'`                 ❌ forbidden (re-export = value escape)
 *   - `import('ghagga-core')` / `require('ghagga-core')` ❌ forbidden (dynamic = value)
 *   - `ghagga-core/<subpath>` / `@ghagga/core`         ❌ same rules (subpath & scoped alias)
 *   - any import of `apps/server` / `ghagga-server`    ❌ forbidden outright
 *
 * Biome's `noRestrictedImports` is a blunt path ban — it would reject the LEGAL
 * `import type` forge→core case (false positive). This checker closes that gap
 * so the boundary test (`lint-boundary.test.ts`) can pin both directions.
 *
 * It is deliberately a small, dependency-free scanner over source text rather
 * than a full AST pass: the boundary rules only care about import-statement
 * forms, which are matched reliably with focused regexes. The Biome overrides in
 * `biome.json` cover the forge↛server and core↛forge path bans; this module
 * adds the type-position nuance for forge→core.
 *
 * IMPLEMENTATION LIVES IN A `.mjs` SIBLING (P0 fix F2 hardening):
 * The actual scanner logic is in `lint-boundary.impl.mjs` (plain JS). The
 * lint:boundary RUNNER (`scripts/lint-boundary.mjs`) imports that `.mjs`
 * DIRECTLY, so the gate never imports a `.ts` file at runtime and therefore does
 * NOT depend on Node's experimental TS type-stripping (Node >= 22.18 / unflagged)
 * — eliminating the `ERR_UNKNOWN_FILE_EXTENSION` Node-version fragility. This
 * module re-exports the function with a precise TS type and owns the
 * {@link BoundaryViolation} interface so the tests keep a fully typed import.
 */

// Value + type re-export from the JS implementation. The accompanying
// `lint-boundary.impl.d.mts` supplies the precise types, so callers/tests get the
// full `BoundaryViolation[]` signature without enabling `allowJs` for the package.
export type { BoundaryViolation } from './lint-boundary.impl.mjs';
export {
  BANNED_CLIENT_FORGE_FNS,
  checkForgeBoundary,
  checkServerForgeClientBoundary,
} from './lint-boundary.impl.mjs';
