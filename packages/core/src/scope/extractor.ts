/**
 * Symbol Extractor
 *
 * Extracts symbol definitions (functions, classes, methods, interfaces)
 * from source code using tree-sitter AST walking.
 *
 * Uses cursor-based traversal instead of S-expression queries for
 * maximum compatibility across grammar versions.
 *
 * Pure function signature: (source, language, tree) => SymbolInfo[]
 */

import type { Node, Tree } from 'web-tree-sitter';
import type { ScopeLanguage, SymbolInfo, SymbolKind } from './types.js';

// ─── Node Type Maps ────────────────────────────────────────────

/** Node types that represent symbol definitions, per language. */
interface SymbolNodeConfig {
  /** Node types for function definitions */
  functions: string[];
  /** Node types for class definitions */
  classes: string[];
  /** Node types for method definitions */
  methods: string[];
  /** Node types for interface definitions */
  interfaces: string[];
  /** How to extract the name from a node (field name to look up) */
  nameField: string;
  /** Field name for method name (if different from nameField) */
  methodNameField?: string;
  /** Field name for class body that contains methods */
  bodyField?: string;
}

const NODE_CONFIGS: Record<ScopeLanguage, SymbolNodeConfig> = {
  typescript: {
    functions: ['function_declaration', 'arrow_function'],
    classes: ['class_declaration'],
    methods: ['method_definition'],
    interfaces: ['interface_declaration'],
    nameField: 'name',
    methodNameField: 'name',
    bodyField: 'body',
  },
  javascript: {
    functions: ['function_declaration', 'arrow_function'],
    classes: ['class_declaration'],
    methods: ['method_definition'],
    interfaces: [],
    nameField: 'name',
    methodNameField: 'name',
    bodyField: 'body',
  },
  python: {
    functions: ['function_definition'],
    classes: ['class_definition'],
    methods: ['function_definition'], // methods are function_definition inside class
    interfaces: [],
    nameField: 'name',
    methodNameField: 'name',
    bodyField: 'body',
  },
  go: {
    functions: ['function_declaration'],
    classes: ['type_declaration'], // struct type
    methods: ['method_declaration'],
    interfaces: ['type_declaration'], // interface type
    nameField: 'name',
    methodNameField: 'name',
    bodyField: 'body',
  },
};

// ─── Extractor ─────────────────────────────────────────────────

/**
 * Extract symbol definitions from a parsed tree-sitter tree.
 *
 * Walks the AST using a cursor and identifies functions, classes,
 * methods, and interfaces based on language-specific node types.
 *
 * @param tree - Parsed tree-sitter tree
 * @param language - The scope language
 * @returns Array of extracted symbols
 */
export function extractSymbolsFromTree(
  tree: Tree,
  language: ScopeLanguage,
): SymbolInfo[] {
  const config = NODE_CONFIGS[language];
  if (!config) return [];

  const symbols: SymbolInfo[] = [];

  if (language === 'go') {
    extractGoSymbols(tree.rootNode, config, symbols);
  } else {
    extractGenericSymbols(tree.rootNode, config, language, symbols, undefined);
  }

  return symbols;
}

// ─── Generic Extraction (TS/JS/Python) ─────────────────────────

function extractGenericSymbols(
  node: Node,
  config: SymbolNodeConfig,
  language: ScopeLanguage,
  symbols: SymbolInfo[],
  parentClassName: string | undefined,
): void {
  const nodeType = node.type;

  // Check if this is a function
  if (config.functions.includes(nodeType) && !parentClassName) {
    const name = extractName(node, config.nameField, language);
    if (name) {
      symbols.push(buildSymbol(name, 'function', node));
    }
  }

  // Check if this is a class
  if (config.classes.includes(nodeType)) {
    const name = extractName(node, config.nameField, language);
    if (name) {
      symbols.push(buildSymbol(name, 'class', node));

      // Walk children to find methods
      const body = node.childForFieldName(config.bodyField ?? 'body');
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          const child = body.child(i);
          if (child) {
            extractMethodsFromClassBody(child, config, language, symbols, name);
          }
        }
      }
      return; // Don't recurse into class children again
    }
  }

  // Check if this is an interface (TS only)
  if (config.interfaces.includes(nodeType)) {
    const name = extractName(node, config.nameField, language);
    if (name) {
      symbols.push(buildSymbol(name, 'interface', node));
      return;
    }
  }

  // Check for arrow function assigned to variable (TS/JS)
  if (
    (language === 'typescript' || language === 'javascript') &&
    (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration')
  ) {
    extractArrowFunctionVariable(node, symbols);
    return;
  }

  // Check for exported declarations (TS/JS)
  if (nodeType === 'export_statement') {
    const declaration = node.childForFieldName('declaration');
    if (declaration) {
      extractGenericSymbols(declaration, config, language, symbols, parentClassName);
      return;
    }
  }

  // Python: method inside class is function_definition with parent context
  if (language === 'python' && parentClassName && nodeType === 'function_definition') {
    const name = extractName(node, config.nameField, language);
    if (name) {
      symbols.push(buildSymbol(name, 'method', node, parentClassName));
      return;
    }
  }

  // Recurse into children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      extractGenericSymbols(child, config, language, symbols, parentClassName);
    }
  }
}

function extractMethodsFromClassBody(
  node: Node,
  config: SymbolNodeConfig,
  language: ScopeLanguage,
  symbols: SymbolInfo[],
  className: string,
): void {
  if (config.methods.includes(node.type)) {
    const name = extractName(node, config.methodNameField ?? config.nameField, language);
    if (name) {
      symbols.push(buildSymbol(name, 'method', node, className));
    }
    return;
  }

  // Python: methods are function_definition inside class body block
  if (language === 'python' && node.type === 'function_definition') {
    const name = extractName(node, config.nameField, language);
    if (name) {
      symbols.push(buildSymbol(name, 'method', node, className));
    }
    return;
  }

  // Recurse for nested blocks (Python class body has a block node)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      extractMethodsFromClassBody(child, config, language, symbols, className);
    }
  }
}

function extractArrowFunctionVariable(node: Node, symbols: SymbolInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const declarator = node.child(i);
    if (declarator?.type === 'variable_declarator') {
      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');
      if (nameNode && valueNode?.type === 'arrow_function') {
        // Use the full declaration node for ranges (includes const/let)
        symbols.push(buildSymbol(nameNode.text, 'function', node));
      }
    }
  }
}

// ─── Go Extraction ─────────────────────────────────────────────

function extractGoSymbols(
  node: Node,
  config: SymbolNodeConfig,
  symbols: SymbolInfo[],
): void {
  const nodeType = node.type;

  if (nodeType === 'function_declaration') {
    const name = node.childForFieldName('name');
    if (name) {
      symbols.push(buildSymbol(name.text, 'function', node));
    }
  } else if (nodeType === 'method_declaration') {
    const name = node.childForFieldName('name');
    const receiver = node.childForFieldName('receiver');
    let parentName: string | undefined;

    if (receiver) {
      // Extract receiver type: (s *Svc) or (s Svc)
      parentName = extractGoReceiverType(receiver);
    }

    if (name) {
      symbols.push(buildSymbol(name.text, 'method', node, parentName));
    }
  } else if (nodeType === 'type_declaration') {
    // Go type declarations contain type_spec children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_spec') {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        if (nameNode && typeNode) {
          const kind: SymbolKind =
            typeNode.type === 'interface_type' ? 'interface' : 'class';
          symbols.push(buildSymbol(nameNode.text, kind, node));
        }
      }
    }
  }

  // Recurse into children (skip already-processed node types to avoid duplication)
  if (
    nodeType !== 'function_declaration' &&
    nodeType !== 'method_declaration' &&
    nodeType !== 'type_declaration'
  ) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        extractGoSymbols(child, config, symbols);
      }
    }
  }
}

function extractGoReceiverType(receiver: Node): string | undefined {
  // parameter_list > parameter_declaration > type (pointer_type > type_identifier | type_identifier)
  for (let i = 0; i < receiver.childCount; i++) {
    const param = receiver.child(i);
    if (param?.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      if (typeNode) {
        if (typeNode.type === 'pointer_type') {
          // *Svc → extract Svc
          for (let j = 0; j < typeNode.childCount; j++) {
            const inner = typeNode.child(j);
            if (inner?.type === 'type_identifier') return inner.text;
          }
        } else if (typeNode.type === 'type_identifier') {
          return typeNode.text;
        }
      }
    }
  }
  return undefined;
}

// ─── Helpers ───────────────────────────────────────────────────

function extractName(
  node: Node,
  fieldName: string,
  _language: ScopeLanguage,
): string | undefined {
  const nameNode = node.childForFieldName(fieldName);
  return nameNode?.text;
}

function buildSymbol(
  name: string,
  kind: SymbolKind,
  node: Node,
  parent?: string,
): SymbolInfo {
  return {
    name,
    kind,
    // tree-sitter uses 0-based rows, we use 1-based lines
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    ...(parent ? { parent } : {}),
  };
}
