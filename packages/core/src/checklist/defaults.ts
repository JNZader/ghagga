/**
 * Default checklist — SOLID principles, error handling,
 * boundary conditions, and security review dimensions.
 *
 * Inspired by https://github.com/sanyuan0704/sanyuan-skills
 */

import type { ChecklistConfig, ChecklistDimension } from './types.js';

// ─── SOLID Principles ──────────────────────────────────────────

const SOLID_DIMENSION: ChecklistDimension = {
  id: 'solid',
  name: 'SOLID Principles',
  enabled: true,
  checks: [
    {
      id: 'single-responsibility',
      description: 'Does each class/function have exactly one reason to change?',
      weight: 8,
      enabled: true,
    },
    {
      id: 'open-closed',
      description: 'Is the code open for extension but closed for modification?',
      weight: 6,
      enabled: true,
    },
    {
      id: 'liskov-substitution',
      description: 'Can subtypes be substituted for their base types without breaking behavior?',
      weight: 7,
      enabled: true,
    },
    {
      id: 'interface-segregation',
      description: 'Are interfaces small and focused rather than fat and monolithic?',
      weight: 6,
      enabled: true,
    },
    {
      id: 'dependency-inversion',
      description: 'Do high-level modules depend on abstractions rather than concrete implementations?',
      weight: 7,
      enabled: true,
    },
  ],
};

// ─── Error Handling ────────────────────────────────────────────

const ERROR_HANDLING_DIMENSION: ChecklistDimension = {
  id: 'error-handling',
  name: 'Error Handling',
  enabled: true,
  checks: [
    {
      id: 'error-propagation',
      description: 'Are errors propagated with sufficient context for debugging?',
      weight: 8,
      enabled: true,
    },
    {
      id: 'error-recovery',
      description: 'Does the code recover gracefully from expected failure modes?',
      weight: 7,
      enabled: true,
    },
    {
      id: 'error-types',
      description: 'Are specific error types used instead of generic Error/Exception?',
      weight: 5,
      enabled: true,
    },
    {
      id: 'silent-failures',
      description: 'Are there empty catch blocks or swallowed errors?',
      weight: 9,
      enabled: true,
    },
    {
      id: 'async-error-handling',
      description: 'Are async operations wrapped in try/catch or .catch() handlers?',
      weight: 8,
      enabled: true,
    },
  ],
};

// ─── Boundary Conditions ───────────────────────────────────────

const BOUNDARY_CONDITIONS_DIMENSION: ChecklistDimension = {
  id: 'boundary-conditions',
  name: 'Boundary Conditions',
  enabled: true,
  checks: [
    {
      id: 'null-undefined',
      description: 'Are null/undefined values handled at function entry points?',
      weight: 8,
      enabled: true,
    },
    {
      id: 'empty-collections',
      description: 'Does the code handle empty arrays, maps, or strings correctly?',
      weight: 7,
      enabled: true,
    },
    {
      id: 'numeric-limits',
      description: 'Are integer overflow, division by zero, and NaN cases handled?',
      weight: 7,
      enabled: true,
    },
    {
      id: 'string-encoding',
      description: 'Are unicode, multi-byte, and special characters handled correctly?',
      weight: 5,
      enabled: true,
    },
    {
      id: 'concurrency-bounds',
      description: 'Are race conditions and concurrent access patterns protected?',
      weight: 8,
      enabled: true,
    },
  ],
};

// ─── Security ──────────────────────────────────────────────────

const SECURITY_DIMENSION: ChecklistDimension = {
  id: 'security',
  name: 'Security',
  enabled: true,
  checks: [
    {
      id: 'input-validation',
      description: 'Is all external input validated and sanitized before use?',
      weight: 9,
      enabled: true,
    },
    {
      id: 'auth-checks',
      description: 'Are authentication and authorization checks present where needed?',
      weight: 9,
      enabled: true,
    },
    {
      id: 'sensitive-data',
      description: 'Is sensitive data (tokens, passwords, PII) protected from exposure?',
      weight: 10,
      enabled: true,
    },
    {
      id: 'injection-prevention',
      description: 'Are SQL, XSS, command injection, and path traversal attacks prevented?',
      weight: 10,
      enabled: true,
    },
    {
      id: 'dependency-safety',
      description: 'Are third-party dependencies up to date and free of known vulnerabilities?',
      weight: 6,
      enabled: true,
    },
  ],
};

// ─── Default Checklist ─────────────────────────────────────────

/** Default checklist with all 4 dimensions enabled. */
export const DEFAULT_CHECKLIST: ChecklistConfig = {
  enabled: true,
  dimensions: [
    SOLID_DIMENSION,
    ERROR_HANDLING_DIMENSION,
    BOUNDARY_CONDITIONS_DIMENSION,
    SECURITY_DIMENSION,
  ],
};

/** All default dimension definitions (for individual access). */
export const DEFAULT_DIMENSIONS: readonly ChecklistDimension[] = DEFAULT_CHECKLIST.dimensions;
