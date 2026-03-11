/**
 * CI Job Discovery API route:
 *   GET /api/repositories/:repoId/discover-ci
 *
 * Scans a repository's GitHub Actions workflows, package.json scripts,
 * and Makefile targets to discover CI jobs that can be delegated.
 */

import type { Database } from 'ghagga-db';
import { getInstallationById, getRepositoryById } from 'ghagga-db';
import { Hono } from 'hono';
import { getInstallationToken } from '../../github/client.js';
import type { AuthUser } from '../../middleware/auth.js';
import { generateErrorId, logger } from './utils.js';

// ─── Types ──────────────────────────────────────────────────────

type CiSource = 'github-actions' | 'package-json' | 'makefile';
type Runtime = 'node' | 'python' | 'go' | 'unknown';
type SuggestedProfile = 'node-lint' | 'node-unit' | 'python-lint' | 'python-pytest' | 'go-test';

interface DiscoveredCiJob {
  source: CiSource;
  sourceFile: string;
  jobKey: string;
  displayName: string;
  command: string | null;
  suggestedProfile: SuggestedProfile;
  runtime: Runtime;
}

// ─── Runtime Detection ──────────────────────────────────────────

async function detectRuntime(fullName: string, token: string): Promise<Runtime> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Check multiple marker files in parallel
  const checks = await Promise.allSettled([
    fetch(`https://api.github.com/repos/${fullName}/contents/package.json`, {
      headers,
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    }),
    fetch(`https://api.github.com/repos/${fullName}/contents/go.mod`, {
      headers,
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    }),
    fetch(`https://api.github.com/repos/${fullName}/contents/pyproject.toml`, {
      headers,
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    }),
    fetch(`https://api.github.com/repos/${fullName}/contents/requirements.txt`, {
      headers,
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    }),
  ]);

  const [packageJson, goMod, pyprojectToml, requirementsTxt] = checks.map(
    (r) => r.status === 'fulfilled' && r.value.ok,
  );

  if (goMod) return 'go';
  if (pyprojectToml || requirementsTxt) return 'python';
  if (packageJson) return 'node';
  return 'unknown';
}

// ─── Profile Matching ───────────────────────────────────────────

const LINT_KEYWORDS = ['lint', 'eslint', 'biome', 'prettier', 'format', 'style', 'ruff', 'flake8'];
const TEST_KEYWORDS = [
  'test',
  'spec',
  'jest',
  'vitest',
  'pytest',
  'mocha',
  'cypress',
  'playwright',
];

function suggestProfile(jobKey: string, runtime: Runtime): SuggestedProfile {
  const key = jobKey.toLowerCase();

  const isLint = LINT_KEYWORDS.some((kw) => key.includes(kw));
  const isTest = TEST_KEYWORDS.some((kw) => key.includes(kw));

  if (runtime === 'python') {
    return isTest ? 'python-pytest' : 'python-lint';
  }
  if (runtime === 'go') {
    return 'go-test';
  }
  // Default to node
  if (isTest) return 'node-unit';
  if (isLint) return 'node-lint';
  // Fall back based on name heuristic
  return 'node-lint';
}

// ─── GitHub Actions Parsing ─────────────────────────────────────

/**
 * Extract job names from a GitHub Actions workflow YAML string using regex.
 * Looks for the `jobs:` section and extracts top-level job keys.
 */
function parseWorkflowJobs(
  yamlContent: string,
  fileName: string,
  runtime: Runtime,
): DiscoveredCiJob[] {
  const discovered: DiscoveredCiJob[] = [];
  const sourceFile = `.github/workflows/${fileName}`;

  // Find the `jobs:` section
  const jobsSectionMatch = yamlContent.match(/^jobs:\s*$/m);
  if (!jobsSectionMatch || jobsSectionMatch.index === undefined) return discovered;

  // Get everything after `jobs:`
  const afterJobs = yamlContent.slice(jobsSectionMatch.index + jobsSectionMatch[0].length);

  // Extract job names: lines with exactly 2 spaces of indentation followed by a word
  // Stop when we hit a line at indentation 0 that isn't a comment or blank
  const lines = afterJobs.split('\n');
  let currentJobKey: string | null = null;
  let currentRunCommands: string[] = [];

  for (const line of lines) {
    // Top-level key at indentation 0 (not a comment) — we've left the jobs section
    if (/^\S/.test(line) && !line.startsWith('#')) break;

    // Job name: exactly 2 spaces + word characters/hyphens + colon
    const jobMatch = line.match(/^ {2}([\w][\w-]*):\s*$/);
    if (jobMatch) {
      // Save previous job if any
      if (currentJobKey) {
        const profile = suggestProfile(currentJobKey, runtime);
        discovered.push({
          source: 'github-actions',
          sourceFile,
          jobKey: currentJobKey,
          displayName: `${currentJobKey} (from ${fileName})`,
          command: currentRunCommands.length > 0 ? currentRunCommands[0] : null,
          suggestedProfile: profile,
          runtime,
        });
      }
      currentJobKey = jobMatch[1];
      currentRunCommands = [];
      continue;
    }

    // Collect `run:` commands within the current job's steps
    if (currentJobKey) {
      const runMatch = line.match(/^\s+run:\s*(.+)$/);
      if (runMatch) {
        currentRunCommands.push(runMatch[1].trim());
      }
    }
  }

  // Don't forget the last job
  if (currentJobKey) {
    const profile = suggestProfile(currentJobKey, runtime);
    discovered.push({
      source: 'github-actions',
      sourceFile,
      jobKey: currentJobKey,
      displayName: `${currentJobKey} (from ${fileName})`,
      command: currentRunCommands.length > 0 ? currentRunCommands[0] : null,
      suggestedProfile: profile,
      runtime,
    });
  }

  return discovered;
}

// ─── Package.json Parsing ───────────────────────────────────────

function parsePackageJsonScripts(content: string): DiscoveredCiJob[] {
  const discovered: DiscoveredCiJob[] = [];

  try {
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    if (!pkg.scripts) return discovered;

    for (const [key, _command] of Object.entries(pkg.scripts)) {
      // Skip lifecycle hooks and internal scripts
      if (key.startsWith('pre') || key.startsWith('post') || key === 'prepare') continue;

      const profile = suggestProfile(key, 'node');
      discovered.push({
        source: 'package-json',
        sourceFile: 'package.json',
        jobKey: key,
        displayName: `${key} (npm script)`,
        command: `npm run ${key}`,
        suggestedProfile: profile,
        runtime: 'node',
      });
    }
  } catch {
    // Invalid JSON — skip
  }

  return discovered;
}

// ─── Makefile Parsing ───────────────────────────────────────────

function parseMakefileTargets(content: string, runtime: Runtime): DiscoveredCiJob[] {
  const discovered: DiscoveredCiJob[] = [];

  // Match Makefile targets: lines starting with a word followed by a colon
  // Exclude internal targets (starting with .) and variable assignments
  const targetRegex = /^([\w][\w-]*):\s*/gm;

  for (let match = targetRegex.exec(content); match !== null; match = targetRegex.exec(content)) {
    const target = match[1];
    // Skip common non-CI targets
    if (['all', 'clean', 'install', 'help', 'default'].includes(target)) continue;

    const profile = suggestProfile(target, runtime);
    discovered.push({
      source: 'makefile',
      sourceFile: 'Makefile',
      jobKey: target,
      displayName: `${target} (make target)`,
      command: `make ${target}`,
      suggestedProfile: profile,
      runtime,
    });
  }

  return discovered;
}

// ─── GitHub API Helpers ─────────────────────────────────────────

const GITHUB_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

async function fetchFileContent(
  fullName: string,
  path: string,
  token: string,
): Promise<string | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/contents/${path}`, {
      headers: GITHUB_HEADERS(token),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { content?: string; encoding?: string };
    if (data.content && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Router ─────────────────────────────────────────────────────

export function createDiscoverCiRouter(db: Database) {
  const router = new Hono();

  router.get('/api/repositories/:repoId/discover-ci', async (c) => {
    const user = c.get('user') as AuthUser;
    const repoId = Number.parseInt(c.req.param('repoId'), 10);

    if (Number.isNaN(repoId)) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid repository ID' }, 400);
    }

    try {
      // Verify user has access to this repo's installation
      const repo = await getRepositoryById(db, repoId);
      if (!repo || !user.installationIds.includes(repo.installationId)) {
        return c.json({ error: 'NOT_FOUND', message: 'Repository not found' }, 404);
      }

      const appId = process.env.GITHUB_APP_ID;
      const privateKey = process.env.GITHUB_PRIVATE_KEY;
      if (!appId || !privateKey) {
        return c.json(
          { error: 'CONFIG_ERROR', message: 'GitHub App credentials not configured' },
          500,
        );
      }

      // Resolve internal DB installation ID to GitHub's installation ID
      const installation = await getInstallationById(db, repo.installationId);
      if (!installation) {
        return c.json({ error: 'CONFIG_ERROR', message: 'Installation record not found' }, 500);
      }

      const token = await getInstallationToken(
        installation.githubInstallationId,
        appId,
        privateKey,
      );
      const discovered: DiscoveredCiJob[] = [];

      // Detect runtime first (parallel HEAD checks)
      const runtime = await detectRuntime(repo.fullName, token);

      // Scan all sources in parallel
      const [workflowJobs, packageJsonJobs, makefileJobs] = await Promise.all([
        // 1. GitHub Actions workflows
        (async (): Promise<DiscoveredCiJob[]> => {
          try {
            const response = await fetch(
              `https://api.github.com/repos/${repo.fullName}/contents/.github/workflows`,
              {
                headers: GITHUB_HEADERS(token),
                signal: AbortSignal.timeout(10_000),
              },
            );

            if (!response.ok) return [];

            const files = (await response.json()) as Array<{
              name: string;
              path: string;
            }>;

            const yamlFiles = files.filter(
              (f) => f.name.endsWith('.yml') || f.name.endsWith('.yaml'),
            );

            const jobs: DiscoveredCiJob[] = [];
            // Fetch workflow files in parallel (max 5 to avoid rate limits)
            const batchSize = 5;
            for (let i = 0; i < yamlFiles.length; i += batchSize) {
              const batch = yamlFiles.slice(i, i + batchSize);
              const contents = await Promise.all(
                batch.map((f) => fetchFileContent(repo.fullName, f.path, token)),
              );
              for (let j = 0; j < batch.length; j++) {
                const content = contents[j];
                if (content) {
                  jobs.push(...parseWorkflowJobs(content, batch[j].name, runtime));
                }
              }
            }
            return jobs;
          } catch {
            return [];
          }
        })(),

        // 2. package.json scripts
        (async (): Promise<DiscoveredCiJob[]> => {
          const content = await fetchFileContent(repo.fullName, 'package.json', token);
          if (!content) return [];
          return parsePackageJsonScripts(content);
        })(),

        // 3. Makefile targets
        (async (): Promise<DiscoveredCiJob[]> => {
          const content = await fetchFileContent(repo.fullName, 'Makefile', token);
          if (!content) return [];
          return parseMakefileTargets(content, runtime);
        })(),
      ]);

      discovered.push(...workflowJobs, ...packageJsonJobs, ...makefileJobs);

      logger.info(
        { repoId, repoFullName: repo.fullName, runtime, jobCount: discovered.length },
        'CI job discovery completed',
      );

      return c.json({ data: discovered });
    } catch (err) {
      const errorId = generateErrorId();
      logger.error({ err, errorId, repoId, user: user.githubLogin }, 'Failed to discover CI jobs');
      return c.json(
        { error: 'DISCOVERY_FAILED', message: 'Failed to discover CI jobs', errorId },
        500,
      );
    }
  });

  return router;
}
