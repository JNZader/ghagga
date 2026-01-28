/**
 * Integration tests for Webhook Handler
 *
 * Tests signature verification, event routing, and file filtering.
 *
 * Run with: deno test --allow-read --allow-env
 */

import {
  assertEquals,
  assertExists,
  assert,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { verifyWebhookSignature, shouldTriggerReview } from '../index.ts';
import {
  shouldReviewFile,
  filterFilesForReview,
  type RepoConfig,
} from '../handlers/pull_request.ts';
import type {
  PullRequestEventPayload,
  GitHubDiffFile,
} from '../../_shared/types/index.ts';

// ============================================
// Signature Verification Tests
// ============================================

Deno.test('verifyWebhookSignature - returns false for null signature', async () => {
  const result = await verifyWebhookSignature('payload', null, 'secret');
  assertEquals(result, false);
});

Deno.test('verifyWebhookSignature - returns false for empty signature', async () => {
  const result = await verifyWebhookSignature('payload', '', 'secret');
  assertEquals(result, false);
});

Deno.test('verifyWebhookSignature - returns false for invalid format', async () => {
  const result = await verifyWebhookSignature('payload', 'invalid', 'secret');
  assertEquals(result, false);
});

Deno.test('verifyWebhookSignature - returns false for wrong algorithm', async () => {
  const result = await verifyWebhookSignature('payload', 'sha1=abc123', 'secret');
  assertEquals(result, false);
});

Deno.test('verifyWebhookSignature - validates correct signature', async () => {
  const payload = '{"test":"data"}';
  const secret = 'webhook-secret';

  // Generate expected signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );
  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const result = await verifyWebhookSignature(
    payload,
    `sha256=${expectedSignature}`,
    secret
  );
  assertEquals(result, true);
});

Deno.test('verifyWebhookSignature - rejects incorrect signature', async () => {
  const result = await verifyWebhookSignature(
    'payload',
    'sha256=0000000000000000000000000000000000000000000000000000000000000000',
    'secret'
  );
  assertEquals(result, false);
});

Deno.test('verifyWebhookSignature - rejects tampered payload', async () => {
  const originalPayload = '{"test":"data"}';
  const tamperedPayload = '{"test":"modified"}';
  const secret = 'webhook-secret';

  // Generate signature for original payload
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(originalPayload)
  );
  const signature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Try to verify tampered payload with original signature
  const result = await verifyWebhookSignature(
    tamperedPayload,
    `sha256=${signature}`,
    secret
  );
  assertEquals(result, false);
});

// ============================================
// PR Event Filtering Tests
// ============================================

function createMockPRPayload(
  action: string,
  options: { draft?: boolean; state?: 'open' | 'closed' } = {}
): PullRequestEventPayload {
  return {
    action,
    number: 1,
    pull_request: {
      id: 1,
      node_id: 'PR_1',
      number: 1,
      state: options.state || 'open',
      locked: false,
      title: 'Test PR',
      body: 'Test body',
      user: {
        id: 1,
        login: 'testuser',
        node_id: 'U_1',
        avatar_url: 'https://example.com/avatar',
        type: 'User',
      },
      html_url: 'https://github.com/test/repo/pull/1',
      diff_url: 'https://github.com/test/repo/pull/1.diff',
      patch_url: 'https://github.com/test/repo/pull/1.patch',
      head: {
        label: 'test:feature',
        ref: 'feature',
        sha: 'abc123',
        user: {
          id: 1,
          login: 'testuser',
          node_id: 'U_1',
          avatar_url: 'https://example.com/avatar',
          type: 'User',
        },
        repo: {} as unknown as ReturnType<typeof createMockPRPayload>['pull_request']['head']['repo'],
      },
      base: {
        label: 'test:main',
        ref: 'main',
        sha: 'def456',
        user: {
          id: 1,
          login: 'testuser',
          node_id: 'U_1',
          avatar_url: 'https://example.com/avatar',
          type: 'User',
        },
        repo: {} as unknown as ReturnType<typeof createMockPRPayload>['pull_request']['base']['repo'],
      },
      draft: options.draft || false,
      merged: false,
      assignees: [],
      requested_reviewers: [],
      labels: [],
      commits: 1,
      additions: 10,
      deletions: 5,
      changed_files: 2,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    },
    sender: {
      id: 1,
      login: 'testuser',
      node_id: 'U_1',
      avatar_url: 'https://example.com/avatar',
      type: 'User',
    },
  } as PullRequestEventPayload;
}

Deno.test('shouldTriggerReview - returns true for opened action', () => {
  const payload = createMockPRPayload('opened');
  assertEquals(shouldTriggerReview(payload), true);
});

Deno.test('shouldTriggerReview - returns true for synchronize action', () => {
  const payload = createMockPRPayload('synchronize');
  assertEquals(shouldTriggerReview(payload), true);
});

Deno.test('shouldTriggerReview - returns true for reopened action', () => {
  const payload = createMockPRPayload('reopened');
  assertEquals(shouldTriggerReview(payload), true);
});

Deno.test('shouldTriggerReview - returns false for closed action', () => {
  const payload = createMockPRPayload('closed');
  assertEquals(shouldTriggerReview(payload), false);
});

Deno.test('shouldTriggerReview - returns false for labeled action', () => {
  const payload = createMockPRPayload('labeled');
  assertEquals(shouldTriggerReview(payload), false);
});

Deno.test('shouldTriggerReview - returns false for draft PR', () => {
  const payload = createMockPRPayload('opened', { draft: true });
  assertEquals(shouldTriggerReview(payload), false);
});

Deno.test('shouldTriggerReview - returns false for closed state', () => {
  const payload = createMockPRPayload('opened', { state: 'closed' });
  assertEquals(shouldTriggerReview(payload), false);
});

// ============================================
// File Filtering Tests
// ============================================

const DEFAULT_CONFIG: RepoConfig = {
  enabled: true,
  mode: 'workflow',
  ignorePatterns: [
    '*.lock',
    '*.min.js',
    'package-lock.json',
    'node_modules/**',
    'dist/**',
  ],
  customRules: '',
  maxFilesPerReview: 50,
};

Deno.test('shouldReviewFile - returns true for normal source files', () => {
  assertEquals(shouldReviewFile('src/index.ts', DEFAULT_CONFIG.ignorePatterns), true);
  assertEquals(shouldReviewFile('lib/utils.js', DEFAULT_CONFIG.ignorePatterns), true);
  assertEquals(shouldReviewFile('components/Button.tsx', DEFAULT_CONFIG.ignorePatterns), true);
});

Deno.test('shouldReviewFile - returns false for lock files', () => {
  assertEquals(shouldReviewFile('yarn.lock', DEFAULT_CONFIG.ignorePatterns), false);
  assertEquals(shouldReviewFile('package-lock.json', DEFAULT_CONFIG.ignorePatterns), false);
});

Deno.test('shouldReviewFile - returns false for minified files', () => {
  assertEquals(shouldReviewFile('bundle.min.js', DEFAULT_CONFIG.ignorePatterns), false);
});

Deno.test('shouldReviewFile - returns false for node_modules', () => {
  assertEquals(
    shouldReviewFile('node_modules/lodash/index.js', DEFAULT_CONFIG.ignorePatterns),
    false
  );
});

Deno.test('shouldReviewFile - returns false for dist folder', () => {
  assertEquals(shouldReviewFile('dist/bundle.js', DEFAULT_CONFIG.ignorePatterns), false);
  assertEquals(shouldReviewFile('dist/index.html', DEFAULT_CONFIG.ignorePatterns), false);
});

Deno.test('shouldReviewFile - handles glob patterns with **', () => {
  const patterns = ['**/*.test.ts', 'src/**/*.spec.js'];

  assertEquals(shouldReviewFile('foo/bar/baz.test.ts', patterns), false);
  assertEquals(shouldReviewFile('src/components/Button.spec.js', patterns), false);
  assertEquals(shouldReviewFile('src/index.ts', patterns), true);
});

function createMockDiffFile(
  filename: string,
  status: GitHubDiffFile['status'] = 'modified'
): GitHubDiffFile {
  return {
    sha: 'abc123',
    filename,
    status,
    additions: 10,
    deletions: 5,
    changes: 15,
    blob_url: `https://github.com/test/repo/blob/abc123/${filename}`,
    raw_url: `https://github.com/test/repo/raw/abc123/${filename}`,
    contents_url: `https://api.github.com/repos/test/repo/contents/${filename}`,
    patch: '@@ -1,3 +1,4 @@\n+new line\n existing',
  };
}

Deno.test('filterFilesForReview - filters out ignored patterns', () => {
  const files: GitHubDiffFile[] = [
    createMockDiffFile('src/index.ts'),
    createMockDiffFile('package-lock.json'),
    createMockDiffFile('node_modules/lodash/index.js'),
  ];

  const { toReview, skipped } = filterFilesForReview(files, DEFAULT_CONFIG);

  assertEquals(toReview.length, 1);
  assertEquals(toReview[0].filename, 'src/index.ts');
  assertEquals(skipped.length, 2);
});

Deno.test('filterFilesForReview - skips removed files', () => {
  const files: GitHubDiffFile[] = [
    createMockDiffFile('src/index.ts', 'modified'),
    createMockDiffFile('src/deprecated.ts', 'removed'),
  ];

  const { toReview, skipped } = filterFilesForReview(files, DEFAULT_CONFIG);

  assertEquals(toReview.length, 1);
  assertEquals(toReview[0].filename, 'src/index.ts');
  assertEquals(skipped.length, 1);
  assertEquals(skipped[0].filename, 'src/deprecated.ts');
});

Deno.test('filterFilesForReview - respects maxFilesPerReview', () => {
  const files: GitHubDiffFile[] = Array.from({ length: 10 }, (_, i) =>
    createMockDiffFile(`src/file${i}.ts`)
  );

  const config: RepoConfig = { ...DEFAULT_CONFIG, maxFilesPerReview: 5 };
  const { toReview, skipped } = filterFilesForReview(files, config);

  assertEquals(toReview.length, 5);
  assertEquals(skipped.length, 5);
});

Deno.test('filterFilesForReview - handles empty file list', () => {
  const { toReview, skipped } = filterFilesForReview([], DEFAULT_CONFIG);

  assertEquals(toReview.length, 0);
  assertEquals(skipped.length, 0);
});

Deno.test('filterFilesForReview - includes added files', () => {
  const files: GitHubDiffFile[] = [
    createMockDiffFile('src/new-feature.ts', 'added'),
    createMockDiffFile('src/existing.ts', 'modified'),
  ];

  const { toReview } = filterFilesForReview(files, DEFAULT_CONFIG);

  assertEquals(toReview.length, 2);
});

Deno.test('filterFilesForReview - includes renamed files', () => {
  const files: GitHubDiffFile[] = [
    createMockDiffFile('src/renamed.ts', 'renamed'),
  ];

  const { toReview } = filterFilesForReview(files, DEFAULT_CONFIG);

  assertEquals(toReview.length, 1);
});

// ============================================
// Pattern Matching Edge Cases
// ============================================

Deno.test('shouldReviewFile - handles file without extension', () => {
  assertEquals(shouldReviewFile('Dockerfile', DEFAULT_CONFIG.ignorePatterns), true);
  assertEquals(shouldReviewFile('Makefile', DEFAULT_CONFIG.ignorePatterns), true);
});

Deno.test('shouldReviewFile - handles deeply nested paths', () => {
  assertEquals(
    shouldReviewFile('src/components/ui/buttons/primary/index.tsx', DEFAULT_CONFIG.ignorePatterns),
    true
  );
});

Deno.test('shouldReviewFile - handles special characters in filenames', () => {
  assertEquals(shouldReviewFile('src/my-component.tsx', DEFAULT_CONFIG.ignorePatterns), true);
  assertEquals(shouldReviewFile('src/my_component.tsx', DEFAULT_CONFIG.ignorePatterns), true);
});

Deno.test('shouldReviewFile - empty pattern list includes all files', () => {
  assertEquals(shouldReviewFile('anything.js', []), true);
  assertEquals(shouldReviewFile('node_modules/file.js', []), true);
});

Deno.test('shouldReviewFile - handles patterns with question mark', () => {
  const patterns = ['?.ts', 'a?.js'];

  assertEquals(shouldReviewFile('a.ts', patterns), false);
  assertEquals(shouldReviewFile('ab.ts', patterns), true);
  assertEquals(shouldReviewFile('ab.js', patterns), false);
  assertEquals(shouldReviewFile('abc.js', patterns), true);
});

// ============================================
// Config Integration Tests
// ============================================

Deno.test('filterFilesForReview - custom ignore patterns work', () => {
  const files: GitHubDiffFile[] = [
    createMockDiffFile('src/index.ts'),
    createMockDiffFile('src/test.spec.ts'),
    createMockDiffFile('src/utils.test.ts'),
  ];

  const config: RepoConfig = {
    ...DEFAULT_CONFIG,
    ignorePatterns: [...DEFAULT_CONFIG.ignorePatterns, '*.spec.ts', '*.test.ts'],
  };

  const { toReview, skipped } = filterFilesForReview(files, config);

  assertEquals(toReview.length, 1);
  assertEquals(toReview[0].filename, 'src/index.ts');
  assertEquals(skipped.length, 2);
});

Deno.test('filterFilesForReview - combines multiple filter reasons', () => {
  const files: GitHubDiffFile[] = [
    createMockDiffFile('src/index.ts'),
    createMockDiffFile('package-lock.json'), // Ignored pattern
    createMockDiffFile('src/old.ts', 'removed'), // Removed
    createMockDiffFile('node_modules/pkg/index.js'), // node_modules
  ];

  const { toReview, skipped } = filterFilesForReview(files, DEFAULT_CONFIG);

  assertEquals(toReview.length, 1);
  assertEquals(skipped.length, 3);
});
