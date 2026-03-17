/**
 * Unit tests for regex-based language extractors.
 *
 * At least 30 tests across all 6 languages:
 * TypeScript, JavaScript, Python, Go, Java, Rust.
 */

import { describe, expect, it } from 'vitest';
import { goExtractor } from './go.js';
import { getExtractor } from './index.js';
import { javaExtractor } from './java.js';
import { javascriptExtractor } from './javascript.js';
import { pythonExtractor } from './python.js';
import { rustExtractor } from './rust.js';
import { typescriptExtractor } from './typescript.js';

// ─── Registry ───────────────────────────────────────────────────

describe('getExtractor', () => {
  it('returns TypeScript extractor', () => {
    expect(getExtractor('typescript')).toBe(typescriptExtractor);
  });

  it('returns JavaScript extractor', () => {
    expect(getExtractor('javascript')).toBe(javascriptExtractor);
  });

  it('returns Python extractor', () => {
    expect(getExtractor('python')).toBe(pythonExtractor);
  });

  it('returns Go extractor', () => {
    expect(getExtractor('go')).toBe(goExtractor);
  });

  it('returns Java extractor', () => {
    expect(getExtractor('java')).toBe(javaExtractor);
  });

  it('returns Rust extractor', () => {
    expect(getExtractor('rust')).toBe(rustExtractor);
  });
});

// ─── TypeScript ─────────────────────────────────────────────────

describe('TypeScript extractor', () => {
  describe('imports', () => {
    it('extracts named imports', () => {
      const content = `import { foo, bar } from './utils';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('./utils');
      expect(imports[0]?.symbols).toContain('foo');
      expect(imports[0]?.symbols).toContain('bar');
    });

    it('extracts default import', () => {
      const content = `import React from 'react';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('react');
      expect(imports[0]?.symbols).toContain('React');
    });

    it('extracts namespace import', () => {
      const content = `import * as path from 'node:path';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('node:path');
      expect(imports[0]?.symbols).toContain('path');
    });

    it('extracts side-effect import', () => {
      const content = `import './polyfill';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('./polyfill');
      expect(imports[0]?.symbols).toEqual([]);
    });

    it('extracts type imports', () => {
      const content = `import type { DependencyGraph } from './schema';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('./schema');
      expect(imports[0]?.symbols).toContain('DependencyGraph');
    });

    it('extracts mixed default + named import', () => {
      const content = `import React, { useState, useEffect } from 'react';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports.length).toBeGreaterThanOrEqual(1);
      const reactImport = imports.find((i) => i.source === 'react');
      expect(reactImport).toBeDefined();
      expect(reactImport?.symbols).toContain('React');
      expect(reactImport?.symbols).toContain('useState');
    });

    it('handles aliased imports', () => {
      const content = `import { foo as bar } from './module';`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      // Should extract original name (foo), stripping alias
      expect(imports[0]?.symbols).toContain('foo');
    });

    it('handles multiple import statements', () => {
      const content = `
import { a } from './a';
import { b } from './b';
import c from './c';
`;
      const imports = typescriptExtractor.extractImports(content);
      expect(imports).toHaveLength(3);
    });
  });

  describe('exports', () => {
    it('extracts export function', () => {
      const content = `export function computeBlastRadius() {}`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'computeBlastRadius', kind: 'function' });
    });

    it('extracts export async function', () => {
      const content = `export async function fetchData() {}`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'fetchData', kind: 'function' });
    });

    it('extracts export class', () => {
      const content = `export class GitHubApiGraphLoader {}`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'GitHubApiGraphLoader', kind: 'class' });
    });

    it('extracts export const', () => {
      const content = `export const GRAPH_VERSION = 1;`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'GRAPH_VERSION', kind: 'variable' });
    });

    it('extracts export type', () => {
      const content = `export type SupportedLanguage = 'typescript' | 'javascript';`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'SupportedLanguage', kind: 'type' });
    });

    it('extracts export interface', () => {
      const content = `export interface DependencyGraph { version: number; }`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'DependencyGraph', kind: 'type' });
    });

    it('extracts export default', () => {
      const content = `export default reviewQueue;`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'reviewQueue', kind: 'default' });
    });

    it('extracts named re-exports', () => {
      const content = `export { buildReverseIndex, computeBlastRadius } from './blast-radius';`;
      const exports = typescriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'buildReverseIndex', kind: 'variable' });
      expect(exports).toContainEqual({ name: 'computeBlastRadius', kind: 'variable' });
    });
  });
});

// ─── JavaScript ─────────────────────────────────────────────────

describe('JavaScript extractor', () => {
  describe('imports', () => {
    it('extracts ES module named imports', () => {
      const content = `import { readFile } from 'fs';`;
      const imports = javascriptExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('fs');
      expect(imports[0]?.symbols).toContain('readFile');
    });

    it('extracts CommonJS require (default)', () => {
      const content = `const express = require('express');`;
      const imports = javascriptExtractor.extractImports(content);
      expect(imports.length).toBeGreaterThanOrEqual(1);
      const req = imports.find((i) => i.source === 'express');
      expect(req).toBeDefined();
      expect(req?.symbols).toContain('express');
    });

    it('extracts CommonJS require (destructured)', () => {
      const content = `const { join, resolve } = require('path');`;
      const imports = javascriptExtractor.extractImports(content);
      const req = imports.find((i) => i.source === 'path');
      expect(req).toBeDefined();
      expect(req?.symbols).toContain('join');
      expect(req?.symbols).toContain('resolve');
    });
  });

  describe('exports', () => {
    it('extracts module.exports object', () => {
      const content = `module.exports = { handler, middleware };`;
      const exports = javascriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'handler', kind: 'variable' });
      expect(exports).toContainEqual({ name: 'middleware', kind: 'variable' });
    });

    it('extracts module.exports single', () => {
      const content = `module.exports = Router;`;
      const exports = javascriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Router', kind: 'default' });
    });

    it('extracts exports.x = ...', () => {
      const content = `exports.handler = function() {};`;
      const exports = javascriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'handler', kind: 'variable' });
    });

    it('extracts ES module export function', () => {
      const content = `export function createServer() {}`;
      const exports = javascriptExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'createServer', kind: 'function' });
    });
  });
});

// ─── Python ─────────────────────────────────────────────────────

describe('Python extractor', () => {
  describe('imports', () => {
    it('extracts "import x"', () => {
      const content = `import os`;
      const imports = pythonExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('os');
    });

    it('extracts "from x import y"', () => {
      const content = `from pathlib import Path`;
      const imports = pythonExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('pathlib');
      expect(imports[0]?.symbols).toContain('Path');
    });

    it('extracts relative imports', () => {
      const content = `from . import utils`;
      const imports = pythonExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('.');
      expect(imports[0]?.symbols).toContain('utils');
    });

    it('extracts "from ..module import func"', () => {
      const content = `from ..models import User, Admin`;
      const imports = pythonExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('..models');
      expect(imports[0]?.symbols).toContain('User');
      expect(imports[0]?.symbols).toContain('Admin');
    });
  });

  describe('exports', () => {
    it('extracts public functions', () => {
      const content = `def process_data():\n    pass`;
      const exports = pythonExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'process_data', kind: 'function' });
    });

    it('skips private functions (starting with _)', () => {
      const content = `def _internal_helper():\n    pass`;
      const exports = pythonExtractor.extractExports(content);
      expect(exports).toHaveLength(0);
    });

    it('extracts public classes', () => {
      const content = `class UserService:\n    pass`;
      const exports = pythonExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'UserService', kind: 'class' });
    });

    it('respects __all__ when present', () => {
      const content = `
__all__ = ['exported_func', 'ExportedClass']

def exported_func():
    pass

def hidden_func():
    pass

class ExportedClass:
    pass
`;
      const exports = pythonExtractor.extractExports(content);
      expect(exports).toHaveLength(2);
      expect(exports).toContainEqual({ name: 'exported_func', kind: 'variable' });
      expect(exports).toContainEqual({ name: 'ExportedClass', kind: 'variable' });
    });
  });
});

// ─── Go ─────────────────────────────────────────────────────────

describe('Go extractor', () => {
  describe('imports', () => {
    it('extracts single import', () => {
      const content = `import "fmt"`;
      const imports = goExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('fmt');
    });

    it('extracts import block', () => {
      const content = `
import (
  "fmt"
  "net/http"
  "os"
)`;
      const imports = goExtractor.extractImports(content);
      expect(imports).toHaveLength(3);
      expect(imports.map((i) => i.source)).toContain('fmt');
      expect(imports.map((i) => i.source)).toContain('net/http');
      expect(imports.map((i) => i.source)).toContain('os');
    });

    it('extracts aliased imports', () => {
      const content = `import mux "github.com/gorilla/mux"`;
      const imports = goExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('github.com/gorilla/mux');
      expect(imports[0]?.symbols).toContain('mux');
    });
  });

  describe('exports', () => {
    it('extracts exported functions (uppercase)', () => {
      const content = `func HandleRequest(w http.ResponseWriter) {}`;
      const exports = goExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'HandleRequest', kind: 'function' });
    });

    it('does not extract unexported functions (lowercase)', () => {
      const content = `func handleRequest(w http.ResponseWriter) {}`;
      const exports = goExtractor.extractExports(content);
      expect(exports).toHaveLength(0);
    });

    it('extracts exported types', () => {
      const content = `type Server struct {\n  port int\n}`;
      const exports = goExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Server', kind: 'type' });
    });

    it('extracts method receivers as functions', () => {
      const content = `func (s *Server) Start() error { return nil }`;
      const exports = goExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Start', kind: 'function' });
    });
  });
});

// ─── Java ───────────────────────────────────────────────────────

describe('Java extractor', () => {
  describe('imports', () => {
    it('extracts import statements', () => {
      const content = `import java.util.List;`;
      const imports = javaExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('java.util.List');
      expect(imports[0]?.symbols).toContain('List');
    });

    it('extracts wildcard imports', () => {
      const content = `import java.util.*;`;
      const imports = javaExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('java.util.*');
      expect(imports[0]?.symbols).toEqual([]);
    });

    it('extracts static imports', () => {
      const content = `import static org.junit.Assert.assertEquals;`;
      const imports = javaExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('org.junit.Assert.assertEquals');
    });
  });

  describe('exports', () => {
    it('extracts public class', () => {
      const content = `public class UserService { }`;
      const exports = javaExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'UserService', kind: 'class' });
    });

    it('extracts public interface', () => {
      const content = `public interface Repository { }`;
      const exports = javaExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Repository', kind: 'type' });
    });

    it('extracts public enum', () => {
      const content = `public enum Status { ACTIVE, INACTIVE }`;
      const exports = javaExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Status', kind: 'type' });
    });
  });
});

// ─── Rust ───────────────────────────────────────────────────────

describe('Rust extractor', () => {
  describe('imports', () => {
    it('extracts use statement', () => {
      const content = `use std::collections::HashMap;`;
      const imports = rustExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('std::collections');
      expect(imports[0]?.symbols).toContain('HashMap');
    });

    it('extracts grouped use', () => {
      const content = `use std::collections::{HashMap, BTreeMap};`;
      const imports = rustExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('std::collections');
      expect(imports[0]?.symbols).toContain('HashMap');
      expect(imports[0]?.symbols).toContain('BTreeMap');
    });

    it('extracts mod declaration', () => {
      const content = `mod handlers;`;
      const imports = rustExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('handlers');
    });

    it('extracts crate-relative use', () => {
      const content = `use crate::config::Settings;`;
      const imports = rustExtractor.extractImports(content);
      expect(imports).toHaveLength(1);
      expect(imports[0]?.source).toBe('crate::config');
      expect(imports[0]?.symbols).toContain('Settings');
    });
  });

  describe('exports', () => {
    it('extracts pub fn', () => {
      const content = `pub fn process(data: &[u8]) -> Result<()> {}`;
      const exports = rustExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'process', kind: 'function' });
    });

    it('extracts pub async fn', () => {
      const content = `pub async fn serve(port: u16) {}`;
      const exports = rustExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'serve', kind: 'function' });
    });

    it('extracts pub struct', () => {
      const content = `pub struct Config {\n  pub port: u16,\n}`;
      const exports = rustExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Config', kind: 'type' });
    });

    it('extracts pub enum', () => {
      const content = `pub enum Status {\n  Active,\n  Inactive,\n}`;
      const exports = rustExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Status', kind: 'type' });
    });

    it('extracts pub trait', () => {
      const content = `pub trait Handler {\n  fn handle(&self);\n}`;
      const exports = rustExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'Handler', kind: 'type' });
    });

    it('extracts pub const', () => {
      const content = `pub const MAX_SIZE: usize = 1024;`;
      const exports = rustExtractor.extractExports(content);
      expect(exports).toContainEqual({ name: 'MAX_SIZE', kind: 'variable' });
    });
  });
});
