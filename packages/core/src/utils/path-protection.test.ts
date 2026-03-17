import { describe, expect, it } from 'vitest';
import type { DiffFile } from './diff.js';
import {
  applyPathProtection,
  REDACT_PATTERNS,
  REDACTED_CONTENT,
  ZERO_ACCESS_PATTERNS,
} from './path-protection.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeFile(path: string, content?: string): DiffFile {
  return {
    path,
    additions: 1,
    deletions: 0,
    content: content ?? `diff content for ${path}`,
  };
}

// ─── ZERO_ACCESS Tier ───────────────────────────────────────────

describe('ZERO_ACCESS — blocks sensitive files entirely', () => {
  it('blocks .env at root', () => {
    const result = applyPathProtection([makeFile('.env')]);
    expect(result.blocked).toContain('.env');
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks .env.production (dotenv variants)', () => {
    const result = applyPathProtection([makeFile('.env.production')]);
    expect(result.blocked).toContain('.env.production');
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks .env.local and .env.staging', () => {
    const files = [makeFile('.env.local'), makeFile('.env.staging')];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(2);
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks nested .env files (src/.env)', () => {
    const result = applyPathProtection([makeFile('src/.env')]);
    expect(result.blocked).toContain('src/.env');
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks nested .env.production (config/.env.production)', () => {
    const result = applyPathProtection([makeFile('config/.env.production')]);
    expect(result.blocked).toContain('config/.env.production');
  });

  it('blocks private key files (*.pem, *.key, *.p12, *.pfx)', () => {
    const files = [
      makeFile('certs/server.pem'),
      makeFile('ssl/private.key'),
      makeFile('auth/cert.p12'),
      makeFile('tls/bundle.pfx'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(4);
    expect(result.allowed).toHaveLength(0);
  });

  it('blocks Java keystores (*.jks, *.keystore)', () => {
    const files = [makeFile('keystore.jks'), makeFile('app.keystore')];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(2);
  });

  it('blocks SSH keys (id_rsa, id_ed25519, id_ecdsa)', () => {
    const files = [makeFile('id_rsa'), makeFile('id_ed25519'), makeFile('id_ecdsa')];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(3);
  });

  it('blocks SSH public keys (*.pub)', () => {
    const result = applyPathProtection([makeFile('id_rsa.pub')]);
    expect(result.blocked).toContain('id_rsa.pub');
  });

  it('blocks nested SSH keys (home/.ssh/id_rsa)', () => {
    const result = applyPathProtection([makeFile('home/.ssh/id_rsa')]);
    expect(result.blocked).toContain('home/.ssh/id_rsa');
  });

  it('blocks cloud credentials (credentials.json, service-account*.json, gcloud*.json)', () => {
    const files = [
      makeFile('credentials.json'),
      makeFile('service-account-prod.json'),
      makeFile('gcloud-key.json'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(3);
  });

  it('blocks package manager credentials (.npmrc, .pypirc)', () => {
    const files = [makeFile('.npmrc'), makeFile('.pypirc')];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(2);
  });

  it('blocks .gem/credentials', () => {
    const result = applyPathProtection([makeFile('.gem/credentials')]);
    expect(result.blocked).toContain('.gem/credentials');
  });

  it('blocks Docker and Kubernetes configs', () => {
    const files = [
      makeFile('.docker/config.json'),
      makeFile('kubeconfig'),
      makeFile('kube/config'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(3);
  });

  it('blocks .aws directory contents', () => {
    const files = [
      makeFile('.aws/credentials'),
      makeFile('.aws/config'),
      makeFile('home/user/.aws/credentials'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(3);
  });

  it('blocks .ssh directory contents', () => {
    const files = [
      makeFile('.ssh/known_hosts'),
      makeFile('.ssh/authorized_keys'),
      makeFile('user/.ssh/config'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(3);
  });

  it('blocks .gnupg directory contents', () => {
    const files = [makeFile('.gnupg/pubring.kbx'), makeFile('home/.gnupg/trustdb.gpg')];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(2);
  });

  it('blocks generic secret files (*.secret, *.secrets, secrets.yml, secrets.yaml, vault.yml)', () => {
    const files = [
      makeFile('app.secret'),
      makeFile('db.secrets'),
      makeFile('secrets.yml'),
      makeFile('secrets.yaml'),
      makeFile('vault.yml'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(5);
  });

  it('blocks nested secrets files (config/secrets.yml)', () => {
    const result = applyPathProtection([makeFile('config/secrets.yml')]);
    expect(result.blocked).toContain('config/secrets.yml');
  });

  it('never includes blocked files in allowed or redacted', () => {
    const files = [makeFile('.env'), makeFile('id_rsa'), makeFile('certs/server.pem')];
    const result = applyPathProtection(files);
    expect(result.allowed).toHaveLength(0);
    expect(result.redacted).toHaveLength(0);
    expect(result.blocked).toHaveLength(3);
  });
});

// ─── REDACT Tier ────────────────────────────────────────────────

describe('REDACT — replaces content but keeps path visible', () => {
  it('redacts .env.example', () => {
    const result = applyPathProtection([makeFile('.env.example', 'DB_HOST=localhost')]);
    expect(result.redacted).toHaveLength(1);
    expect(result.redacted[0]?.path).toBe('.env.example');
    expect(result.redacted[0]?.content).toBe(REDACTED_CONTENT);
    expect(result.blocked).toHaveLength(0);
    expect(result.allowed).toHaveLength(0);
  });

  it('redacts .env.sample and .env.template', () => {
    const files = [
      makeFile('.env.sample', 'SECRET=xxx'),
      makeFile('.env.template', 'API_KEY=changeme'),
    ];
    const result = applyPathProtection(files);
    expect(result.redacted).toHaveLength(2);
    for (const file of result.redacted) {
      expect(file.content).toBe(REDACTED_CONTENT);
    }
  });

  it('redacts docker-compose*.yml', () => {
    const files = [
      makeFile('docker-compose.yml', 'version: 3'),
      makeFile('docker-compose.prod.yml', 'version: 3'),
      makeFile('docker-compose-dev.yml', 'version: 3'),
    ];
    const result = applyPathProtection(files);
    expect(result.redacted).toHaveLength(3);
    for (const file of result.redacted) {
      expect(file.content).toBe(REDACTED_CONTENT);
    }
  });

  it('redacts terraform.tfvars (including nested)', () => {
    const files = [makeFile('terraform.tfvars'), makeFile('infra/terraform.tfvars')];
    const result = applyPathProtection(files);
    expect(result.redacted).toHaveLength(2);
  });

  it('redacts terraform.tfstate and terraform.tfstate.backup', () => {
    const files = [
      makeFile('terraform.tfstate'),
      makeFile('terraform.tfstate.backup'),
      makeFile('env/prod/terraform.tfstate'),
    ];
    const result = applyPathProtection(files);
    expect(result.redacted).toHaveLength(3);
  });

  it('preserves path and line counts in redacted files', () => {
    const original = makeFile('docker-compose.yml', 'original content here');
    original.additions = 10;
    original.deletions = 5;
    const result = applyPathProtection([original]);
    const redacted = result.redacted[0];
    expect(redacted?.path).toBe('docker-compose.yml');
    expect(redacted?.additions).toBe(10);
    expect(redacted?.deletions).toBe(5);
    expect(redacted?.content).toBe(REDACTED_CONTENT);
  });
});

// ─── Pass-Through (Normal Files) ────────────────────────────────

describe('Normal files — pass through untouched', () => {
  it('allows regular source files', () => {
    const files = [
      makeFile('src/index.ts', 'export function main() {}'),
      makeFile('src/utils/helper.ts', 'export const x = 1;'),
    ];
    const result = applyPathProtection(files);
    expect(result.allowed).toHaveLength(2);
    expect(result.blocked).toHaveLength(0);
    expect(result.redacted).toHaveLength(0);
  });

  it('does not touch content of allowed files', () => {
    const content = 'export function main() { return 42; }';
    const result = applyPathProtection([makeFile('src/main.ts', content)]);
    expect(result.allowed[0]?.content).toBe(content);
  });

  it('allows package.json, tsconfig.json, and config files', () => {
    const files = [
      makeFile('package.json'),
      makeFile('tsconfig.json'),
      makeFile('biome.json'),
      makeFile('.eslintrc.js'),
    ];
    const result = applyPathProtection(files);
    expect(result.allowed).toHaveLength(4);
  });

  it('allows test files', () => {
    const result = applyPathProtection([makeFile('src/utils/diff.test.ts')]);
    expect(result.allowed).toHaveLength(1);
  });
});

// ─── Mixed Input ────────────────────────────────────────────────

describe('Mixed input — correct tier assignment', () => {
  it('correctly categorizes a mix of blocked, redacted, and allowed files', () => {
    const files = [
      makeFile('.env'), // ZERO_ACCESS
      makeFile('id_rsa'), // ZERO_ACCESS
      makeFile('.env.example'), // REDACT
      makeFile('docker-compose.yml'), // REDACT
      makeFile('src/index.ts'), // allowed
      makeFile('src/utils.ts'), // allowed
      makeFile('certs/server.pem'), // ZERO_ACCESS
      makeFile('terraform.tfvars'), // REDACT
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toEqual(['.env', 'id_rsa', 'certs/server.pem']);
    expect(result.redacted).toHaveLength(3);
    expect(result.redacted.map((f) => f.path)).toEqual([
      '.env.example',
      'docker-compose.yml',
      'terraform.tfvars',
    ]);
    expect(result.allowed).toHaveLength(2);
    expect(result.allowed.map((f) => f.path)).toEqual(['src/index.ts', 'src/utils.ts']);
  });

  it('REDACT patterns take priority over ZERO_ACCESS for specific exceptions', () => {
    // .env.example matches both .env.* (ZERO_ACCESS) and .env.example (REDACT).
    // REDACT is checked first because it contains more specific exceptions.
    const result = applyPathProtection([makeFile('.env.example')]);
    expect(result.redacted).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it('ZERO_ACCESS catches .env variants that are not in REDACT', () => {
    // .env.production matches .env.* (ZERO_ACCESS) but NOT any REDACT pattern
    const result = applyPathProtection([makeFile('.env.production')]);
    expect(result.blocked).toContain('.env.production');
    expect(result.redacted).toHaveLength(0);
  });
});

// ─── Determinism and Purity ─────────────────────────────────────

describe('Function properties — deterministic and pure', () => {
  it('returns identical results for identical inputs', () => {
    const files = [makeFile('.env'), makeFile('src/app.ts'), makeFile('.env.example')];
    const result1 = applyPathProtection(files);
    const result2 = applyPathProtection(files);
    expect(result1.blocked).toEqual(result2.blocked);
    expect(result1.redacted.map((f) => f.path)).toEqual(result2.redacted.map((f) => f.path));
    expect(result1.allowed.map((f) => f.path)).toEqual(result2.allowed.map((f) => f.path));
  });

  it('does not mutate the input array', () => {
    const files = [makeFile('.env'), makeFile('src/app.ts')];
    const copy = [...files];
    applyPathProtection(files);
    expect(files).toEqual(copy);
  });

  it('does not mutate the original file objects', () => {
    const envExample = makeFile('.env.example', 'original content');
    const contentBefore = envExample.content;
    applyPathProtection([envExample]);
    // Original object should not be modified
    expect(envExample.content).toBe(contentBefore);
  });

  it('returns empty arrays when given no files', () => {
    const result = applyPathProtection([]);
    expect(result.allowed).toEqual([]);
    expect(result.redacted).toEqual([]);
    expect(result.blocked).toEqual([]);
  });
});

// ─── Pattern Integrity ──────────────────────────────────────────

describe('Pattern lists — immutable and non-empty', () => {
  it('ZERO_ACCESS_PATTERNS is non-empty', () => {
    expect(ZERO_ACCESS_PATTERNS.length).toBeGreaterThan(0);
  });

  it('REDACT_PATTERNS is non-empty', () => {
    expect(REDACT_PATTERNS.length).toBeGreaterThan(0);
  });

  it('REDACTED_CONTENT is a non-empty string', () => {
    expect(REDACTED_CONTENT).toBeTruthy();
    expect(typeof REDACTED_CONTENT).toBe('string');
  });

  it('ZERO_ACCESS_PATTERNS is readonly (frozen at type level)', () => {
    // TypeScript enforces readonly at compile time, but we can verify
    // the array exists and has the expected shape
    expect(Array.isArray(ZERO_ACCESS_PATTERNS)).toBe(true);
    expect(ZERO_ACCESS_PATTERNS.every((p) => typeof p === 'string')).toBe(true);
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────

describe('Edge cases', () => {
  it('handles deeply nested sensitive files', () => {
    const files = [
      makeFile('a/b/c/d/.env'),
      makeFile('deep/nested/path/id_rsa'),
      makeFile('very/deep/config/secrets.yml'),
    ];
    const result = applyPathProtection(files);
    expect(result.blocked).toHaveLength(3);
  });

  it('does not block files with similar but non-matching names', () => {
    const files = [
      makeFile('env.ts'), // NOT .env
      makeFile('my-secret-app.ts'), // NOT *.secret
      makeFile('key-utils.ts'), // NOT *.key
      makeFile('envfile'), // NOT .env
    ];
    const result = applyPathProtection(files);
    expect(result.allowed).toHaveLength(4);
    expect(result.blocked).toHaveLength(0);
  });

  it('handles files with spaces in path', () => {
    const result = applyPathProtection([makeFile('my project/.env')]);
    expect(result.blocked).toContain('my project/.env');
  });

  it('handles single file that passes all tiers', () => {
    const file = makeFile('src/components/Button.tsx', '<button>Click</button>');
    const result = applyPathProtection([file]);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]).toBe(file); // Same reference — not copied
  });
});
