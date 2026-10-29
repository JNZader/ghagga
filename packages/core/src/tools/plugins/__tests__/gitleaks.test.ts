/**
 * Tests for Gitleaks plugin — parse function with fixture data.
 *
 * Validates secret detection parsing, severity mapping, and edge cases.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecOptions, ExecutionContext, RawToolOutput } from '../../types.js';
import {
  addedLinesByFile,
  filterGitleaksReport,
  gitleaksPlugin,
  gitleaksScanTargets,
  parseGitleaksOutput,
  resolveActiveGitleaksConfig,
  toRepoRelative,
} from '../gitleaks.js';

// ─── Mock ExecutionContext helper ───────────────────────────────

function makeMockCtx(): {
  ctx: ExecutionContext;
  calls: Array<{ command: string; args: string[]; opts: ExecOptions }>;
} {
  const calls: Array<{ command: string; args: string[]; opts: ExecOptions }> = [];
  const ctx: ExecutionContext = {
    exec: vi.fn(async (command: string, args: string[], opts: ExecOptions) => {
      calls.push({ command, args, opts });
      return { stdout: '[]', stderr: '', exitCode: 0, timedOut: false };
    }),
    cacheRestore: vi.fn(async () => false),
    cacheSave: vi.fn(async () => {}),
    log: vi.fn(),
  };
  return { ctx, calls };
}

// ─── Fixture Data ───────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dirname, 'fixtures', 'gitleaks-output.json');
const FIXTURE_JSON = readFileSync(FIXTURE_PATH, 'utf8');

function makeRaw(stdout: string, exitCode = 0, timedOut = false): RawToolOutput {
  return { stdout, stderr: '', exitCode, timedOut };
}

// ─── Plugin Metadata ────────────────────────────────────────────

describe('gitleaksPlugin metadata', () => {
  it('has correct name', () => {
    expect(gitleaksPlugin.name).toBe('gitleaks');
  });

  it('has correct category', () => {
    expect(gitleaksPlugin.category).toBe('secrets');
  });

  it('has correct tier', () => {
    expect(gitleaksPlugin.tier).toBe('always-on');
  });

  it('has correct version', () => {
    expect(gitleaksPlugin.version).toBe('8.21.2');
  });

  it('has correct output format', () => {
    expect(gitleaksPlugin.outputFormat).toBe('json');
  });
});

// ─── run() — config arg ─────────────────────────────────────────

describe('gitleaksPlugin.run', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function tempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gitleaks-repo-'));
    tempDirs.push(dir);
    return dir;
  }

  it('uses the bundled config when the repo has no .gitleaks.toml', async () => {
    const repo = tempRepo();
    const { ctx, calls } = makeMockCtx();
    await gitleaksPlugin.run(ctx, repo, [], 60_000);
    const detectCall = calls.find((c) => c.args.includes('detect'));
    expect(
      detectCall?.args.some((a) => a.startsWith('--config=') && a.endsWith('gitleaks-config.toml')),
    ).toBe(true);
    expect(detectCall?.args).toContain(`--source=${repo}`);
    expect(detectCall?.args).toContain('--no-git');
    expect(detectCall?.args).toContain(`--gitleaks-ignore-path=${realpathSync(repo)}`);
    expect(detectCall?.args).not.toContain('--follow-symlinks');
  });

  it('prefers a repo .gitleaks.toml over the bundled config', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, '.gitleaks.toml'), 'title = "repo"\n');
    writeFileSync(join(repo, '.gitleaksignore'), '# fingerprints\n');
    const { ctx, calls } = makeMockCtx();
    await gitleaksPlugin.run(ctx, repo, [], 60_000);
    const detectCall = calls.find((c) => c.args.includes('detect'));
    expect(detectCall?.args).toContain(`--config=${join(repo, '.gitleaks.toml')}`);
    expect(detectCall?.args).toContain(`--gitleaks-ignore-path=${realpathSync(repo)}`);
    expect(resolveActiveGitleaksConfig(repo)).toBe(join(repo, '.gitleaks.toml'));
  });

  it('scans only changed files and drops findings outside added lines', async () => {
    const repo = tempRepo();
    writeFileSync(
      join(repo, 'src-secret.ts'),
      'const keep = "changed";\nconst old = "untouched";\n',
    );
    writeFileSync(join(repo, 'other.ts'), 'const elsewhere = "nope";\n');

    const diff = [
      'diff --git a/src-secret.ts b/src-secret.ts',
      '--- a/src-secret.ts',
      '+++ b/src-secret.ts',
      '@@ -1,2 +1,2 @@',
      '-const keep = "old";',
      '+const keep = "changed";',
      ' const old = "untouched";',
      'diff --git a/other.ts b/other.ts',
      '--- a/other.ts',
      '+++ b/other.ts',
      '@@ -1 +1 @@',
      '-const elsewhere = "before";',
      '+const elsewhere = "nope";',
    ].join('\n');

    const { ctx, calls } = makeMockCtx();
    vi.mocked(ctx.exec).mockImplementation(async (command, args) => {
      calls.push({ command, args, opts: { timeoutMs: 60_000 } });
      if (command === 'gitleaks' && args.includes('detect')) {
        const reportArg = args.find((arg) => arg.startsWith('--report-path='));
        const reportPath = reportArg?.slice('--report-path='.length) ?? '';
        writeFileSync(
          reportPath,
          JSON.stringify([
            {
              Description: 'AWS Access Key',
              StartLine: 1,
              File: join(repo, 'src-secret.ts'),
              RuleID: 'aws-access-key-id',
            },
            {
              Description: 'AWS Access Key',
              StartLine: 2,
              File: join(repo, 'src-secret.ts'),
              RuleID: 'aws-access-key-id',
            },
            {
              Description: 'Generic API Key',
              StartLine: 9,
              File: join(repo, 'other.ts'),
              RuleID: 'generic-api-key',
            },
          ]),
        );
      }
      return { stdout: '[]', stderr: '', exitCode: 0, timedOut: false };
    });

    const raw = await gitleaksPlugin.run(ctx, repo, ['src-secret.ts', 'other.ts'], 60_000, {
      diff,
    });
    const detectCall = calls.find((c) => c.args.includes('detect'));
    expect(
      detectCall?.args.some((arg) => arg.startsWith('--source=') && arg !== `--source=${repo}`),
    ).toBe(true);
    expect(detectCall?.args).toContain('--follow-symlinks');
    expect(detectCall?.args).toContain('--no-git');

    const findings = parseGitleaksOutput(raw, repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'src-secret.ts', line: 1 });
  });

  it('does not scan the repo when the diff adds no lines', async () => {
    const repo = tempRepo();
    const { ctx, calls } = makeMockCtx();
    const raw = await gitleaksPlugin.run(ctx, repo, ['missing.ts'], 60_000, {
      diff: '',
    });
    expect(calls.find((c) => c.args.includes('detect'))).toBeUndefined();
    expect(raw.stdout).toBe('[]');
  });
});

describe('gitleaks diff scope', () => {
  it('records only added lines, including a later hunk', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,3 +10,4 @@',
      ' context',
      '-old',
      '+new1',
      '+new2',
      ' context',
      '@@ -30,1 +31,1 @@',
      '-gone',
      '+fresh',
    ].join('\n');
    const lines = addedLinesByFile(diff);
    expect([...(lines.get('src/a.ts') ?? [])].sort((a, b) => a - b)).toEqual([11, 12, 31]);
  });

  it('ignores deleted files', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-secret',
    ].join('\n');
    expect(addedLinesByFile(diff).size).toBe(0);
  });

  it('filters a report down to added lines of the requested files', () => {
    const changed = new Map<string, Set<number>>([['src/config/aws.ts', new Set([15])]]);
    const filtered = filterGitleaksReport(
      FIXTURE_JSON,
      '/workspace',
      ['src/config/aws.ts'],
      changed,
    );
    const findings = parseGitleaksOutput(makeRaw(filtered), '/workspace');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('src/config/aws.ts');
    expect(findings[0]?.line).toBe(15);
  });

  it('relativizes an absolute finding path when repoDir is the working directory', () => {
    const abs = realpathSync('src/tools/plugins/gitleaks.ts');
    expect(toRepoRelative(abs, '.')).toBe('src/tools/plugins/gitleaks.ts');
  });

  it('treats an empty file list and no diff as a whole-repo scan', () => {
    expect(gitleaksScanTargets([], undefined)).toEqual({ scoped: false, targets: [] });
  });

  it('derives targets from the diff when the file list is empty', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n');
    const scope = gitleaksScanTargets([], { diff });
    expect(scope.scoped).toBe(true);
    expect(scope.targets).toEqual(['src/a.ts']);
  });
});

// ─── Parse Function ─────────────────────────────────────────────

describe('parseGitleaksOutput', () => {
  it('parses fixture JSON into 3 findings', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings).toHaveLength(3);
  });

  it('all findings have critical severity', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.severity).toBe('critical');
    }
  });

  it('all findings have secrets category', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.category).toBe('secrets');
    }
  });

  it('sets source to gitleaks', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.source).toBe('gitleaks');
    }
  });

  it('strips repoDir prefix from file paths', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    for (const finding of findings) {
      expect(finding.file).not.toContain('/workspace/');
    }
    expect(findings[0]?.file).toBe('src/config/aws.ts');
  });

  it('includes line numbers', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.line).toBe(15);
    expect(findings[1]?.line).toBe(8);
    expect(findings[2]?.line).toBe(3);
  });

  it('includes secret description and rule in message', () => {
    const findings = parseGitleaksOutput(makeRaw(FIXTURE_JSON), '/workspace');
    expect(findings[0]?.message).toContain('AWS Access Key');
    expect(findings[0]?.message).toContain('aws-access-key-id');
  });

  it('returns empty findings for empty array', () => {
    const raw = makeRaw('[]');
    expect(parseGitleaksOutput(raw, '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for malformed JSON', () => {
    expect(parseGitleaksOutput(makeRaw('not json {{{'), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings on timeout', () => {
    expect(parseGitleaksOutput(makeRaw('', 0, true), '/workspace')).toHaveLength(0);
  });

  it('returns empty findings for empty stdout', () => {
    expect(parseGitleaksOutput(makeRaw(''), '/workspace')).toHaveLength(0);
  });
});
