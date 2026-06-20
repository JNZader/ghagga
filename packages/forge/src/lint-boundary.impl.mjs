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

// ───────────────────────────────────────────────────────────────────────────
// Server → client.ts forge-adapter surface boundary (SDD forge-agnostic 1.6+).
//
// WHY THIS EXISTS (P1 4vr Codex contrarian finding): Biome's
// `noRestrictedImports` only blocks NAMED imports of the 11 @internal
// forge-adapter fns. A namespace bypass —
//   `import * as gh from '../github/client.js'; gh.fetchPRDiff(...)`
// — is INVISIBLE to Biome, so the factory's "sole sanctioned consumer"
// guarantee was theater. review.ts ALREADY namespace-imports client.ts (for the
// allowed getInstallationToken), so the escape hatch was wide open. This checker
// closes it for real by ALSO catching namespace-alias + member-access of any of
// the 11 banned fns. Same dependency-free regex/string-scanning spirit as
// checkForgeBoundary above. The factory (composition root) and test files are
// the only sanctioned consumers and are excluded by the RUNNER (by path), not
// here — this function is pure over (filePath, source).
// ───────────────────────────────────────────────────────────────────────────

/**
 * The 11 @internal forge-adapter functions exported by apps/server's
 * `github/client.ts`. These MUST be consumed only via the GitHubForgeAdapter
 * built through forge-adapter-factory.ts (makeGitHubAdapter). Direct use
 * anywhere else in apps/server is a boundary violation.
 *
 * NOT banned (allowed direct): getInstallationToken, verifyWebhookSignature,
 * plus any constants/types.
 */
export const BANNED_CLIENT_FORGE_FNS = [
  'fetchPRDiff',
  'fetchPRDetails',
  'getPRFileList',
  'getPRCommitMessages',
  'postComment',
  'findExistingComment',
  'deleteComment',
  'updateComment',
  'addCommentReaction',
  'fetchGraphFromBranch',
  'fetchGraphMetadata',
];

const BANNED_FNS_SET = new Set(BANNED_CLIENT_FORGE_FNS);

/**
 * True if an import specifier points at apps/server's `github/client.ts`.
 * Handles every relative form the server uses to reach the SAME module:
 * `./client.js`, `../github/client.js`, `../../github/client.js`, etc. We match
 * on the trailing `client.js` segment of a RELATIVE specifier (leading `.`),
 * which is the canonical compiled-ESM spelling of `github/client.ts`. Bare
 * package specifiers and non-`client` modules never match.
 */
function isServerForgeClientImport(source) {
  if (!source.startsWith('.')) {
    return false;
  }
  return /(^|\/)client\.(js|ts|mjs|cjs)$/.test(source) || /(^|\/)client$/.test(source);
}

const NAMED_BANNED_REASON =
  'FORGE BOUNDARY (R-AGNOSTIC 1.6): the 11 client.ts forge-adapter fns are @internal — ' +
  'consume them via GitHubForgeAdapter built through forge-adapter-factory.ts (makeGitHubAdapter). ' +
  'Direct named import is forbidden.';
const NAMESPACE_BANNED_REASON =
  'FORGE BOUNDARY (R-AGNOSTIC 1.6) — NAMESPACE BYPASS: this file namespace-imports client.ts ' +
  'and accesses a banned forge-adapter fn via member access (e.g. `alias.fetchPRDiff`). ' +
  "This bypasses Biome's named-import ban. Consume the fn via the GitHubForgeAdapter from " +
  'forge-adapter-factory.ts (makeGitHubAdapter). getInstallationToken/verifyWebhookSignature stay allowed.';
const DYNAMIC_BANNED_REASON =
  'FORGE BOUNDARY (R-AGNOSTIC 1.6) — DYNAMIC-IMPORT BYPASS: this file dynamically ' +
  "loads client.ts (`import('...client.js')` / `require('...client.js')`) and reaches a banned " +
  "forge-adapter fn off the loaded module. This bypasses Biome's STATIC named-import ban entirely. " +
  'Consume the fn via the GitHubForgeAdapter from forge-adapter-factory.ts (makeGitHubAdapter).';
const REEXPORT_BANNED_REASON =
  'FORGE BOUNDARY (R-AGNOSTIC 1.6) — RE-EXPORT LAUNDERING: this file re-exports a banned ' +
  "forge-adapter fn from client.ts (`export { fetchPRDiff } from '...client.js'` or " +
  "`export * from '...client.js'`), republishing an @internal fn as a public binding other " +
  'modules can import. Consume the fns via the GitHubForgeAdapter from forge-adapter-factory.ts ' +
  '(makeGitHubAdapter); do NOT re-export them.';
const DESTRUCTURE_BANNED_REASON =
  'FORGE BOUNDARY (R-AGNOSTIC 1.6) — DESTRUCTURING BYPASS: this file destructures a banned ' +
  'forge-adapter fn off a binding that aliases client.ts (e.g. `const { fetchPRDiff } = gh` after ' +
  "a namespace/dynamic import). This bypasses Biome's named-import AND member-access checks. " +
  'Consume the fns via the GitHubForgeAdapter from forge-adapter-factory.ts (makeGitHubAdapter).';

/**
 * Matches a dynamic load of a module bound to a NAMESPACE alias:
 *   `const gh = await import('...')`  /  `const gh = require('...')`
 *   `let gh = import('...')`          /  `var gh = require('...')`
 * Group 1 = the alias identifier; group 2 = the module specifier. The bound
 * value is the whole module object, so any later `gh.<bannedFn>` is a bypass —
 * we feed group-1 aliases into the SAME member-access scan as static namespace
 * imports.
 */
const DYNAMIC_NS_BIND_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Matches a DESTRUCTURE off a dynamic load:
 *   `const { fetchPRDiff } = await import('...')`
 *   `const { fetchPRDiff } = require('...')`
 * Group 1 = the destructure clause `{ ... }`; group 2 = the module specifier.
 */
const DYNAMIC_DESTRUCTURE_RE =
  /(?:const|let|var)\s*(\{[^}]*\})\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract the bare names from a named-import clause `{ a, b as c, type d }`. */
function namedSpecifiers(clause) {
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch === null) {
    return [];
  }
  return (braceMatch[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^type\s+/, '')) // drop inline `type ` modifier
    .map((s) => s.split(/\s+as\s+/)[0].trim()); // imported name (before `as`)
}

/** Escape a string for safe use as a literal inside a dynamically-built RegExp. */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a single apps/server source file for direct use of the 11 @internal
 * client.ts forge-adapter fns. Catches ALL of these escape routes:
 *
 *   1. NAMED import:      `import { fetchPRDiff } from '../github/client.js'`
 *      (defense-in-depth with the Biome `noRestrictedImports` ban)
 *   2. NAMESPACE bypass:  `import * as gh from '../github/client.js'`
 *      followed by `gh.fetchPRDiff` member access (INVISIBLE to Biome)
 *   3. DYNAMIC-IMPORT bypass: `const gh = await import('...client.js')` /
 *      `const gh = require('...client.js')` then `gh.fetchPRDiff` member access
 *      (Biome's import linter is STATIC-only, so this sails right past it)
 *   4. RE-EXPORT laundering: `export { fetchPRDiff } from '...client.js'` or
 *      `export * from '...client.js'` — republishes the @internal fn as a public
 *      binding any module can then legally import
 *   5. DESTRUCTURING bypass: `const { fetchPRDiff } = gh` (off a namespace OR
 *      dynamic-import alias) and `const { fetchPRDiff } = await import('...')` /
 *      `= require('...')` (destructure straight off the module)
 *
 * Allowed: `getInstallationToken`/`verifyWebhookSignature` (named OR member
 * access OR destructure), constants, and types. The factory and test files are
 * excluded by the RUNNER (by path); this function does not special-case them.
 *
 * @param {string} filePath the file path (for the violation message only).
 * @param {string} rawSource the file contents to scan.
 * @returns {BoundaryViolation[]} the list of violations (empty when clean).
 */
export function checkServerForgeClientBoundary(filePath, rawSource) {
  const violations = [];
  const source = stripComments(rawSource);
  /**
   * Identifiers bound to the WHOLE client.ts module, tagged by how they were
   * sourced so member/destructure violations carry the right reason:
   *   `{ name, dynamic }` — `dynamic:false` = static `import * as`,
   *   `dynamic:true` = `await import()` / `require()`.
   */
  const moduleAliases = [];

  // ── Pass 1: static imports / re-exports of client.ts (named + namespace) ──
  STATIC_RE.lastIndex = 0;
  for (let match = STATIC_RE.exec(source); match !== null; match = STATIC_RE.exec(source)) {
    const keyword = match[1]; // 'import' | 'export'
    const clause = match[3] ?? '';
    const moduleSource = match[4] ?? '';
    if (!isServerForgeClientImport(moduleSource)) {
      continue;
    }

    const isReexport = keyword === 'export';

    // `export * from '...client.js'` — wildcard re-export republishes EVERY
    // banned fn as a public binding. The clause has no brace, so the named-spec
    // scan below misses it; flag the wildcard form explicitly.
    if (isReexport && /(^|\s)\*(\s|$)/.test(clause)) {
      violations.push({
        module: `${filePath} → export * from ${moduleSource}`,
        reason: REEXPORT_BANNED_REASON,
      });
      continue;
    }

    // `import * as alias from '...client.js'` → record alias for member-access
    // + destructure scans (only meaningful for an IMPORT, never an `export *`).
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (!isReexport && nsMatch !== null) {
      moduleAliases.push({ name: nsMatch[1], dynamic: false });
    }

    // Named import OR named re-export of a banned fn. A re-export laundering
    // (`export { fetchPRDiff } from`) gets the dedicated re-export reason; a
    // direct named import gets the named-import reason.
    for (const name of namedSpecifiers(clause)) {
      if (BANNED_FNS_SET.has(name)) {
        violations.push({
          module: `${filePath} → ${moduleSource}`,
          reason: isReexport ? REEXPORT_BANNED_REASON : NAMED_BANNED_REASON,
        });
      }
    }
  }

  // ── Pass 2: dynamic load bound to an alias → record for member/destructure ──
  DYNAMIC_NS_BIND_RE.lastIndex = 0;
  for (let m = DYNAMIC_NS_BIND_RE.exec(source); m !== null; m = DYNAMIC_NS_BIND_RE.exec(source)) {
    if (isServerForgeClientImport(m[2] ?? '')) {
      moduleAliases.push({ name: m[1], dynamic: true });
    }
  }

  // ── Pass 3: destructure STRAIGHT off a dynamic load ──
  //   `const { fetchPRDiff } = await import('...client.js')`  /  `= require(...)`
  DYNAMIC_DESTRUCTURE_RE.lastIndex = 0;
  for (
    let m = DYNAMIC_DESTRUCTURE_RE.exec(source);
    m !== null;
    m = DYNAMIC_DESTRUCTURE_RE.exec(source)
  ) {
    if (!isServerForgeClientImport(m[2] ?? '')) {
      continue;
    }
    for (const name of namedSpecifiers(m[1] ?? '')) {
      if (BANNED_FNS_SET.has(name)) {
        violations.push({
          module: `${filePath} → { ${name} } = ${m[2]}`,
          reason: DYNAMIC_BANNED_REASON,
        });
      }
    }
  }

  // ── Pass 4: per-alias member access AND destructure off the alias ──
  // Aliases come from BOTH static namespace imports (Pass 1) and dynamic loads
  // (Pass 2). Static-namespace aliases that hit a banned member get the
  // NAMESPACE reason; dynamic-load aliases get the DYNAMIC reason. We tag by
  // whether the alias was sourced dynamically.
  for (const { name: alias, dynamic } of moduleAliases) {
    const safeAlias = escapeRegExp(alias);
    const memberReason = dynamic ? DYNAMIC_BANNED_REASON : NAMESPACE_BANNED_REASON;

    // 4a. member access: `alias.<bannedFn>`
    const memberRe = new RegExp(`\\b${safeAlias}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    for (let m = memberRe.exec(source); m !== null; m = memberRe.exec(source)) {
      const member = m[1];
      if (BANNED_FNS_SET.has(member)) {
        violations.push({
          module: `${filePath} → ${alias}.${member}`,
          reason: memberReason,
        });
      }
    }

    // 4b. destructure off the alias: `const { fetchPRDiff } = alias`
    const destructureRe = new RegExp(
      `(?:const|let|var)\\s*(\\{[^}]*\\})\\s*=\\s*${safeAlias}\\b`,
      'g',
    );
    for (let m = destructureRe.exec(source); m !== null; m = destructureRe.exec(source)) {
      for (const name of namedSpecifiers(m[1] ?? '')) {
        if (BANNED_FNS_SET.has(name)) {
          violations.push({
            module: `${filePath} → { ${name} } = ${alias}`,
            reason: DESTRUCTURE_BANNED_REASON,
          });
        }
      }
    }
  }

  return violations;
}
