/**
 * Pure boundary-checker logic (Node-version-robust home of {@link checkForgeBoundary}).
 *
 * This file is plain JavaScript ON PURPOSE (P0 fix F2 hardening): the lint:boundary
 * runner (`scripts/lint-boundary.mjs`) imports this module DIRECTLY at runtime, so
 * the gate no longer depends on Node's experimental TS type-stripping (which needs
 * Node >= 22.18 / unflagged) and can never crash with ERR_UNKNOWN_FILE_EXTENSION.
 * The TypeScript surface (`lint-boundary.ts`) simply re-exports `checkForgeBoundary`
 * from here and adds the `BoundaryViolation` type, so the unit/real-tree tests keep
 * a fully typed import. See lint-boundary.ts for the full R-AGNOSTIC rule prose.
 *
 * @typedef {{ module: string, reason: string }} BoundaryViolation
 */

const CORE_SPECIFIERS = ['ghagga-core', '@ghagga/core'];
const SERVER_SPECIFIERS = ['ghagga-server', '@ghagga/server'];
const SERVER_PATH_FRAGMENT = 'apps/server';

/**
 * Matches `import ... from '<source>'` AND `export ... from '<source>'`
 * statements. Anchored to start-of-line (`^` + `m` flag) so the keyword in PROSE
 * is never matched. Group 1 = keyword (distinguishes re-exports); group 2 = a
 * top-level `type `; group 3 = clause; group 4 = module specifier.
 */
const STATIC_RE = /^\s*(import|export)\s+(type\s+)?([\w\s{},*]*?)\s+from\s+['"]([^'"]+)['"]/gm;

/**
 * Matches DYNAMIC imports/requires: `import('<source>')` / `require('<source>')`.
 * These always pull a VALUE at runtime, so any such core reference is a violation.
 */
const DYNAMIC_RE = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** True if every named specifier in the clause is inline-`type` (e.g. `{ type A, type B }`). */
function allSpecifiersInlineType(clause) {
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch === null) {
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
 * Strip block and line comments before scanning. Newlines inside block comments
 * are preserved so line-anchored matching of real code is unaffected.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** True if the import specifier targets the server app. */
function isServerImport(source) {
  if (SERVER_SPECIFIERS.includes(source)) {
    return true;
  }
  return source.includes(SERVER_PATH_FRAGMENT);
}

/**
 * True if the import specifier targets core — the bare package, a SUBPATH
 * (`ghagga-core/graph`), or the scoped alias (`@ghagga/core`, `@ghagga/core/x`).
 */
function isCoreImport(source) {
  return CORE_SPECIFIERS.some((c) => source === c || source.startsWith(`${c}/`));
}

const SERVER_REASON =
  'packages/forge MUST NOT import apps/server (R-AGNOSTIC): the server depends on forge, never the reverse.';
const CORE_VALUE_REASON =
  "forge→core imports are allowed in TYPE position only (R-AGNOSTIC): use `import type { ... } from 'ghagga-core'`.";

/**
 * Scan a single source file's text for forge-boundary violations.
 *
 * @param {string} rawSource the file contents to scan.
 * @returns {BoundaryViolation[]} the list of violations (empty when clean).
 */
export function checkForgeBoundary(rawSource) {
  const violations = [];
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
      // A re-export republishes the binding as a VALUE escape, EVEN with
      // `export type`. Only a genuine type-only IMPORT is allowed.
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
