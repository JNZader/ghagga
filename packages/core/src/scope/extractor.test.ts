/**
 * Unit tests for symbol extraction via tree-sitter.
 *
 * These tests load real WASM grammars and parse actual source code.
 * Requires @cursorless/tree-sitter-wasms package to be installed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Language, Tree } from 'web-tree-sitter';
import { extractSymbolsFromTree } from './extractor.js';
import {
  initParser,
  loadLanguage,
  parseSource,
  resetParser,
  resolveGrammarPath,
} from './parser.js';
import type { ScopeLanguage } from './types.js';

// ─── Helpers ───────────────────────────────────────────────────

const languages: Partial<Record<ScopeLanguage, Language>> = {};

async function loadLang(lang: ScopeLanguage): Promise<Language> {
  const path = resolveGrammarPath(lang);
  if (!path) throw new Error(`No grammar path for ${lang}`);
  return loadLanguage(path);
}

function parse(source: string, lang: Language): Tree {
  return parseSource(source, lang);
}

// ─── Setup ─────────────────────────────────────────────────────

beforeAll(async () => {
  await initParser();
  languages.typescript = await loadLang('typescript');
  languages.javascript = await loadLang('javascript');
  languages.python = await loadLang('python');
  languages.go = await loadLang('go');
});

afterAll(() => {
  resetParser();
});

// ─── TypeScript ────────────────────────────────────────────────

describe('TypeScript symbol extraction', () => {
  it('extracts a function declaration', () => {
    const tree = parse(
      'function foo(x: number): string {\n  return x.toString();\n}',
      languages.typescript!,
    );
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('foo');
    expect(symbols[0]!.kind).toBe('function');
    expect(symbols[0]!.startLine).toBe(1);
    expect(symbols[0]!.endLine).toBe(3);
  });

  it('extracts a class with methods', () => {
    const source = `class Bar {
  baz(): void {
    console.log('hi');
  }

  qux(a: string): number {
    return a.length;
  }
}`;
    const tree = parse(source, languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(3); // class + 2 methods
    expect(symbols[0]!.name).toBe('Bar');
    expect(symbols[0]!.kind).toBe('class');

    expect(symbols[1]!.name).toBe('baz');
    expect(symbols[1]!.kind).toBe('method');
    expect(symbols[1]!.parent).toBe('Bar');

    expect(symbols[2]!.name).toBe('qux');
    expect(symbols[2]!.kind).toBe('method');
    expect(symbols[2]!.parent).toBe('Bar');
  });

  it('extracts an interface declaration', () => {
    const tree = parse('interface Boop {\n  name: string;\n}', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Boop');
    expect(symbols[0]!.kind).toBe('interface');
  });

  it('extracts arrow function assigned to const', () => {
    const tree = parse('const arrow = (x: number) => x * 2;', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('arrow');
    expect(symbols[0]!.kind).toBe('function');
  });

  it('extracts exported function', () => {
    const tree = parse('export function foo() {}', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('foo');
    expect(symbols[0]!.kind).toBe('function');
  });

  it('extracts exported class', () => {
    const tree = parse('export class Foo {\n  bar() {}\n}', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(2); // class + method
    expect(symbols[0]!.name).toBe('Foo');
    expect(symbols[0]!.kind).toBe('class');
    expect(symbols[1]!.name).toBe('bar');
    expect(symbols[1]!.kind).toBe('method');
  });

  it('extracts exported interface', () => {
    const tree = parse('export interface Props {\n  value: string;\n}', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Props');
    expect(symbols[0]!.kind).toBe('interface');
  });

  it('extracts exported arrow function', () => {
    const tree = parse('export const handler = (req: Request) => {};', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('handler');
    expect(symbols[0]!.kind).toBe('function');
  });

  it('extracts multiple top-level symbols', () => {
    const source = `function a() {}
function b() {}
class C {}
interface D {}
const e = () => {};`;
    const tree = parse(source, languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    const names = symbols.map((s) => s.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
    expect(names).toContain('C');
    expect(names).toContain('D');
    expect(names).toContain('e');
  });

  it('has correct byte ranges', () => {
    const source = 'function foo() {\n  return 1;\n}';
    const tree = parse(source, languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols[0]!.startByte).toBe(0);
    expect(symbols[0]!.endByte).toBe(source.length);
  });
});

// ─── JavaScript ────────────────────────────────────────────────

describe('JavaScript symbol extraction', () => {
  it('extracts function and class', () => {
    const source = `function foo() {}
class Bar {
  baz() {}
}`;
    const tree = parse(source, languages.javascript!);
    const symbols = extractSymbolsFromTree(tree, 'javascript');
    tree.delete();

    expect(symbols).toHaveLength(3);
    expect(symbols[0]!.name).toBe('foo');
    expect(symbols[1]!.name).toBe('Bar');
    expect(symbols[2]!.name).toBe('baz');
    expect(symbols[2]!.parent).toBe('Bar');
  });

  it('does not extract interfaces (JS has none)', () => {
    // interface keyword is not valid JS, parser will handle it as error
    const tree = parse('function foo() {}', languages.javascript!);
    const symbols = extractSymbolsFromTree(tree, 'javascript');
    tree.delete();

    expect(symbols.every((s) => s.kind !== 'interface')).toBe(true);
  });
});

// ─── Python ────────────────────────────────────────────────────

describe('Python symbol extraction', () => {
  it('extracts a function definition', () => {
    const tree = parse('def foo():\n    pass', languages.python!);
    const symbols = extractSymbolsFromTree(tree, 'python');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('foo');
    expect(symbols[0]!.kind).toBe('function');
  });

  it('extracts a class with methods', () => {
    const source = `class Bar:
    def baz(self):
        pass

    def qux(self, x):
        return x`;
    const tree = parse(source, languages.python!);
    const symbols = extractSymbolsFromTree(tree, 'python');
    tree.delete();

    expect(symbols).toHaveLength(3); // class + 2 methods
    expect(symbols[0]!.name).toBe('Bar');
    expect(symbols[0]!.kind).toBe('class');
    expect(symbols[1]!.name).toBe('baz');
    expect(symbols[1]!.kind).toBe('method');
    expect(symbols[1]!.parent).toBe('Bar');
    expect(symbols[2]!.name).toBe('qux');
    expect(symbols[2]!.kind).toBe('method');
    expect(symbols[2]!.parent).toBe('Bar');
  });

  it('extracts multiple top-level functions', () => {
    const source = `def a():\n    pass\ndef b():\n    pass`;
    const tree = parse(source, languages.python!);
    const symbols = extractSymbolsFromTree(tree, 'python');
    tree.delete();

    expect(symbols).toHaveLength(2);
    expect(symbols[0]!.name).toBe('a');
    expect(symbols[1]!.name).toBe('b');
  });
});

// ─── Go ────────────────────────────────────────────────────────

describe('Go symbol extraction', () => {
  it('extracts a function declaration', () => {
    const source = 'package main\n\nfunc Foo() {}';
    const tree = parse(source, languages.go!);
    const symbols = extractSymbolsFromTree(tree, 'go');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Foo');
    expect(symbols[0]!.kind).toBe('function');
  });

  it('extracts a method with pointer receiver', () => {
    const source = 'package main\n\nfunc (s *Svc) Bar() {}';
    const tree = parse(source, languages.go!);
    const symbols = extractSymbolsFromTree(tree, 'go');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Bar');
    expect(symbols[0]!.kind).toBe('method');
    expect(symbols[0]!.parent).toBe('Svc');
  });

  it('extracts a method with value receiver', () => {
    const source = 'package main\n\nfunc (s Svc) Bar() {}';
    const tree = parse(source, languages.go!);
    const symbols = extractSymbolsFromTree(tree, 'go');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Bar');
    expect(symbols[0]!.kind).toBe('method');
    expect(symbols[0]!.parent).toBe('Svc');
  });

  it('extracts a struct type', () => {
    const source = 'package main\n\ntype Svc struct {\n\tname string\n}';
    const tree = parse(source, languages.go!);
    const symbols = extractSymbolsFromTree(tree, 'go');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Svc');
    expect(symbols[0]!.kind).toBe('class'); // struct → class
  });

  it('extracts an interface type', () => {
    const source = 'package main\n\ntype Reader interface {\n\tRead() error\n}';
    const tree = parse(source, languages.go!);
    const symbols = extractSymbolsFromTree(tree, 'go');
    tree.delete();

    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.name).toBe('Reader');
    expect(symbols[0]!.kind).toBe('interface');
  });

  it('extracts multiple Go symbols', () => {
    const source = `package main

func Foo() {}

type Svc struct {}

func (s *Svc) Bar() {}

type Reader interface {}`;
    const tree = parse(source, languages.go!);
    const symbols = extractSymbolsFromTree(tree, 'go');
    tree.delete();

    expect(symbols).toHaveLength(4);
    expect(symbols.map((s) => s.name)).toEqual(['Foo', 'Svc', 'Bar', 'Reader']);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────

describe('Edge cases', () => {
  it('returns empty array for empty source', () => {
    const tree = parse('', languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toEqual([]);
  });

  it('returns empty array for source with only imports', () => {
    const tree = parse("import { foo } from './bar';", languages.typescript!);
    const symbols = extractSymbolsFromTree(tree, 'typescript');
    tree.delete();

    expect(symbols).toEqual([]);
  });

  it('returns empty array for unsupported language', () => {
    const tree = parse('fn main() {}', languages.typescript!); // wrong grammar, but tests the language check
    // Using 'ruby' as unsupported language - extractSymbolsFromTree checks the config
    const symbols = extractSymbolsFromTree(tree, 'ruby' as ScopeLanguage);
    tree.delete();

    expect(symbols).toEqual([]);
  });
});
