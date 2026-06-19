/**
 * Forge-internal boundary checker (task 0.8).
 *
 * Enforces the R-AGNOSTIC import rules that Biome 2.5 cannot express on its own,
 * specifically the TYPE-vs-VALUE distinction for forge→core imports:
 *
 *   - `import type { X } from 'ghagga-core'`            ✅ allowed (type position)
 *   - `import { type X } from 'ghagga-core'`            ✅ allowed (all specifiers inline-type)
 *   - `import { X } from 'ghagga-core'`                 ❌ forbidden (value position)
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

const CORE_SPECIFIER = 'ghagga-core';
const SERVER_SPECIFIERS = ['ghagga-server', '@ghagga/server'];
const SERVER_PATH_FRAGMENT = 'apps/server';

/** Matches `import ... from '<source>'` statements (single import line). */
const IMPORT_RE = /import\s+(type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g;

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

/** True if the import specifier targets the server app. */
function isServerImport(source: string): boolean {
  if (SERVER_SPECIFIERS.includes(source)) {
    return true;
  }
  return source.includes(SERVER_PATH_FRAGMENT);
}

/**
 * Scan a single source file's text for forge-boundary violations.
 *
 * @param source the file contents to scan.
 * @returns the list of violations (empty when the file is clean).
 */
export function checkForgeBoundary(source: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  IMPORT_RE.lastIndex = 0;
  for (let match = IMPORT_RE.exec(source); match !== null; match = IMPORT_RE.exec(source)) {
    const isTopLevelTypeImport = match[1] !== undefined; // `import type ...`
    const clause = match[2] ?? '';
    const moduleSource = match[3] ?? '';

    if (isServerImport(moduleSource)) {
      violations.push({
        module: moduleSource,
        reason:
          'packages/forge MUST NOT import apps/server (R-AGNOSTIC): the server depends on forge, never the reverse.',
      });
      continue;
    }

    if (moduleSource === CORE_SPECIFIER) {
      const typeOnly = isTopLevelTypeImport || allSpecifiersInlineType(clause);
      if (!typeOnly) {
        violations.push({
          module: moduleSource,
          reason:
            "forge→core imports are allowed in TYPE position only (R-AGNOSTIC): use `import type { ... } from 'ghagga-core'`.",
        });
      }
    }
  }

  return violations;
}
