/**
 * SCIP → DependencyGraph Mapper
 *
 * Builds a v1 DependencyGraph from a parsed SCIP `Index` (as produced by
 * `scip-go` and other SCIP-conformant indexers). Pure function: no
 * filesystem access — the caller supplies the already-parsed Index (or
 * raw bytes, via `parseScipIndex`).
 *
 * Unlike the regex-based `buildGraph()` (../builder.ts), this mapper
 * resolves cross-file references by SCIP symbol identity rather than
 * import-statement string matching, which lets it follow full
 * module-path references a regex extractor cannot (e.g. Go's
 * `example.com/module/pkg` import form).
 *
 * Algorithm:
 *   Pass A: build `symbolId -> definingDocPath` from every non-local
 *           symbol defined in each document (via `Document.symbols` and
 *           Definition-role occurrences).
 *   Pass B: for each document, for each non-definition (reference)
 *           occurrence, resolve `occ.symbol` through the Pass A map. If
 *           it resolves to a *different* in-index document, record that
 *           document's path as an import. Symbols with no entry in the
 *           map (external/stdlib symbols, e.g. those only present in
 *           `Index.externalSymbols`) are dropped — no edge is produced.
 *
 * `calls` is always `[]` in v1 (parity with the regex baseline — call-graph
 * extraction is out of scope here). `SymbolInformation.relationships`
 * (implements/type-definition/etc.) are intentionally ignored: v1 only
 * models reference-based edges.
 *
 * Pass B additionally accumulates `importSymbols` (see schema.ts):
 * alongside `importSet.add(targetPath)`, resolved reference occurrences are
 * grouped into `Map<targetPath, Set<symbolId>>`, DEDUPED BY `occ.symbol`
 * IDENTITY (not by rendered displayName — two distinct symbols that happen
 * to render the same display name must stay as two separate entries). The
 * displayName (from Pass A's `displayNameMap`, falling back to the raw
 * symbol id) is only resolved at emit time.
 */

import { createHash } from 'node:crypto';
import { fromBinary } from '@bufbuild/protobuf';
import {
  type Document,
  type Index,
  IndexSchema,
  type Occurrence,
  SymbolRole,
} from '@scip-code/scip';
import { detectLanguage } from '../builder.js';
import {
  type DependencyGraph,
  GRAPH_VERSION,
  type GraphNode,
  isTestFile,
  type SupportedLanguage,
} from '../schema.js';

// ─── Parsing ────────────────────────────────────────────────────

/**
 * Parse raw SCIP index bytes (the contents of an `index.scip` file)
 * into a typed `Index` message.
 */
export function parseScipIndex(bytes: Uint8Array): Index {
  return fromBinary(IndexSchema, bytes);
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * SCIP marks symbols scoped to a single document/scope with a `local `
 * prefix (e.g. `local 0`). These can never be referenced cross-document,
 * so they're excluded from both the definition map and exports.
 */
function isLocalSymbol(symbolId: string): boolean {
  return symbolId.startsWith('local ');
}

function hasRole(roles: number, role: SymbolRole): boolean {
  return (roles & role) !== 0;
}

/**
 * D6 (LANDMINE): convert SCIP's 0-based, end-EXCLUSIVE line convention to
 * the graph's 1-based INCLUSIVE convention. `endChar === 0` means line
 * `scipEndLine` holds no in-range content (the range ends exactly at the
 * start of that line) — so the last inclusive 1-based line is `scipEndLine`
 * itself, not `scipEndLine + 1`.
 */
function convertRange(
  scipStartLine: number,
  scipEndLine: number,
  endChar: number,
): [number, number] {
  const start1 = scipStartLine + 1;
  const end1 = endChar > 0 ? scipEndLine + 1 : scipEndLine;
  return [start1, end1];
}

/**
 * D2: capture a Definition occurrence's full-body enclosing range.
 * Priority order (per spec): the deprecated flat `enclosingRange`
 * (`[startLine, startChar, endLine, endChar]` — the only form go/ts/rust
 * indexers in the wild emit) first, else `typedEnclosingRange` (java's
 * `multiLineEnclosingRange`/`singleLineEnclosingRange` oneof). Neither
 * present → `undefined` — the caller must NOT fabricate a range; that
 * symbol's changes simply go unattributed downstream.
 */
function extractEnclosingRange(occ: Occurrence): [number, number] | undefined {
  if (occ.enclosingRange.length === 4) {
    const [startLine, , endLine, endChar] = occ.enclosingRange as [number, number, number, number];
    return convertRange(startLine, endLine, endChar);
  }

  const typed = occ.typedEnclosingRange;
  if (typed.case === 'multiLineEnclosingRange') {
    return convertRange(typed.value.startLine, typed.value.endLine, typed.value.endCharacter);
  }
  if (typed.case === 'singleLineEnclosingRange') {
    return convertRange(typed.value.line, typed.value.line, typed.value.endCharacter);
  }

  return undefined;
}

/** Map a SCIP `Document.language` string to a ghagga `SupportedLanguage`. */
const SCIP_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  go: 'go',
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  java: 'java',
  rust: 'rust',
  kotlin: 'kotlin',
  csharp: 'csharp',
  'c#': 'csharp',
  php: 'php',
};

function scipLanguageToSupported(
  docLanguage: string,
  relativePath: string,
): SupportedLanguage | undefined {
  const normalized = docLanguage.toLowerCase();
  return SCIP_LANGUAGE_MAP[normalized] ?? detectLanguage(relativePath);
}

/**
 * Compute a stable hash for a document node. SCIP indexers typically omit
 * `Document.text` (it's optional and not included by default), so we fall
 * back to hashing the sorted list of symbols defined in the document —
 * stable across re-runs of the same indexer against unchanged source.
 */
function hashDocument(doc: Document): string {
  if (doc.text) {
    return createHash('sha256').update(doc.text).digest('hex');
  }
  const symbolIds = doc.symbols
    .map((s) => s.symbol)
    .filter((s) => s && !isLocalSymbol(s))
    .sort();
  return createHash('sha256').update(symbolIds.join('\n')).digest('hex');
}

// ─── Build Graph ────────────────────────────────────────────────

export interface BuildGraphFromScipOptions {
  /**
   * Called for every SCIP document whose `language` cannot be mapped to a
   * `SupportedLanguage` (D5) — the document is dropped from the graph, same
   * as before, but the caller now gets a chance to report it instead of the
   * drop happening silently. Core stays console-free: pass a callback that
   * wires to `tui.warn` at the call site.
   */
  onUnmappedDoc?: (relativePath: string, language: string) => void;
}

/**
 * Build a complete DependencyGraph from a parsed SCIP Index.
 *
 * @param index - Parsed SCIP Index (see `parseScipIndex`)
 * @param opts - Optional hooks (see `BuildGraphFromScipOptions`)
 * @returns Complete v1 DependencyGraph
 */
export function buildGraphFromScip(
  index: Index,
  opts?: BuildGraphFromScipOptions,
): DependencyGraph {
  const rootDir = index.metadata?.projectRoot ?? '';
  const nodes: Record<string, GraphNode> = {};

  // Pass A: symbolId -> definingDocPath, from every non-local symbol
  // defined in each document (Document.symbols is authoritative per the
  // SCIP proto: "Symbols that are defined within this document").
  const definitionMap = new Map<string, string>();
  // symbolId -> displayName, used at Pass-B emit time to render a
  // human-readable name for `importSymbols`. Only set when the indexer
  // supplies a non-empty displayName; falls back to the raw symbol id.
  const displayNameMap = new Map<string, string>();
  // docPath -> (displayName -> [startLine, endLine]), 1-based inclusive
  // (D6). Populated from Definition-occurrence enclosingRange/
  // typedEnclosingRange (D2), keyed the SAME way as `exports`/
  // `importSymbols` (D1) so downstream diff-line attribution can compare
  // against those spaces directly. Emitted into `GraphNode.symbolRanges`
  // once all documents are scanned (see the node-init loop below).
  const rangesByDoc = new Map<string, Record<string, [number, number]>>();
  for (const doc of index.documents) {
    for (const symInfo of doc.symbols) {
      if (!symInfo.symbol || isLocalSymbol(symInfo.symbol)) continue;
      if (!definitionMap.has(symInfo.symbol)) {
        definitionMap.set(symInfo.symbol, doc.relativePath);
      }
      if (symInfo.displayName && !displayNameMap.has(symInfo.symbol)) {
        displayNameMap.set(symInfo.symbol, symInfo.displayName);
      }
    }
    // Reinforce with Definition-role occurrences, in case an indexer
    // omits some defined symbols from Document.symbols. Also the capture
    // point for symbolRanges (D2).
    for (const occ of doc.occurrences) {
      if (!occ.symbol || isLocalSymbol(occ.symbol)) continue;
      if (!hasRole(occ.symbolRoles, SymbolRole.Definition)) continue;
      if (!definitionMap.has(occ.symbol)) {
        definitionMap.set(occ.symbol, doc.relativePath);
      }

      const range = extractEnclosingRange(occ);
      if (range) {
        const displayName = displayNameMap.get(occ.symbol) || occ.symbol;
        let ranges = rangesByDoc.get(doc.relativePath);
        if (!ranges) {
          ranges = {};
          rangesByDoc.set(doc.relativePath, ranges);
        }
        const existing = ranges[displayName];
        // D1: displayName collision (e.g. overloads) — union of
        // min-start..max-end rather than overwriting.
        ranges[displayName] = existing
          ? [Math.min(existing[0], range[0]), Math.max(existing[1], range[1])]
          : range;
      }
    }
  }

  // Initialize nodes with exports derived from Document.symbols.
  for (const doc of index.documents) {
    const language = scipLanguageToSupported(doc.language, doc.relativePath);
    if (!language) {
      opts?.onUnmappedDoc?.(doc.relativePath, doc.language);
      continue;
    }

    const exportsSet = new Set<string>();
    for (const symInfo of doc.symbols) {
      if (!symInfo.symbol || isLocalSymbol(symInfo.symbol)) continue;
      exportsSet.add(symInfo.displayName || symInfo.symbol);
    }

    nodes[doc.relativePath] = {
      hash: hashDocument(doc),
      language,
      imports: [],
      exports: Array.from(exportsSet),
      calls: [],
      isTest: isTestFile(doc.relativePath),
    };

    const ranges = rangesByDoc.get(doc.relativePath);
    if (ranges && Object.keys(ranges).length > 0) {
      const node = nodes[doc.relativePath];
      if (node) node.symbolRanges = ranges;
    }
  }

  // Pass B: resolve reference occurrences to import edges.
  for (const doc of index.documents) {
    const node = nodes[doc.relativePath];
    if (!node) continue;

    const importSet = new Set<string>();
    // targetPath -> Set<occ.symbol> — deduped by SYMBOL IDENTITY, not by
    // displayName (the explicit fix for the 3vr dedup-by-displayName bug
    // on the abandoned calls[] branch).
    const symbolIdsByTarget = new Map<string, Set<string>>();
    for (const occ of doc.occurrences) {
      if (!occ.symbol || isLocalSymbol(occ.symbol)) continue;
      // Only reference occurrences (not the symbol's own definition) can
      // introduce an edge.
      if (hasRole(occ.symbolRoles, SymbolRole.Definition)) continue;

      const targetPath = definitionMap.get(occ.symbol);
      if (!targetPath || targetPath === doc.relativePath) continue;
      importSet.add(targetPath);

      let ids = symbolIdsByTarget.get(targetPath);
      if (!ids) {
        ids = new Set();
        symbolIdsByTarget.set(targetPath, ids);
      }
      ids.add(occ.symbol);
    }
    node.imports = Array.from(importSet);

    if (symbolIdsByTarget.size > 0) {
      const importSymbols: Record<string, string[]> = {};
      for (const [targetPath, symbolIds] of symbolIdsByTarget) {
        importSymbols[targetPath] = Array.from(symbolIds, (id) => displayNameMap.get(id) ?? id);
      }
      node.importSymbols = importSymbols;
    }
  }

  return {
    version: GRAPH_VERSION,
    rootDir,
    nodes,
  };
}
