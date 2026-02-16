/**
 * Tests for Memory Privacy utilities
 */

import {
  assertEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  describe,
  it,
} from 'https://deno.land/std@0.208.0/testing/bdd.ts';

import { stripPrivacy, hasPrivateContent } from '../privacy.ts';

describe('stripPrivacy', () => {
  it('should strip <private> tags', () => {
    const input = 'Hello <private>secret data</private> world';
    const result = stripPrivacy(input);
    assertEquals(result, 'Hello [REDACTED] world');
  });

  it('should strip multiple <private> tags', () => {
    const input = '<private>a</private> text <private>b</private>';
    const result = stripPrivacy(input);
    assertEquals(result, '[REDACTED] text [REDACTED]');
  });

  it('should strip multiline <private> tags', () => {
    const input = 'before <private>\nline1\nline2\n</private> after';
    const result = stripPrivacy(input);
    assertEquals(result, 'before [REDACTED] after');
  });

  it('should be case-insensitive for private tags', () => {
    const input = '<PRIVATE>secret</PRIVATE>';
    const result = stripPrivacy(input);
    assertEquals(result, '[REDACTED]');
  });

  it('should redact OpenAI API keys (sk-)', () => {
    const input = 'key is sk-abcdefghijklmnopqrstuvwxyz1234';
    const result = stripPrivacy(input);
    assertEquals(result, 'key is [REDACTED_KEY]');
  });

  it('should redact GitHub PATs (ghp_)', () => {
    const input = 'token: ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = stripPrivacy(input);
    assertEquals(result, 'token: [REDACTED_KEY]');
  });

  it('should redact GitHub OAuth tokens (gho_)', () => {
    const input = 'token: gho_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = stripPrivacy(input);
    assertEquals(result, 'token: [REDACTED_KEY]');
  });

  it('should redact GitHub App tokens (ghs_)', () => {
    const input = 'token: ghs_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = stripPrivacy(input);
    assertEquals(result, 'token: [REDACTED_KEY]');
  });

  it('should redact GitLab PATs (glpat-)', () => {
    const input = 'token: glpat-abc123def456ghi789jkl';
    const result = stripPrivacy(input);
    assertEquals(result, 'token: [REDACTED_KEY]');
  });

  it('should redact Slack bot tokens (xoxb-)', () => {
    const input = 'token: xoxb-123-456-abcdef';
    const result = stripPrivacy(input);
    assertEquals(result, 'token: [REDACTED_KEY]');
  });

  it('should redact email addresses', () => {
    const input = 'contact user@example.com for info';
    const result = stripPrivacy(input);
    assertEquals(result, 'contact [REDACTED_EMAIL] for info');
  });

  it('should redact multiple emails', () => {
    const input = 'a@b.com and c@d.org';
    const result = stripPrivacy(input);
    assertEquals(result, '[REDACTED_EMAIL] and [REDACTED_EMAIL]');
  });

  it('should handle combined sensitive content', () => {
    const input = 'API: sk-abcdefghijklmnopqrstuv email: dev@corp.com <private>internal</private>';
    const result = stripPrivacy(input);
    assertEquals(result.includes('sk-'), false);
    assertEquals(result.includes('dev@corp.com'), false);
    assertEquals(result.includes('internal'), false);
  });

  it('should return clean text unchanged', () => {
    const input = 'This is a normal code review finding about null checks';
    const result = stripPrivacy(input);
    assertEquals(result, input);
  });

  it('should handle empty string', () => {
    assertEquals(stripPrivacy(''), '');
  });
});

describe('hasPrivateContent', () => {
  it('should detect <private> tags', () => {
    assertEquals(hasPrivateContent('<private>x</private>'), true);
  });

  it('should detect API keys', () => {
    assertEquals(hasPrivateContent('sk-abcdefghijklmnopqrstuvwxyz1234'), true);
  });

  it('should detect GitHub tokens', () => {
    assertEquals(hasPrivateContent('ghp_abcdefghijklmnopqrstuvwxyz1234567890'), true);
  });

  it('should detect emails', () => {
    assertEquals(hasPrivateContent('user@example.com'), true);
  });

  it('should return false for clean text', () => {
    assertEquals(hasPrivateContent('normal text without secrets'), false);
  });

  it('should return false for empty string', () => {
    assertEquals(hasPrivateContent(''), false);
  });
});
