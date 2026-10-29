/**
 * Gitleaks plugin — secret detection (always-on).
 *
 * On a pull-request review, scans only files the diff changes and reports
 * secrets on added lines. Whole-repo commands (health, audit) still scan the
 * tree. A repository `.gitleaks.toml` wins over the bundled config, and a
 * repository `.gitleaksignore` is always passed through.
 *
 * Uses ExecutionContext for DI instead of direct child_process.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnifiedDiff } from '../../diff/parse.js';
import type { ReviewFinding } from '../../types.js';
import type { ExecutionContext, RawToolOutput, ToolDefinition, ToolScanScope } from '../types.js';

const GITLEAKS_VERSION = '8.21.2';
const GITLEAKS_BIN = '/usr/local/bin/gitleaks';

/** Scratch directory for the scan report and the changed-file tree. */
function reviewTempDir(): string {
  const fromEnv = process.env.TMPDIR || process.env.TMP || process.env.TEMP;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return '/tmp';
}

/**
 * Resolve the bundled gitleaks config (extends defaults + test-file allowlist).
 *
 * Works in BOTH dev (src/tools/plugins/gitleaks.ts -> src/tools/gitleaks-config.toml)
 * and the published build (dist/tools/plugins/gitleaks.js -> dist/tools/gitleaks-config.toml),
 * provided the build copies the .toml into dist/tools/ (see package.json `build` script).
 *
 * Returns undefined if missing so the plugin degrades gracefully to default rules.
 */
export function resolveGitleaksConfigPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = join(here, '..', 'gitleaks-config.toml');
  return existsSync(configPath) ? configPath : undefined;
}

/**
 * Config gitleaks should load for this scan.
 *
 * A repository `.gitleaks.toml` wins (gitleaks' own precedence when `--config`
 * is set). Otherwise the bundled allowlist is used when the build shipped it.
 */
export function resolveActiveGitleaksConfig(repoDir: string): string | undefined {
  const repoConfig = join(repoDir, '.gitleaks.toml');
  if (existsSync(repoConfig)) return repoConfig;
  return resolveGitleaksConfigPath();
}

/** Gitleaks JSON finding structure */
interface GitleaksFinding {
  Description: string;
  StartLine: number;
  File: string;
  RuleID: string;
}

/**
 * Added (new-side) line numbers per repo-relative path.
 *
 * Only `+` lines count. Context lines advance the cursor; deletions do not.
 * Deleted files and hunks with no additions are omitted.
 */
export function addedLinesByFile(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of parseUnifiedDiff(diff).files) {
    if (file.isDeleted || !file.path || file.path === '/dev/null') continue;
    const lines = map.get(file.path) ?? new Set<number>();
    for (const hunk of file.hunks) {
      let newLine = hunk.newStart;
      for (const hunkLine of hunk.lines) {
        if (hunkLine.prefix === '+') {
          if (newLine > 0) lines.add(newLine);
          newLine++;
        } else if (hunkLine.prefix === ' ') {
          newLine++;
        }
      }
    }
    if (lines.size > 0) map.set(file.path, lines);
  }
  return map;
}

/** Repo-relative path for a gitleaks `File` value (absolute or already relative). */
export function toRepoRelative(file: string, repoDir: string): string {
  const normalized = file.replace(/\\/g, '/');
  const roots = new Set<string>();
  const add = (root: string) => {
    const cleaned = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (cleaned && cleaned !== '.') roots.add(cleaned);
  };
  add(repoDir);
  try {
    add(realpathSync(repoDir));
  } catch {
    // repoDir may not exist yet; the literal prefix is enough.
  }
  for (const root of roots) {
    if (normalized === root) return '';
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.\//, '');
}

/**
 * Keep gitleaks findings that sit on the review diff.
 *
 * `changedLines` absent → file-level scope only (every finding in `files`).
 * `changedLines` present → the finding's start line must be an added line.
 */
export function filterGitleaksReport(
  rawJson: string,
  repoDir: string,
  files: readonly string[],
  changedLines: ReadonlyMap<string, ReadonlySet<number>> | undefined,
): string {
  let findings: GitleaksFinding[];
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return '[]';
    findings = parsed as GitleaksFinding[];
  } catch {
    return '[]';
  }

  const fileSet = new Set(files.map((file) => file.replace(/\\/g, '/').replace(/^\.\//, '')));
  const filtered = findings.flatMap((finding) => {
    const rel = toRepoRelative(finding.File ?? '', repoDir);
    if (fileSet.size > 0 && !fileSet.has(rel)) return [];
    if (changedLines) {
      const lines = changedLines.get(rel);
      if (!lines?.has(finding.StartLine)) return [];
    }
    // Repo-relative path so parse() works when repoDir is `.` and gitleaks
    // reported the absolute symlink target.
    return [{ ...finding, File: rel }];
  });
  return JSON.stringify(filtered);
}

/**
 * Files the scan should open.
 *
 * A diff is the authority for line scope: only paths that gained lines.
 * Without a diff, the changed-file list is the scope. Both empty means the
 * caller asked for a whole-repo scan (health / audit).
 */
export function gitleaksScanTargets(
  files: readonly string[],
  scope: ToolScanScope | undefined,
): { scoped: boolean; targets: string[]; changedLines?: Map<string, Set<number>> } {
  if (scope?.diff === undefined && files.length === 0) {
    return { scoped: false, targets: [] };
  }

  const changedLines = scope?.diff !== undefined ? addedLinesByFile(scope.diff) : undefined;
  const requested = files
    .map((file) => file.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);

  if (!changedLines) {
    return { scoped: true, targets: requested };
  }

  const targets = (requested.length > 0 ? requested : [...changedLines.keys()]).filter((file) =>
    changedLines.has(file),
  );
  return { scoped: true, targets, changedLines };
}

/** Absolute path of a regular file inside repoDir, or undefined if it is not safe to scan. */
function safeRepoFile(repoDir: string, rel: string): string | undefined {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return undefined;
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.split('/').includes('..')) return undefined;
  const abs = join(repoDir, normalized);
  if (!existsSync(abs)) return undefined;
  try {
    if (!statSync(abs).isFile()) return undefined;
    const repoReal = realpathSync(repoDir);
    const fileReal = realpathSync(abs);
    const root = repoReal.endsWith(sep) ? repoReal : repoReal + sep;
    if (fileReal !== repoReal && !fileReal.startsWith(root)) return undefined;
    return fileReal;
  } catch {
    return undefined;
  }
}

/**
 * Parse Gitleaks JSON output into ReviewFinding[].
 * Gitleaks writes results to a report file; we read from stdout or the report.
 * Exported for direct testing with fixture data.
 */
export function parseGitleaksOutput(raw: RawToolOutput, repoDir: string): ReviewFinding[] {
  if (raw.timedOut) return [];

  try {
    const findings: GitleaksFinding[] = JSON.parse(raw.stdout);

    return findings.map((f) => ({
      severity: 'critical' as const,
      category: 'secrets',
      file: f.File.replace(`${repoDir}/`, ''),
      line: f.StartLine,
      message: `${f.Description} (rule: ${f.RuleID})`,
      source: 'gitleaks' as const,
    }));
  } catch {
    return [];
  }
}

export const gitleaksPlugin: ToolDefinition = {
  name: 'gitleaks',
  displayName: 'Gitleaks',
  category: 'secrets',
  tier: 'always-on',
  version: GITLEAKS_VERSION,
  outputFormat: 'json',
  cachePaths: [GITLEAKS_BIN],

  async install(ctx: ExecutionContext): Promise<void> {
    const cached = await ctx.cacheRestore('gitleaks', [GITLEAKS_BIN]);
    if (cached) {
      try {
        await ctx.exec('gitleaks', ['version'], { timeoutMs: 10_000 });
        return;
      } catch {
        ctx.log('warn', 'Gitleaks cache restored but binary not functional, reinstalling');
      }
    }

    // Download Gitleaks binary from GitHub Releases
    await ctx.exec(
      'bash',
      [
        '-c',
        `curl -sL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" | tar xz -C /usr/local/bin gitleaks`,
      ],
      { timeoutMs: 120_000 },
    );
    await ctx.exec('gitleaks', ['version'], { timeoutMs: 10_000 });
    await ctx.cacheSave('gitleaks', [GITLEAKS_BIN]);
  },

  async run(
    ctx: ExecutionContext,
    repoDir: string,
    files: string[],
    timeout: number,
    scope?: ToolScanScope,
  ): Promise<RawToolOutput> {
    const { scoped, targets, changedLines } = gitleaksScanTargets(files, scope);
    let repoRoot = repoDir;
    try {
      repoRoot = realpathSync(repoDir);
    } catch {
      repoRoot = repoDir;
    }
    const reportPath = join(reviewTempDir(), `ghagga-gitleaks-${process.pid}-${Date.now()}.json`);
    let tempTree: string | undefined;

    try {
      let source = repoDir;
      if (scoped) {
        tempTree = mkdtempSync(join(reviewTempDir(), 'ghagga-gitleaks-'));
        let linked = 0;
        for (const rel of targets) {
          const real = safeRepoFile(repoDir, rel);
          if (!real) continue;
          const dest = join(tempTree, rel);
          mkdirSync(dirname(dest), { recursive: true });
          symlinkSync(real, dest);
          linked++;
        }
        if (linked === 0) {
          ctx.log('info', 'gitleaks: no changed files to scan');
          return { stdout: '[]', stderr: '', exitCode: 0, timedOut: false };
        }
        source = tempTree;
        ctx.log('info', `gitleaks: scanning ${linked} changed file(s)`);
      }

      const detectArgs = [
        'detect',
        `--source=${source}`,
        '--report-format=json',
        `--report-path=${reportPath}`,
        '--no-git',
        '--exit-code=0',
        `--gitleaks-ignore-path=${repoRoot}`,
      ];
      if (scoped) detectArgs.push('--follow-symlinks');

      // Repo config wins so a checkout's allowlist and .gitleaksignore apply
      // even when the Action bundle cannot see the packaged toml. Otherwise
      // use the bundled test-fixture allowlist.
      const configPath = resolveActiveGitleaksConfig(repoDir);
      if (configPath) {
        detectArgs.push(`--config=${configPath}`);
      } else {
        ctx.log('warn', 'gitleaks: no .gitleaks.toml or bundled config found, using default rules');
      }

      const detectResult = await ctx.exec('gitleaks', detectArgs, { timeoutMs: timeout });
      if (detectResult.timedOut) return detectResult;

      let raw = '[]';
      try {
        raw = readFileSync(reportPath, 'utf8');
      } catch {
        raw = '[]';
      }
      if (scoped) raw = filterGitleaksReport(raw, repoDir, targets, changedLines);

      return {
        stdout: raw,
        stderr: detectResult.stderr,
        exitCode: detectResult.exitCode,
        timedOut: false,
      };
    } finally {
      if (tempTree) rmSync(tempTree, { recursive: true, force: true });
      rmSync(reportPath, { force: true });
    }
  },

  parse: parseGitleaksOutput,
};
