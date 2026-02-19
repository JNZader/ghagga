/**
 * Privacy utilities for memory observations
 *
 * Strips sensitive data before persisting observations.
 * Pure functions, no side effects.
 */

/** Pattern sources (without flags - instantiated fresh per call to avoid lastIndex state) */
const PRIVATE_TAG_SOURCE = '<private>[\\s\\S]*?<\\/private>';
const API_KEY_SOURCES: string[] = [
  'sk-[a-zA-Z0-9]{20,}',         // OpenAI keys
  'ghp_[a-zA-Z0-9]{36,}',        // GitHub PATs
  'gho_[a-zA-Z0-9]{36,}',        // GitHub OAuth tokens
  'ghs_[a-zA-Z0-9]{36,}',        // GitHub App tokens
  'glpat-[a-zA-Z0-9\\-_]{20,}',  // GitLab PATs
  'xoxb-[a-zA-Z0-9\\-]+',        // Slack bot tokens
  'xoxp-[a-zA-Z0-9\\-]+',        // Slack user tokens
];
const EMAIL_SOURCE = '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}';

/**
 * Strip private/sensitive content from text.
 * - Removes <private>...</private> blocks
 * - Redacts API keys (sk-*, ghp_*, etc.)
 * - Redacts email addresses
 */
export function stripPrivacy(content: string): string {
  let stripped = content;

  // Remove <private> tagged content
  stripped = stripped.replace(new RegExp(PRIVATE_TAG_SOURCE, 'gi'), '[REDACTED]');

  // Redact API keys
  for (const source of API_KEY_SOURCES) {
    stripped = stripped.replace(new RegExp(source, 'g'), '[REDACTED_KEY]');
  }

  // Redact emails
  stripped = stripped.replace(new RegExp(EMAIL_SOURCE, 'g'), '[REDACTED_EMAIL]');

  return stripped;
}

/**
 * Check if content contains potentially sensitive data.
 */
export function hasPrivateContent(content: string): boolean {
  if (new RegExp(PRIVATE_TAG_SOURCE, 'gi').test(content)) return true;

  for (const source of API_KEY_SOURCES) {
    if (new RegExp(source, 'g').test(content)) return true;
  }

  if (new RegExp(EMAIL_SOURCE, 'g').test(content)) return true;

  return false;
}
