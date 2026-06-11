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

// ─── Lexical scanner ────────────────────────────────────────────

/**
 * Neutralize comments, string literals, and regex literals so that a downstream
 * scan only sees real code. Stripped spans are replaced with spaces (offsets and
 * line numbers are preserved, so error messages keep pointing at the right place).
 *
 * Implemented as a SINGLE left-to-right pass with explicit lexical state, because
 * the naive multi-`.replace` approach is order-dependent and unsound:
 *   - stripping `//` line comments before strings turns
 *     `const url = "https://x"; eval(payload)` into `const url = ` (the `//`
 *     inside the URL is wrongly treated as a comment → the real `eval()` is lost);
 *   - a single-quote string regex that stops at `\n` misses line-continuation
 *     strings (`'\` + newline), so code after the (still open) string leaks
 *     through as if it were code.
 *
 * States handled: line comment, block comment, single/double/template string
 * (with `\\.` escapes and, for templates, basic nesting of `${ ... }`), and
 * regex literals (disambiguated from division by the previous significant char).
 */
function stripNonCode(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  // Last significant (non-whitespace, non-stripped) code char emitted. Used to
  // decide whether a `/` starts a regex literal or is a division operator.
  let lastSignificant = '';

  // Emit a char verbatim; track it as the last significant code char.
  const emit = (ch: string): void => {
    out.push(ch);
    if (ch.trim() !== '') lastSignificant = ch;
  };
  // Replace a span [start, end) with spaces, preserving newlines for line counts.
  const blank = (start: number, end: number): void => {
    for (let k = start; k < end; k++) out.push(src[k] === '\n' ? '\n' : ' ');
  };

  // A `/` begins a regex literal when the previous significant char is one that
  // cannot end an expression (so a `/` after it must be a regex, not division).
  const regexAllowedAfter = (ch: string): boolean => {
    if (ch === '') return true; // start of file
    // Identifiers, numbers, and closing brackets/parens end an expression →
    // a following `/` is division, not a regex.
    if (/[A-Za-z0-9_$)\]}]/.test(ch)) return false;
    return true;
  };

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); // consume closing */
      blank(i, j);
      i = j;
      continue;
    }

    // Single- or double-quoted string (handles `\\.` escapes incl. line
    // continuation `\` + newline; an unterminated string blanks to EOF).
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2; // skip escaped char (covers `\` + newline line-continuation)
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      lastSignificant = quote; // a string is an expression value
      i = j;
      continue;
    }

    // Template literal (handles escapes + basic `${ ... }` nesting).
    if (ch === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (depth === 0 && c === '`') {
          j++;
          break;
        }
        if (depth === 0 && c === '$' && src[j + 1] === '{') {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && c === '{') {
          depth++;
          j++;
          continue;
        }
        if (depth > 0 && c === '}') {
          depth--;
          j++;
          continue;
        }
        j++;
      }
      blank(i, j);
      lastSignificant = '`';
      i = j;
      continue;
    }

    // Regex literal (only when context says a `/` cannot be division).
    if (ch === '/' && regexAllowedAfter(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break; // regex literals can't span newlines → not a regex
        if (c === '[') {
          inClass = true;
        } else if (c === ']') {
          inClass = false;
        } else if (c === '/' && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        // consume trailing flags
        while (j < n && /[a-z]/i.test(src[j])) j++;
        blank(i, j);
        lastSignificant = '/'; // regex is an expression value
        i = j;
        continue;
      }
      // Not actually a regex (no closing slash on this line): treat as division.
      emit(ch);
      i++;
      continue;
    }

    emit(ch);
    i++;
  }

  return out.join('');
}

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
      // We only flag REAL call sites. Comments, string literals, and regex
      // literals must be neutralized first, otherwise the AISVS rule catalog
      // in aisvs.ts (which uses `/(?:eval|exec|...)\s*\(/` regex literals and
      // descriptions containing the literal text `eval()`) would trip a false
      // positive. The naive multi-pass `.replace` approach is order-dependent
      // and unsound: stripping `//` comments before strings deletes the real
      // `eval()` in `const url = "https://x"; eval(payload)` because the `//`
      // inside the URL string is mistaken for a comment. So we scan once,
      // left-to-right, tracking lexical state. See the unit tests below.
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

// ─── Scanner unit tests ─────────────────────────────────────────

describe('stripNonCode (eval-scan lexer)', () => {
  const hasEval = (src: string): boolean => /\beval\s*\(/.test(stripNonCode(src));

  it('(a) keeps a real eval() that follows a string containing "//"', () => {
    // The `//` inside the URL string must NOT be treated as a comment, so the
    // real eval() after the statement must survive and be detected.
    const src = 'const url = "https://x"; eval(payload)';
    expect(hasEval(src)).toBe(true);
  });

  it('(b) ignores eval( that lives inside a line-continuation string', () => {
    // A single-quoted string with a `\` line continuation spanning a newline:
    // the `eval(` is part of the string body, not real code.
    const src = "const s = 'prefix \\\n eval( still inside the string';";
    expect(hasEval(src)).toBe(false);
  });

  it('(c) ignores eval inside regex literals and strings (aisvs.ts shape)', () => {
    // Mirrors the AISVS catalog: a regex literal alternation `eval|exec` plus a
    // description string mentioning `eval()`. Neither is a real call site.
    const src = [
      'const rule = {',
      '  description: "LLM response passed to eval(), exec(), or shell execution",',
      '  pattern: /(?:eval|exec|execSync|spawn|fork)\\s*\\(\\s*(?:result|response)\\b/i,',
      '};',
    ].join('\n');
    expect(hasEval(src)).toBe(false);
  });

  it('preserves line count when blanking spans (offset stability)', () => {
    const src = 'a\n// comment\n"str\\ning"\nb';
    expect(stripNonCode(src).split('\n').length).toBe(src.split('\n').length);
  });

  it('still detects a plain eval() call', () => {
    expect(hasEval('eval(userInput)')).toBe(true);
  });

  it('treats / as division (not regex) after an identifier', () => {
    // `a / b` is division; the trailing `eval(` is a genuine call site.
    const src = 'const x = a / b; eval(x)';
    expect(hasEval(src)).toBe(true);
  });
});
