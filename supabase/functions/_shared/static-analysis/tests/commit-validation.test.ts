/**
 * Tests for Commit Message Validation
 */

import {
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { validateCommitMessages } from '../commit-validation.ts';

describe('Commit Validation', () => {
  describe('valid conventional commits', () => {
    const validMessages = [
      'feat: add user authentication',
      'fix(auth): handle expired tokens',
      'docs: update README',
      'style: format code with prettier',
      'refactor(api): extract validation logic',
      'perf: optimize database queries',
      'test: add unit tests for auth module',
      'build: update dependencies',
      'ci: add GitHub Actions workflow',
      'chore: clean up unused files',
      'revert: undo last commit',
      'feat(user-profile): add avatar upload',
    ];

    for (const msg of validMessages) {
      it(`should pass: "${msg}"`, () => {
        const result = validateCommitMessages([{ sha: 'abc1234', message: msg }]);
        assertEquals(result.valid, 1);
        assertEquals(result.invalid, 0);
        assertEquals(result.findings.length, 0);
      });
    }
  });

  describe('invalid commits', () => {
    it('should flag missing type prefix', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'add user authentication' },
      ]);
      assertEquals(result.invalid, 1);
      assertEquals(result.findings.length, 1);
      assertEquals(result.findings[0].severity, 'suggestion');
      assertEquals(result.findings[0].ruleId, 'commit-message-format');
    });

    it('should flag uppercase type', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'Feat: add user authentication' },
      ]);
      assertEquals(result.invalid, 1);
      assertEquals(result.findings.length, 1);
    });

    it('should flag missing colon separator', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'feat add something' },
      ]);
      assertEquals(result.invalid, 1);
    });

    it('should flag unknown type', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'update: something' },
      ]);
      assertEquals(result.invalid, 1);
    });

    it('should include short SHA in finding message', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234567890', message: 'bad commit message' },
      ]);
      assertStringIncludes(result.findings[0].message, 'abc1234');
    });

    it('should include suggestion with expected format', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'bad commit' },
      ]);
      assertStringIncludes(result.findings[0].suggestion!, 'type(scope): message');
    });
  });

  describe('merge commits', () => {
    it('should skip merge commits', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'Merge branch main into feature/login' },
      ]);
      assertEquals(result.valid, 1);
      assertEquals(result.invalid, 0);
      assertEquals(result.findings.length, 0);
    });

    it('should skip "Merge pull request" commits', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'Merge pull request #42 from owner/branch' },
      ]);
      assertEquals(result.valid, 1);
      assertEquals(result.findings.length, 0);
    });
  });

  describe('mixed commits', () => {
    it('should count valid and invalid separately', () => {
      const result = validateCommitMessages([
        { sha: 'aaa1111', message: 'feat: valid commit' },
        { sha: 'bbb2222', message: 'bad commit no type' },
        { sha: 'ccc3333', message: 'fix(api): another valid commit' },
        { sha: 'ddd4444', message: 'also bad' },
      ]);
      assertEquals(result.valid, 2);
      assertEquals(result.invalid, 2);
      assertEquals(result.findings.length, 2);
    });
  });

  describe('edge cases', () => {
    it('should handle empty commits array', () => {
      const result = validateCommitMessages([]);
      assertEquals(result.valid, 0);
      assertEquals(result.invalid, 0);
      assertEquals(result.findings.length, 0);
    });

    it('should only check first line of multi-line message', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'feat: add login\n\nThis adds login functionality' },
      ]);
      assertEquals(result.valid, 1);
      assertEquals(result.findings.length, 0);
    });

    it('should set source to static-analysis', () => {
      const result = validateCommitMessages([
        { sha: 'abc1234', message: 'bad commit' },
      ]);
      assertEquals(result.findings[0].source, 'static-analysis');
    });
  });
});
