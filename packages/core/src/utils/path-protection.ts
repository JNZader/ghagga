/**
 * Three-tier path protection for sensitive files.
 *
 * Provides a non-overridable security layer that filters sensitive files
 * BEFORE user-configurable ignorePatterns are applied. This ensures that
 * secrets, credentials, and private keys are never sent to the LLM for review.
 *
 * Tiers:
 *   1. ZERO_ACCESS  — hardcoded, content never sent to LLM, non-overridable
 *   2. REDACT       — content replaced with redaction notice, path still visible
 *   3. User ignore  — existing configurable ignorePatterns (handled in diff.ts)
 */

import { minimatch } from 'minimatch';
import type { DiffFile } from './diff.js';

// ─── Constants ──────────────────────────────────────────────────

/** Redaction notice used to replace content of REDACT-tier files. */
export const REDACTED_CONTENT = '[REDACTED — sensitive file detected by GHAGGA path protection]';

/**
 * Tier 1 — ZERO_ACCESS patterns.
 *
 * Files matching these patterns are completely blocked from the review
 * pipeline. Their content is never sent to the LLM. These patterns are
 * hardcoded and cannot be overridden by user configuration.
 */
export const ZERO_ACCESS_PATTERNS: readonly string[] = [
  // Environment files
  '.env',
  '.env.*',

  // Private keys and certificates
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',

  // SSH keys
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  '*.pub',

  // Cloud credentials
  'credentials.json',
  'service-account*.json',
  'gcloud*.json',

  // Package manager credentials
  '.npmrc',
  '.pypirc',
  '.gem/credentials',

  // Container and cluster configs
  '.docker/config.json',
  'kubeconfig',
  'kube/config',

  // Directory-level patterns
  '**/.aws/*',
  '**/.ssh/*',
  '**/.gnupg/*',

  // Generic secrets
  '*.secret',
  '*.secrets',
  'secrets.yml',
  'secrets.yaml',
  'vault.yml',
] as const;

/**
 * Tier 2 — REDACT patterns.
 *
 * Files matching these patterns have their content replaced with a
 * redaction notice. The file path is still visible in the review so
 * reviewers know the file was changed, but the actual content is not
 * sent to the LLM.
 */
export const REDACT_PATTERNS: readonly string[] = [
  // Environment templates (may leak structure)
  '.env.example',
  '.env.sample',
  '.env.template',

  // Docker Compose (may contain credentials in environment blocks)
  'docker-compose*.yml',

  // Terraform state and variables (may contain secrets)
  '**/terraform.tfvars',
  '**/terraform.tfstate*',
] as const;

// ─── Matching Options ───────────────────────────────────────────

/** Minimatch options used for all path protection matching. */
const MATCH_OPTIONS = { dot: true, matchBase: true } as const;

// ─── Core Function ──────────────────────────────────────────────

/**
 * Result of applying path protection to a set of diff files.
 */
export interface PathProtectionResult {
  /** Files that passed all protection tiers — content untouched. */
  allowed: DiffFile[];

  /** Files matching REDACT patterns — content replaced with redaction notice. */
  redacted: DiffFile[];

  /** File paths matching ZERO_ACCESS patterns — completely blocked. */
  blocked: string[];
}

/**
 * Apply three-tier path protection to a set of diff files.
 *
 * This function is pure and deterministic. It processes files in the
 * following order:
 *   1. Check against REDACT patterns first — these are specific exceptions
 *      (e.g., `.env.example`) that would otherwise be caught by broader
 *      ZERO_ACCESS globs (e.g., `.env.*`). Content is replaced.
 *   2. Check against ZERO_ACCESS patterns — block entirely
 *   3. Everything else passes through untouched
 *
 * @param files - Array of DiffFile objects from the parsed diff
 * @returns Object with allowed, redacted, and blocked files
 */
export function applyPathProtection(files: DiffFile[]): PathProtectionResult {
  const allowed: DiffFile[] = [];
  const redacted: DiffFile[] = [];
  const blocked: string[] = [];

  for (const file of files) {
    if (matchesAnyPattern(file.path, REDACT_PATTERNS)) {
      // Tier 2: REDACT — checked first because REDACT patterns are more
      // specific exceptions (e.g. .env.example) that would otherwise be
      // caught by broader ZERO_ACCESS globs (e.g. .env.*)
      redacted.push({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        content: REDACTED_CONTENT,
      });
    } else if (matchesAnyPattern(file.path, ZERO_ACCESS_PATTERNS)) {
      // Tier 1: ZERO_ACCESS — broad security patterns
      blocked.push(file.path);
    } else {
      allowed.push(file);
    }
  }

  return { allowed, redacted, blocked };
}

// ─── Internal Helpers ───────────────────────────────────────────

/**
 * Check if a file path matches any of the given glob patterns.
 *
 * Uses minimatch with `{ dot: true, matchBase: true }` to ensure:
 *   - Dotfiles are matched (e.g., `.env`)
 *   - Basename matching works (e.g., `.env` matches `src/.env`)
 */
function matchesAnyPattern(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(filePath, pattern, MATCH_OPTIONS));
}
