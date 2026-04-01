/**
 * Tree-sitter S-expression Queries
 *
 * Per-language queries that extract symbol definitions (functions,
 * classes, methods, interfaces) from parsed ASTs.
 *
 * Each query uses named captures:
 *   @name    — the symbol's identifier node
 *   @node    — the full definition node (for byte/line ranges)
 *   @parent  — parent class/struct name (for methods)
 */

import type { ScopeLanguage } from './types.js';

// ─── TypeScript / JavaScript ───────────────────────────────────

const TYPESCRIPT_QUERY = `
; top-level function declarations
(function_declaration
  name: (identifier) @name) @node

; arrow functions assigned to const/let/var
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @node

; class declarations
(class_declaration
  name: (identifier) @name) @node

; methods inside classes
(class_declaration
  name: (identifier) @parent
  body: (class_body
    (method_definition
      name: (property_identifier) @name) @node))

; interface declarations (TypeScript only — ignored in JS grammars)
(interface_declaration
  name: (identifier) @name) @node

; export function
(export_statement
  declaration: (function_declaration
    name: (identifier) @name)) @node

; export class
(export_statement
  declaration: (class_declaration
    name: (identifier) @name)) @node

; export interface
(export_statement
  declaration: (interface_declaration
    name: (identifier) @name)) @node

; export const arrow
(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @node
`;

// ─── Python ────────────────────────────────────────────────────

const PYTHON_QUERY = `
; function definitions
(function_definition
  name: (identifier) @name) @node

; class definitions
(class_definition
  name: (identifier) @name) @node

; methods inside classes
(class_definition
  name: (identifier) @parent
  body: (block
    (function_definition
      name: (identifier) @name) @node))
`;

// ─── Go ────────────────────────────────────────────────────────

const GO_QUERY = `
; function declarations
(function_declaration
  name: (identifier) @name) @node

; method declarations (with receiver)
(method_declaration
  name: (field_identifier) @name
  receiver: (parameter_list
    (parameter_declaration
      type: [(pointer_type (type_identifier) @parent)
             (type_identifier) @parent]))) @node

; type declarations (struct)
(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (struct_type))) @node

; interface type declarations
(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (interface_type))) @node
`;

// ─── Query Registry ────────────────────────────────────────────

const QUERIES: Record<ScopeLanguage, string> = {
  typescript: TYPESCRIPT_QUERY,
  javascript: TYPESCRIPT_QUERY, // Same grammar family
  python: PYTHON_QUERY,
  go: GO_QUERY,
};

/**
 * Get the tree-sitter query string for a given language.
 * Returns undefined for unsupported languages.
 */
export function getQuery(language: ScopeLanguage): string | undefined {
  return QUERIES[language];
}

/**
 * Get the WASM grammar name for tree-sitter Language.load().
 * Maps scope languages to their grammar identifiers.
 */
export function getGrammarName(language: ScopeLanguage): string {
  switch (language) {
    case 'typescript':
      return 'tree-sitter-typescript';
    case 'javascript':
      return 'tree-sitter-javascript';
    case 'python':
      return 'tree-sitter-python';
    case 'go':
      return 'tree-sitter-go';
  }
}
