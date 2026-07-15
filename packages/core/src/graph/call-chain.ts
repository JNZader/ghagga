/**
 * Call-Chain Blast-Radius Computation
 *
 * Extends the file-level blast-radius to work at FUNCTION/SYMBOL level.
 * Uses regex-based extraction — no tree-sitter required.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface CallChainNode {
  filePath: string;
  symbolName: string;
  kind: 'function' | 'method' | 'class' | 'variable';
}

export interface CallChainEdge {
  from: CallChainNode;
  to: CallChainNode;
  kind: 'calls' | 'imports' | 'extends' | 'implements';
}

export interface CallChainGraph {
  nodes: CallChainNode[];
  edges: CallChainEdge[];
}

export interface CallChainBlastRadius {
  changedSymbols: CallChainNode[];
  affectedSymbols: CallChainNode[];
  callChainGraph: CallChainGraph;
  depth: number;
}

// ─── Regex Patterns ──────────────────────────────────────────────

/** Matches: function foo(...), export function foo(...), async function foo(...) */
const FUNCTION_DECL_RE = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/** Matches: class Foo, export class Foo, export default class Foo */
const CLASS_DECL_RE = /(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Matches: const foo = ..., let foo = ..., var foo = ... */
const VARIABLE_DECL_RE = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;

/** Matches: foo(...) call references */
const FUNCTION_CALL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/** Matches: .methodName( */
const METHOD_CALL_RE = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/** Matches: new ClassName( */
const NEW_CALL_RE = /\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/** Matches: extends ClassName */
const EXTENDS_RE = /\bextends\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Matches: implements InterfaceName */
const IMPLEMENTS_RE = /\bimplements\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Matches: import { X, Y } from "..." */
const IMPORT_NAMED_RE = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g;

/** Matches: import X from "..." */
const IMPORT_DEFAULT_RE = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*["'][^"']+["']/g;

// ─── Helpers ─────────────────────────────────────────────────────

/** Leading modifier keywords that precede a declaration but are never the symbol name. */
const MODIFIER_KEYWORDS = new Set([
  'export',
  'default',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'pub',
  'final',
  'abstract',
]);

/** Keywords that introduce a declaration — the symbol name is the token AFTER these. */
const DECLARATION_KEYWORDS = new Set([
  'function',
  'func',
  'fn',
  'class',
  'const',
  'let',
  'var',
  'def',
  'type',
  'interface',
  'enum',
  'impl',
  'struct',
  'trait',
]);

/**
 * Extract the declared/referenced symbol name from a snippet of code
 * (e.g. a diff hunk-header context or a bare changed line).
 *
 * Skips leading modifier keywords (export, default, pub, async, ...). If the
 * next token is a declaration keyword (function, class, const, ...), the
 * symbol is the token AFTER it. Otherwise the symbol is the first
 * non-modifier identifier (covers bare context lines like `someMethod(args)`).
 */
function extractDeclaredSymbol(text: string): string | undefined {
  const tokens = text.trim().match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  if (!tokens || tokens.length === 0) return undefined;

  let i = 0;
  while (i < tokens.length && MODIFIER_KEYWORDS.has(tokens[i] as string)) i++;
  if (i >= tokens.length) return undefined;

  const token = tokens[i] as string;
  if (DECLARATION_KEYWORDS.has(token)) {
    return tokens[i + 1];
  }
  return token;
}

/** Regex alternation of DECLARATION_KEYWORDS, built once. */
const DECLARATION_KEYWORDS_ALT = [...DECLARATION_KEYWORDS].join('|');

/** Regex alternation of MODIFIER_KEYWORDS, built once. */
const MODIFIER_KEYWORDS_ALT = [...MODIFIER_KEYWORDS].join('|');

/**
 * Matches a TOP-LEVEL declaration on a changed diff line: the line must
 * start (no leading whitespace, beyond the +/- diff marker already
 * stripped) with optional modifier keywords followed by a declaration
 * keyword and a symbol name. Deliberately conservative — a `const local = …`
 * indented inside a function body (leading whitespace present) will NOT
 * match, avoiding false positives from mid-expression/nested declarations.
 */
const TOP_LEVEL_DECL_RE = new RegExp(
  `^(?:(?:${MODIFIER_KEYWORDS_ALT})\\s+)*(?:${DECLARATION_KEYWORDS_ALT})\\s+([A-Za-z_$][A-Za-z0-9_$]*)`,
);

function extractTopLevelDeclaredSymbol(content: string): string | undefined {
  const m = content.match(TOP_LEVEL_DECL_RE);
  return m?.[1];
}

/**
 * Extract diff hunk context to find symbols that had +/- lines.
 * Returns the file path and approximate symbol name for each modified hunk.
 *
 * Exported (was module-private) for reuse by the Symbol Impact review
 * context (`pipeline/prepare-graph.ts` step 2.6) — same diff-parsing logic,
 * different consumer.
 */
export function extractChangedSymbolsFromDiff(unifiedDiff: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const lines = unifiedDiff.split('\n');

  let currentFile = '';
  let currentSymbol = '';

  for (const line of lines) {
    // Detect file path from diff header
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      if (!result.has(currentFile)) {
        result.set(currentFile, new Set());
      }
      continue;
    }

    // Detect hunk header — may contain function context: @@ ... @@ functionName
    if (line.startsWith('@@')) {
      const m = line.match(/@@ .* @@ (.+)/);
      if (m?.[1]) {
        const symbol = extractDeclaredSymbol(m[1]);
        if (symbol) {
          currentSymbol = symbol;
        }
      }
      continue;
    }

    // Changed lines (+ or -) that declare a top-level function/class/const/
    // let/var/type/interface/enum.
    if (
      (line.startsWith('+') || line.startsWith('-')) &&
      !line.startsWith('+++') &&
      !line.startsWith('---')
    ) {
      const content = line.slice(1);

      const declMatch = extractTopLevelDeclaredSymbol(content);
      if (declMatch && currentFile) {
        result.get(currentFile)?.add(declMatch);
        currentSymbol = declMatch;
      }
    }
  }

  // If we found files but no symbols in some files, use the current symbol context
  if (currentSymbol && currentFile && result.get(currentFile)?.size === 0) {
    result.get(currentFile)?.add(currentSymbol);
  }

  return result;
}

/**
 * Extract all symbol declarations from file content.
 */
function extractSymbols(filePath: string, content: string): CallChainNode[] {
  const nodes: CallChainNode[] = [];
  const seen = new Set<string>();

  const addNode = (name: string, kind: CallChainNode['kind']) => {
    if (!seen.has(name)) {
      seen.add(name);
      nodes.push({ filePath, symbolName: name, kind });
    }
  };

  // Functions
  for (const m of content.matchAll(FUNCTION_DECL_RE)) {
    if (m[1]) addNode(m[1], 'function');
  }

  // Classes
  for (const m of content.matchAll(CLASS_DECL_RE)) {
    if (m[1]) addNode(m[1], 'class');
  }

  // Variables (only top-level assignments — const/let/var)
  for (const m of content.matchAll(VARIABLE_DECL_RE)) {
    if (m[1]) addNode(m[1], 'variable');
  }

  // Arrow functions assigned to variables (already captured above via VARIABLE_DECL_RE)
  // Also capture method-like patterns inside classes: methodName(...) {
  const METHOD_DECL_RE = /^\s{2,}([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*[:{]/gm;
  for (const m of content.matchAll(METHOD_DECL_RE)) {
    if (m[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
      addNode(m[1], 'method');
    }
  }

  return nodes;
}

/**
 * Build edges for references from symbolsInFile to any symbol name in the codebase.
 */
function buildEdgesForFile(
  filePath: string,
  content: string,
  symbolsByFile: Map<string, CallChainNode[]>,
  symbolIndex: Map<string, CallChainNode[]>,
): CallChainEdge[] {
  const edges: CallChainEdge[] = [];
  const mySymbols = symbolsByFile.get(filePath) ?? [];

  // Collect all referenced symbol names from this file
  const refs = new Map<string, CallChainEdge['kind']>();

  // Function calls
  for (const m of content.matchAll(FUNCTION_CALL_RE)) {
    if (
      m[1] &&
      !['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof'].includes(m[1])
    ) {
      if (!refs.has(m[1])) refs.set(m[1], 'calls');
    }
  }

  // Method calls
  for (const m of content.matchAll(METHOD_CALL_RE)) {
    if (m[1] && !refs.has(m[1])) refs.set(m[1], 'calls');
  }

  // new ClassName(
  for (const m of content.matchAll(NEW_CALL_RE)) {
    if (m[1] && !refs.has(m[1])) refs.set(m[1], 'calls');
  }

  // extends
  for (const m of content.matchAll(EXTENDS_RE)) {
    if (m[1]) refs.set(m[1], 'extends');
  }

  // implements
  for (const m of content.matchAll(IMPLEMENTS_RE)) {
    if (m[1]) refs.set(m[1], 'implements');
  }

  // Named imports → "imports" edges
  for (const m of content.matchAll(IMPORT_NAMED_RE)) {
    if (m[1]) {
      for (const name of m[1].split(',').map((n) => n.trim().split(' as ')[0]?.trim() ?? '')) {
        if (name && !refs.has(name)) refs.set(name, 'imports');
      }
    }
  }

  // Default imports → "imports" edges
  for (const m of content.matchAll(IMPORT_DEFAULT_RE)) {
    if (m[1] && !refs.has(m[1])) refs.set(m[1], 'imports');
  }

  // For each reference: find the symbol in ANY file, create edges from each of MY symbols
  for (const [refName, kind] of refs) {
    const targetNodes = symbolIndex.get(refName);
    if (!targetNodes) continue;

    for (const targetNode of targetNodes) {
      if (targetNode.filePath === filePath) continue; // skip self-references

      for (const fromNode of mySymbols) {
        edges.push({ from: fromNode, to: targetNode, kind });
      }

      // If we have no local symbols, create a "file-level" edge
      if (mySymbols.length === 0) {
        const fileNode: CallChainNode = {
          filePath,
          symbolName: '(module)',
          kind: 'function',
        };
        edges.push({ from: fileNode, to: targetNode, kind });
      }
    }
  }

  return edges;
}

// ─── Main Export ─────────────────────────────────────────────────

const MAX_BFS_DEPTH = 3;

/**
 * Build a call-chain blast radius from a unified diff and file contents.
 *
 * 1. Parse diff to find changed symbols
 * 2. Extract all symbols from all files
 * 3. Build edges between symbols
 * 4. BFS from changed symbols to find affected symbols (max depth 3)
 */
export function buildCallChainFromDiff(
  unifiedDiff: string,
  fileContents: Map<string, string>,
): CallChainBlastRadius {
  // Step 1: Find changed symbols from diff
  const changedSymbolsByFile = extractChangedSymbolsFromDiff(unifiedDiff);

  // Step 2: Extract all symbols from all files
  const symbolsByFile = new Map<string, CallChainNode[]>();
  const symbolIndex = new Map<string, CallChainNode[]>();

  for (const [filePath, content] of fileContents) {
    const symbols = extractSymbols(filePath, content);
    symbolsByFile.set(filePath, symbols);

    for (const sym of symbols) {
      const existing = symbolIndex.get(sym.symbolName) ?? [];
      existing.push(sym);
      symbolIndex.set(sym.symbolName, existing);
    }
  }

  // Step 3: Build all edges
  const allEdges: CallChainEdge[] = [];
  for (const [filePath, content] of fileContents) {
    const edges = buildEdgesForFile(filePath, content, symbolsByFile, symbolIndex);
    allEdges.push(...edges);
  }

  // Collect all nodes
  const allNodes: CallChainNode[] = [];
  for (const symbols of symbolsByFile.values()) {
    allNodes.push(...symbols);
  }

  // Step 4: Identify changed symbols
  const changedSymbols: CallChainNode[] = [];
  for (const [filePath, names] of changedSymbolsByFile) {
    for (const name of names) {
      const nodes = symbolIndex.get(name);
      if (nodes) {
        const match = nodes.find((n) => n.filePath === filePath);
        if (match) changedSymbols.push(match);
      }
    }
    // If no specific symbols found, add all symbols from the changed file
    if (names.size === 0 && symbolsByFile.has(filePath)) {
      changedSymbols.push(...(symbolsByFile.get(filePath) ?? []));
    }
  }

  // Step 5: BFS to find affected symbols (reverse direction — who calls the changed symbols)
  // Build reverse edge index: symbolName → nodes that call it
  const reverseEdgeMap = new Map<string, Set<CallChainNode>>();
  for (const edge of allEdges) {
    const key = `${edge.to.filePath}::${edge.to.symbolName}`;
    const existing = reverseEdgeMap.get(key) ?? new Set();
    existing.add(edge.from);
    reverseEdgeMap.set(key, existing);
  }

  const visited = new Set<string>();
  const affectedSymbols: CallChainNode[] = [];
  let queue: CallChainNode[] = [...changedSymbols];
  let actualDepth = 0;

  for (const sym of changedSymbols) {
    visited.add(`${sym.filePath}::${sym.symbolName}`);
  }

  for (let depth = 0; depth < MAX_BFS_DEPTH && queue.length > 0; depth++) {
    const nextQueue: CallChainNode[] = [];

    for (const sym of queue) {
      const key = `${sym.filePath}::${sym.symbolName}`;
      const callers = reverseEdgeMap.get(key);
      if (!callers) continue;

      for (const caller of callers) {
        const callerKey = `${caller.filePath}::${caller.symbolName}`;
        if (!visited.has(callerKey)) {
          visited.add(callerKey);
          affectedSymbols.push(caller);
          nextQueue.push(caller);
        }
      }
    }

    if (nextQueue.length > 0) actualDepth = depth + 1;
    queue = nextQueue;
  }

  return {
    changedSymbols,
    affectedSymbols,
    callChainGraph: { nodes: allNodes, edges: allEdges },
    depth: actualDepth,
  };
}
