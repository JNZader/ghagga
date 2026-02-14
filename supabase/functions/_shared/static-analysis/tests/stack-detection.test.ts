/**
 * Tests for Stack Detection
 */

import {
  assertEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { detectStack, getStackContext } from '../stack-detection.ts';

describe('Stack Detection', () => {
  describe('detectStack', () => {
    it('should detect java-gradle from build.gradle', () => {
      assertEquals(detectStack(['build.gradle', 'src/Main.java']), 'java-gradle');
    });

    it('should detect java-gradle from build.gradle.kts', () => {
      assertEquals(detectStack(['build.gradle.kts', 'src/Main.kt']), 'java-gradle');
    });

    it('should detect java-maven from pom.xml', () => {
      assertEquals(detectStack(['pom.xml', 'src/Main.java']), 'java-maven');
    });

    it('should detect node-npm from package.json (default)', () => {
      assertEquals(detectStack(['package.json', 'src/index.ts']), 'node-npm');
    });

    it('should detect node-yarn from yarn.lock', () => {
      assertEquals(detectStack(['package.json', 'yarn.lock', 'src/index.ts']), 'node-yarn');
    });

    it('should detect node-pnpm from pnpm-lock.yaml', () => {
      assertEquals(detectStack(['package.json', 'pnpm-lock.yaml', 'src/index.ts']), 'node-pnpm');
    });

    it('should detect python from pyproject.toml', () => {
      assertEquals(detectStack(['pyproject.toml', 'main.py']), 'python');
    });

    it('should detect python from setup.py', () => {
      assertEquals(detectStack(['setup.py', 'main.py']), 'python');
    });

    it('should detect python from requirements.txt', () => {
      assertEquals(detectStack(['requirements.txt', 'app.py']), 'python');
    });

    it('should detect go from go.mod', () => {
      assertEquals(detectStack(['go.mod', 'main.go']), 'go');
    });

    it('should detect rust from Cargo.toml', () => {
      assertEquals(detectStack(['Cargo.toml', 'src/main.rs']), 'rust');
    });

    it('should return unknown when no build files present', () => {
      assertEquals(detectStack(['README.md', '.gitignore']), 'unknown');
    });

    it('should return unknown for empty file list', () => {
      assertEquals(detectStack([]), 'unknown');
    });

    // Priority tests
    it('should prioritize gradle over maven', () => {
      assertEquals(detectStack(['build.gradle', 'pom.xml']), 'java-gradle');
    });

    it('should prioritize maven over node', () => {
      assertEquals(detectStack(['pom.xml', 'package.json']), 'java-maven');
    });

    it('should prioritize node over python', () => {
      assertEquals(detectStack(['package.json', 'pyproject.toml']), 'node-npm');
    });

    it('should prioritize python over go', () => {
      assertEquals(detectStack(['pyproject.toml', 'go.mod']), 'python');
    });

    it('should prioritize go over rust', () => {
      assertEquals(detectStack(['go.mod', 'Cargo.toml']), 'go');
    });

    it('should handle files in subdirectories', () => {
      assertEquals(detectStack(['backend/package.json', 'src/index.ts']), 'node-npm');
    });

    it('should handle full paths with slashes', () => {
      assertEquals(detectStack(['services/api/go.mod', 'services/api/main.go']), 'go');
    });
  });

  describe('getStackContext', () => {
    it('should return context for each known stack', () => {
      const stacks = [
        'java-gradle', 'java-maven', 'node-npm', 'node-yarn', 'node-pnpm',
        'python', 'go', 'rust', 'unknown',
      ] as const;

      for (const stack of stacks) {
        const context = getStackContext(stack);
        assertEquals(typeof context, 'string');
        assertEquals(context.length > 0, true);
      }
    });

    it('should mention stack name in context', () => {
      assertEquals(getStackContext('node-npm').includes('Node.js'), true);
      assertEquals(getStackContext('python').includes('Python'), true);
      assertEquals(getStackContext('go').includes('Go'), true);
      assertEquals(getStackContext('rust').includes('Rust'), true);
      assertEquals(getStackContext('java-gradle').includes('Java'), true);
    });
  });
});
