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
 */

/** A single boundary violation. */
export interface BoundaryViolation {
  /** The offending import source/module specifier. */
  module: string;
  /** Why it violates the boundary. */
  reason: string;
}

const CORE_SPECIFIERS = ['ghagga-core', '@ghagga/core'];
const SERVER_SPECIFIERS = ['ghagga-server', '@ghagga/server'];
const SERVER_PATH_FRAGMENT = 'apps/server';

/**
 * Matches `import ... from '<source>'` AND `export ... from '<source>'`
 * statements.
 *
 * Anchored to start-of-line (`^` + `m` flag) so the `import`/`export` keyword in
 * PROSE (e.g. a doc comment `// Type-position import from core`) is never
 * matched. The clause group is restricted to characters that legally appear in
 * an import/export clause — identifiers, whitespace, braces, commas, `*` — which
 * lets it span MULTIPLE LINES (`import {\n type A,\n B\n} from '...'`) without
 * swallowing unrelated source. A re-export (`export ... from`) is treated as a
 * VALUE escape: it republishes the binding regardless of `type`. Group 1 is the
 * keyword (distinguishes re-exports); group 2 captures a top-level `type `.
 */
const STATIC_RE = /^\s*(import|export)\s+(type\s+)?([\w\s{},*]*?)\s+from\s+['"]([^'"]+)['"]/gm;

/**
 * Matches DYNAMIC imports/requires: `import('<source>')` / `require('<source>')`.
 * These always pull a VALUE at runtime (no type-only form exists), so any such
 * reference to core is a boundary violation.
 */
const DYNAMIC_RE = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** True if every named specifier in the clause is inline-`type` (e.g. `{ type A, type B }`). */
function allSpecifiersInlineType(clause: string): boolean {
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch === null) {
    // No named block → a default/namespace value import (e.g. `import x` /
    // `import * as x`). That is a VALUE import.
    return false;
  }
  const inner = braceMatch[1]?.trim() ?? '';
  if (inner === '') {
    return false;
  }
  const specifiers = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return specifiers.every((s) => s.startsWith('type '));
}

/**
 * Strip block (`/* … *\/`) and line (`// …`) comments before scanning.
 *
 * Documentation comments in this very module quote example import/require forms
 * (`require('ghagga-core')`, `import { X } from 'ghagga-core'`); without this the
 * scanner would flag its own prose. Newlines inside block comments are preserved
 * so line-anchored matching of real code is unaffected. This is a deliberately
 * simple stripper — it does not parse strings/regex literals, which is sound for
 * the import-boundary use case (import sources are the only quoted forms that
 * matter, and they live OUTSIDE comments in real code).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** True if the import specifier targets the server app. */
function isServerImport(source: string): boolean {
  if (SERVER_SPECIFIERS.includes(source)) {
    return true;
  }
  return source.includes(SERVER_PATH_FRAGMENT);
}

/**
 * True if the import specifier targets core — the bare package, a SUBPATH
 * (`ghagga-core/graph`), or the scoped alias (`@ghagga/core`, `@ghagga/core/x`).
 */
function isCoreImport(source: string): boolean {
  return CORE_SPECIFIERS.some((c) => source === c || source.startsWith(`${c}/`));
}

const SERVER_REASON =
  'packages/forge MUST NOT import apps/server (R-AGNOSTIC): the server depends on forge, never the reverse.';
const CORE_VALUE_REASON =
  "forge→core imports are allowed in TYPE position only (R-AGNOSTIC): use `import type { ... } from 'ghagga-core'`.";

/**
 * Scan a single source file's text for forge-boundary violations.
 *
 * @param source the file contents to scan.
 * @returns the list of violations (empty when the file is clean).
 */
export function checkForgeBoundary(rawSource: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const source = stripComments(rawSource);

  // ── Static `import ... from` and `export ... from` (incl. re-exports) ──
  STATIC_RE.lastIndex = 0;
  for (let match = STATIC_RE.exec(source); match !== null; match = STATIC_RE.exec(source)) {
    const keyword = match[1]; // 'import' | 'export'
    const isTopLevelTypeImport = match[2] !== undefined; // `import type ...`
    const clause = match[3] ?? '';
    const moduleSource = match[4] ?? '';

    if (isServerImport(moduleSource)) {
      violations.push({ module: moduleSource, reason: SERVER_REASON });
      continue;
    }

    if (isCoreImport(moduleSource)) {
      // A re-export (`export ... from`) republishes the binding as a VALUE
      // escape, EVEN with `export type` (it forwards a public binding). Only a
      // genuine type-only IMPORT is allowed.
      const isReexport = keyword === 'export';
      const typeOnly = !isReexport && (isTopLevelTypeImport || allSpecifiersInlineType(clause));
      if (!typeOnly) {
        violations.push({ module: moduleSource, reason: CORE_VALUE_REASON });
      }
    }
  }

  // ── Dynamic `import('...')` / `require('...')` — always a VALUE pull ──
  DYNAMIC_RE.lastIndex = 0;
  for (let match = DYNAMIC_RE.exec(source); match !== null; match = DYNAMIC_RE.exec(source)) {
    const moduleSource = match[1] ?? '';
    if (isServerImport(moduleSource)) {
      violations.push({ module: moduleSource, reason: SERVER_REASON });
    } else if (isCoreImport(moduleSource)) {
      violations.push({ module: moduleSource, reason: CORE_VALUE_REASON });
    }
  }

  return violations;
}
