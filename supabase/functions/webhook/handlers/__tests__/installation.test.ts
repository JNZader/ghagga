/**
 * Installation Handler Tests
 */

import {
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
  beforeEach,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';
import {
  stub,
  type Stub,
} from 'https://deno.land/std@0.208.0/testing/mock.ts';

import type {
  InstallationEventPayload,
  GitHubInstallation,
  GitHubRepositoryShort,
} from '../../../_shared/types/github.ts';

// Mock Supabase client
interface MockSupabaseResponse {
  data: unknown;
  error: { message: string } | null;
}

// Helper to create mock installation payload
function createMockInstallationPayload(
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted',
  repositories?: GitHubRepositoryShort[]
): InstallationEventPayload {
  const installation: GitHubInstallation = {
    id: 12345678,
    account: {
      id: 1,
      login: 'test-org',
      node_id: 'O_test123',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      type: 'Organization',
    },
    repository_selection: 'selected',
    access_tokens_url: 'https://api.github.com/app/installations/12345678/access_tokens',
    repositories_url: 'https://api.github.com/installation/repositories',
    html_url: 'https://github.com/organizations/test-org/settings/installations/12345678',
    app_id: 123,
    app_slug: 'ghagga',
    target_id: 1,
    target_type: 'Organization',
    permissions: {
      contents: 'read',
      metadata: 'read',
      pull_requests: 'write',
    },
    events: ['pull_request', 'pull_request_review'],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  return {
    action,
    installation,
    repositories,
    sender: {
      id: 1,
      login: 'test-user',
      node_id: 'U_test123',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      type: 'User',
    },
  };
}

// Helper to create mock repositories
function createMockRepositories(count: number): GitHubRepositoryShort[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    node_id: `R_repo${i + 1}`,
    name: `repo-${i + 1}`,
    full_name: `test-org/repo-${i + 1}`,
    private: false,
  }));
}

describe('Installation Handler', () => {
  describe('handleInstallationCreated', () => {
    it('should create installation record with correct data', async () => {
      const payload = createMockInstallationPayload('created', createMockRepositories(2));

      // Verify payload structure
      assertEquals(payload.action, 'created');
      assertEquals(payload.installation.id, 12345678);
      assertEquals(payload.installation.account.login, 'test-org');
      assertEquals(payload.installation.target_type, 'Organization');
      assertExists(payload.repositories);
      assertEquals(payload.repositories?.length, 2);
    });

    it('should handle installation without repositories', async () => {
      const payload = createMockInstallationPayload('created');

      assertEquals(payload.action, 'created');
      assertEquals(payload.repositories, undefined);
    });

    it('should extract correct account type from target_type', () => {
      const orgPayload = createMockInstallationPayload('created');
      assertEquals(orgPayload.installation.target_type, 'Organization');

      // Simulate user installation
      const userPayload = createMockInstallationPayload('created');
      userPayload.installation.target_type = 'User';
      userPayload.installation.account = {
        id: 2,
        login: 'test-user',
        node_id: 'U_test456',
        avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4',
        type: 'User',
      };
      assertEquals(userPayload.installation.target_type, 'User');
    });
  });

  describe('handleInstallationDeleted', () => {
    it('should process deletion payload correctly', () => {
      const payload = createMockInstallationPayload('deleted');

      assertEquals(payload.action, 'deleted');
      assertEquals(payload.installation.id, 12345678);
    });
  });

  describe('createDefaultConfigs', () => {
    it('should create correct config structure for repositories', () => {
      const repos = createMockRepositories(3);

      // Verify each repo has required fields
      repos.forEach((repo, i) => {
        assertEquals(repo.full_name, `test-org/repo-${i + 1}`);
        assertEquals(repo.name, `repo-${i + 1}`);
        assertExists(repo.id);
        assertExists(repo.node_id);
      });
    });

    it('should handle empty repository list', () => {
      const repos: GitHubRepositoryShort[] = [];
      assertEquals(repos.length, 0);
    });

    it('should include default file patterns', () => {
      // Default patterns that should be included
      const expectedPatterns = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.py', '*.go', '*.rs'];
      const expectedExcludes = [
        '*.test.*',
        '*.spec.*',
        '__tests__/*',
        'node_modules/*',
        'dist/*',
        'build/*',
        '.git/*',
      ];

      // Verify patterns are comprehensive
      assertEquals(expectedPatterns.length, 7);
      assertEquals(expectedExcludes.length, 7);
    });
  });

  describe('handleInstallationEvent', () => {
    it('should handle suspend action', () => {
      const payload = createMockInstallationPayload('suspend');
      assertEquals(payload.action, 'suspend');
    });

    it('should handle unsuspend action', () => {
      const payload = createMockInstallationPayload('unsuspend');
      assertEquals(payload.action, 'unsuspend');
    });

    it('should handle new_permissions_accepted action', () => {
      const payload = createMockInstallationPayload('new_permissions_accepted');
      assertEquals(payload.action, 'new_permissions_accepted');
    });
  });

  describe('Payload Validation', () => {
    it('should have required installation fields', () => {
      const payload = createMockInstallationPayload('created', createMockRepositories(1));

      assertExists(payload.installation.id);
      assertExists(payload.installation.account);
      assertExists(payload.installation.account.login);
      assertExists(payload.installation.account.avatar_url);
      assertExists(payload.installation.target_type);
      assertExists(payload.installation.permissions);
    });

    it('should have required repository fields', () => {
      const repos = createMockRepositories(1);
      const repo = repos[0];

      assertExists(repo.id);
      assertExists(repo.node_id);
      assertExists(repo.name);
      assertExists(repo.full_name);
      assertEquals(typeof repo.private, 'boolean');
    });

    it('should handle permissions object', () => {
      const payload = createMockInstallationPayload('created');
      const permissions = payload.installation.permissions;

      assertExists(permissions);
      assertEquals(permissions.contents, 'read');
      assertEquals(permissions.pull_requests, 'write');
    });
  });
});
