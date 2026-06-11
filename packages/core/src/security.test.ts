import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security audit tests.
 *
 * These tests verify security-critical properties of the codebase:
 * - API keys are never logged
 * - Encryption uses AES-256-GCM
 * - Webhook signatures use constant-time comparison
 * - Privacy stripping works on all common secret formats
 * - No hardcoded secrets in source code
 */

// ─── Helpers ────────────────────────────────────────────────────

/** Recursively collect all .ts source files (excluding tests, declarations, node_modules, dist). */
function getAllTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      files.push(...getAllTsFiles(fullPath));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

// ─── Test Data ──────────────────────────────────────────────────

// Resolve paths relative to the package root (vitest cwd = packages/core)
const coreSrcDir = join(process.cwd(), 'src');
const coreFiles = getAllTsFiles(coreSrcDir);

// Also scan the server and CLI if reachable from the monorepo
const monorepoRoot = join(process.cwd(), '..', '..');

function safeGetTsFiles(dir: string): string[] {
  try {
    return getAllTsFiles(dir);
  } catch {
    return [];
  }
}

const serverFiles = safeGetTsFiles(join(monorepoRoot, 'apps', 'server', 'src'));
const cliFiles = safeGetTsFiles(join(monorepoRoot, 'apps', 'cli', 'src'));
const dbFiles = safeGetTsFiles(join(monorepoRoot, 'packages', 'db', 'src'));
const allSourceFiles = [...coreFiles, ...serverFiles, ...cliFiles, ...dbFiles];

// ─── Tests ──────────────────────────────────────────────────────

describe('Security Audit', () => {
  describe('No API key logging', () => {
    it('should not contain console.log with apiKey, secret, or password', () => {
      const dangerousPatterns = [
        /console\.log\(.*apiKey/i,
        /console\.log\(.*api_key/i,
        /console\.log\(.*secret/i,
        /console\.log\(.*password/i,
        /console\.log\(.*token[^s]/i, // tokenS is ok (tokensUsed)
      ];

      for (const file of allSourceFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const pattern of dangerousPatterns) {
          expect(
            pattern.test(content),
            `Found potential secret logging in ${file} matching ${pattern}`,
          ).toBe(false);
        }
      }
    });

    it('should not contain console.info or console.debug with secrets', () => {
      const dangerousPatterns = [
        /console\.(info|debug)\(.*apiKey/i,
        /console\.(info|debug)\(.*secret/i,
        /console\.(info|debug)\(.*password/i,
      ];

      for (const file of allSourceFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const pattern of dangerousPatterns) {
          expect(
            pattern.test(content),
            `Found potential secret logging in ${file} matching ${pattern}`,
          ).toBe(false);
        }
      }
    });
  });

  describe('Encryption usage', () => {
    it('crypto module uses AES-256-GCM (not CBC or ECB)', () => {
      const cryptoPath = join(monorepoRoot, 'packages', 'db', 'src', 'crypto.ts');
      let content: string;
      try {
        content = readFileSync(cryptoPath, 'utf-8');
      } catch {
        // If crypto.ts is not at the expected path, skip gracefully
        console.warn('crypto.ts not found — skipping encryption algorithm check');
        return;
      }

      // Must use GCM (authenticated encryption)
      expect(content).toContain('aes-256-gcm');

      // Must NOT use insecure modes
      expect(content).not.toContain('aes-256-cbc');
      expect(content).not.toContain('aes-256-ecb');
      expect(content).not.toContain('aes-128');
    });

    it('crypto module uses random IVs (not static)', () => {
      const cryptoPath = join(monorepoRoot, 'packages', 'db', 'src', 'crypto.ts');
      let content: string;
      try {
        content = readFileSync(cryptoPath, 'utf-8');
      } catch {
        return;
      }

      // Must use randomBytes for IV generation
      expect(content).toContain('randomBytes');
    });
  });

  describe('Webhook signature verification', () => {
    it('server uses timingSafeEqual for signature comparison', () => {
      const clientPath = join(monorepoRoot, 'apps', 'server', 'src', 'github', 'client.ts');
      let content: string;
      try {
        content = readFileSync(clientPath, 'utf-8');
      } catch {
        console.warn('server/src/github/client.ts not found — skipping webhook check');
        return;
      }

      // Must use constant-time comparison to prevent timing attacks
      expect(content).toContain('timingSafeEqual');

      // Must NOT use naive string comparison for signatures
      const naiveComparisonPatterns = [
        /signature\s*===?\s*computed/i,
        /computed\s*===?\s*signature/i,
        /hmac\s*===?\s*expected/i,
      ];

      for (const pattern of naiveComparisonPatterns) {
        expect(
          pattern.test(content),
          `Found naive signature comparison in webhook handler: ${pattern}`,
        ).toBe(false);
      }
    });
  });

  describe('Privacy stripping completeness', () => {
    it('strips all common API key formats', async () => {
      const { stripPrivateData } = await import('./memory/privacy.js');

      const testSecrets: Array<{ secret: string; description: string }> = [
        {
          secret: 'sk-ant-api03-abc123def456ghi789jkl012mno345pqr678',
          description: 'Anthropic API key',
        },
        {
          secret: 'sk-projAbcDefGhiJklMnoPqrSt',
          description: 'OpenAI API key (sk-...20+ alphanum)',
        },
        {
          secret: 'AKIAIOSFODNN7EXAMPLE',
          description: 'AWS Access Key ID',
        },
        {
          secret: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde',
          description: 'GitHub PAT (classic)',
        },
        {
          secret: 'gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde',
          description: 'GitHub OAuth token',
        },
        {
          secret: 'ghs_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcde',
          description: 'GitHub App token',
        },
        {
          // Google API key: constructed at runtime to avoid triggering GitHub secret scanning
          secret: 'AIza' + 'SyBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890A',
          description: 'Google API key',
        },
        {
          // Slack token pattern: xoxb- prefix followed by numbers and letters
          // Constructed at runtime to avoid triggering GitHub push protection
          secret: ['xoxb', '999888777666', 'fakeTokenForTest'].join('-'),
          description: 'Slack bot token',
        },
      ];

      for (const { secret, description } of testSecrets) {
        const input = `Found this: ${secret} in the code`;
        const result = stripPrivateData(input);
        expect(result, `Failed to redact ${description}: "${secret}"`).not.toContain(secret);
        expect(result, `Missing [REDACTED marker for ${description}`).toContain('[REDACTED');
      }
    });

    it('strips Bearer tokens with JWT payloads', async () => {
      const { stripPrivateData } = await import('./memory/privacy.js');

      const jwt =
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = stripPrivateData(jwt);
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(result).toContain('[REDACTED');
    });

    it('strips PEM private keys', async () => {
      const { stripPrivateData } = await import('./memory/privacy.js');

      const pem = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF068wCKz',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      const result = stripPrivateData(pem);
      expect(result).toContain('[REDACTED_PRIVATE_KEY]');
      expect(result).not.toContain('MIIEpAIBAAKCAQEA');
    });

    it('handles text with no secrets (returns unchanged)', async () => {
      const { stripPrivateData } = await import('./memory/privacy.js');

      const clean = 'function sum(a: number, b: number) { return a + b; }';
      expect(stripPrivateData(clean)).toBe(clean);
    });
  });

  describe('Source code patterns', () => {
    it('should not contain hardcoded API keys in source files', () => {
      const hardcodedPatterns = [
        /['"]sk-ant-[a-zA-Z0-9_-]{20,}['"]/,
        /['"]sk-[a-zA-Z0-9]{20,}['"]/,
        /['"]AKIA[0-9A-Z]{16}['"]/,
        /['"]ghp_[a-zA-Z0-9]{36,}['"]/,
      ];

      for (const file of allSourceFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const pattern of hardcodedPatterns) {
          expect(
            pattern.test(content),
            `Found potential hardcoded API key in ${file} matching ${pattern}`,
          ).toBe(false);
        }
      }
    });

    it('should not contain eval() calls in source code', () => {
      // eval() is a security risk — arbitrary code execution.
      // We only flag REAL call sites: `eval(` preceded by start-of-expression
      // context. We must NOT match `eval` when it appears as an alternation
      // branch inside a RegExp literal (e.g. the AISVS rule catalog in
      // aisvs.ts uses `/(?:eval|exec|...)\s*\(/` to *detect* this very
      // pattern). Strip line comments, string literals, and regex literals
      // before scanning so rule definitions are not counted as call sites.
      const stripNonCode = (src: string): string =>
        src
          // line comments
          .replace(/\/\/[^\n]*/g, '')
          // block comments
          .replace(/\/\*[\s\S]*?\*\//g, '')
          // template/single/double quoted strings
          .replace(/`(?:\\.|[^`\\])*`/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, '""')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          // regex literals: a slash not immediately following an identifier,
          // number, or closing paren/bracket, through the closing slash.
          .replace(
            /([=(,:[!&|?{};\n]\s*)\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g,
            '$1//',
          );

      const evalPattern = /\beval\s*\(/;

      for (const file of allSourceFiles) {
        const content = stripNonCode(readFileSync(file, 'utf-8'));
        expect(
          evalPattern.test(content),
          `Found eval() call in ${file} — use safer alternatives`,
        ).toBe(false);
      }
    });

    it('should not contain __proto__ access in source code', () => {
      // Prototype pollution is a common vulnerability
      const protoPattern = /__proto__/;

      for (const file of allSourceFiles) {
        const content = readFileSync(file, 'utf-8');
        expect(
          protoPattern.test(content),
          `Found __proto__ access in ${file} — risk of prototype pollution`,
        ).toBe(false);
      }
    });
  });

  describe('Codebase sanity', () => {
    it('found source files to audit', () => {
      // Ensure the test is actually scanning files (not silently empty)
      expect(coreFiles.length).toBeGreaterThan(0);
      expect(allSourceFiles.length).toBeGreaterThan(0);
    });

    it('scanned at least the core package files', () => {
      // Core should have pipeline.ts, types.ts, privacy.ts, etc.
      const coreFileNames = coreFiles.map((f) => f.split('/').pop());
      expect(coreFileNames).toContain('pipeline.ts');
      expect(coreFileNames).toContain('types.ts');
      expect(coreFileNames).toContain('privacy.ts');
    });
  });
});
