import { describe, expect, it } from 'vitest';
import { stripPrivateData } from './privacy.js';

describe('stripPrivateData', () => {
  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const text = 'key = sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(result).not.toContain('sk-ant-api03');
  });

  it('redacts OpenAI API keys (sk-...)', () => {
    const text = 'OPENAI_KEY=sk-proj1234567890abcdefghijklmn';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_OPENAI_KEY]');
    expect(result).not.toContain('sk-proj1234567890');
  });

  it('redacts OpenAI sk-proj-* keys with internal hyphens', () => {
    // Newer OpenAI keys use sk-proj-<org>-<random> format with hyphens
    const text = 'OPENAI_KEY=sk-proj-abc123-def456-ghi789-jkl012mno345pqr678';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_OPENAI_KEY]');
    expect(result).not.toContain('sk-proj-abc123');
    expect(result).not.toContain('jkl012mno345pqr678');
  });

  it('redacts AWS Access Key IDs (AKIA...)', () => {
    const text = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_AWS_KEY]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts GitHub PATs (ghp_, gho_, ghs_, github_pat_)', () => {
    const ghp = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
    expect(stripPrivateData(ghp)).toContain('[REDACTED_GITHUB_PAT]');

    const gho = 'token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
    expect(stripPrivateData(gho)).toContain('[REDACTED_GITHUB_OAUTH]');

    const ghs = 'token: ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
    expect(stripPrivateData(ghs)).toContain('[REDACTED_GITHUB_APP]');

    const pat = 'token: github_pat_ABCDEFGHIJKLMNOPQRSTUV_extra';
    expect(stripPrivateData(pat)).toContain('[REDACTED_GITHUB_FINE_PAT]');
  });

  it('redacts Google API keys (AIza...)', () => {
    // Construct at runtime to avoid triggering GitHub secret scanning
    const googleKey = 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv';
    const text = `google_key = ${googleKey}`;
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_GOOGLE_KEY]');
    expect(result).not.toContain('AIza');
  });

  it('redacts Slack tokens (xoxb-, xoxp-)', () => {
    // Construct tokens at runtime to avoid triggering GitHub push protection
    const xoxb = `SLACK_TOKEN=${['xoxb', '9998887776', 'fakeTestToken'].join('-')}`;
    expect(stripPrivateData(xoxb)).toContain('[REDACTED_SLACK_TOKEN]');

    const xoxp = `SLACK_TOKEN=${['xoxp', '9998887776', 'fakeTestToken'].join('-')}`;
    expect(stripPrivateData(xoxp)).toContain('[REDACTED_SLACK_TOKEN]');
  });

  it('redacts Bearer tokens in headers', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature_ok';
    const result = stripPrivateData(text);
    expect(result).toContain('Bearer [REDACTED');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('redacts password/secret/token assignments in quotes', () => {
    const text1 = 'password = "mySuperSecretPassword123"';
    expect(stripPrivateData(text1)).toContain('[REDACTED]');
    expect(stripPrivateData(text1)).not.toContain('mySuperSecretPassword123');

    const text2 = "secret: 'anotherLongSecretValue99'";
    expect(stripPrivateData(text2)).toContain('[REDACTED]');

    const text3 = 'api_key = "longapikey1234567890ab"';
    expect(stripPrivateData(text3)).toContain('[REDACTED]');
  });

  it('redacts PEM private keys', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF068wCKz',
      'PvkclYJEoLkNT3xKLNBcSU8GZF3sSuO3XAZT1K7B3gL3',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = stripPrivateData(pem);
    expect(result).toContain('[REDACTED_PRIVATE_KEY]');
    expect(result).not.toContain('MIIEpAIBAAKCAQEA');
  });

  it('redacts JWT tokens (eyJ...eyJ...xxx)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = stripPrivateData(jwt);
    expect(result).toContain('[REDACTED_JWT]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('does NOT redact normal text that looks similar but is not a key', () => {
    const normalText = 'The skeleton key was found in the drawer. The sk variable is defined.';
    const result = stripPrivateData(normalText);
    expect(result).toBe(normalText);
  });

  it('preserves surrounding text (only replaces the key portion)', () => {
    const text = 'Use this key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890 for auth.';
    const result = stripPrivateData(text);
    expect(result).toContain('Use this key:');
    expect(result).toContain('for auth.');
    expect(result).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('handles text with multiple different secrets', () => {
    const text = [
      'ANTHROPIC_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890',
      'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl',
    ].join('\n');
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(result).toContain('[REDACTED_AWS_KEY]');
    expect(result).toContain('[REDACTED_GITHUB_PAT]');
  });

  it('returns unchanged text when no secrets found', () => {
    const cleanText = 'function add(a: number, b: number): number {\n  return a + b;\n}';
    expect(stripPrivateData(cleanText)).toBe(cleanText);
  });

  // ─── Sprint 2 gap-closing patterns ────────────────────────────

  it('redacts GitLab personal access tokens (glpat-...)', () => {
    const text = 'CI_TOKEN=glpat-aBcDeFgHiJkLmNoPqRsT12';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_GITLAB_PAT]');
    expect(result).not.toContain('glpat-aBcDeFgHiJkLmNoPqRsT12');
  });

  it('redacts npm tokens (npm_...)', () => {
    const text = '//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_NPM_TOKEN]');
    expect(result).not.toContain('npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  });

  it('redacts Stripe secret and restricted keys (sk_live_, sk_test_, rk_live_, rk_test_)', () => {
    for (const prefix of ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_']) {
      const key = `${prefix}aBcDeFgHiJkLmNoPqRsTuVwX`;
      const result = stripPrivateData(`stripe key: ${key}`);
      expect(result, `failed for ${prefix}`).toContain('[REDACTED_STRIPE_KEY]');
      expect(result, `failed for ${prefix}`).not.toContain(key);
    }
  });

  it('redacts Stripe webhook signing secrets (whsec_...)', () => {
    const text = 'STRIPE_WEBHOOK_SECRET=whsec_aBcDeFgHiJkLmNoPqRsTuVwX';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED_STRIPE_WEBHOOK_SECRET]');
    expect(result).not.toContain('whsec_aBcDeFgHiJkLmNoPqRsTuVwX');
  });

  it('redacts Slack app-level tokens (xapp-, xoxa-)', () => {
    const xapp = `token: ${['xapp', '1', 'A012345678', 'fakeAppToken'].join('-')}`;
    expect(stripPrivateData(xapp)).toContain('[REDACTED_SLACK_TOKEN]');

    const xoxa = `token: ${['xoxa', '2', '9998887776', 'fakeToken'].join('-')}`;
    expect(stripPrivateData(xoxa)).toContain('[REDACTED_SLACK_TOKEN]');
  });

  it('redacts Hugging Face tokens (hf_...)', () => {
    const text = 'HF_TOKEN=hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
    const result = stripPrivateData(text);
    expect(result).toContain('[REDACTED');
    expect(result).not.toContain('hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
  });

  it('redacts SendGrid API keys (SG.<id>.<secret>)', () => {
    const key = 'SG.aBcDeFgHiJkLmNoPqRsTuV.aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_abcd';
    const result = stripPrivateData(`sendgrid: ${key}`);
    expect(result).toContain('[REDACTED_SENDGRID_KEY]');
    expect(result).not.toContain(key);
  });

  it('redacts OPENSSH, PKCS8, ENCRYPTED, and PGP PEM private keys', () => {
    const variants = [
      ['-----BEGIN OPENSSH PRIVATE KEY-----', '-----END OPENSSH PRIVATE KEY-----'],
      ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'], // PKCS8
      ['-----BEGIN ENCRYPTED PRIVATE KEY-----', '-----END ENCRYPTED PRIVATE KEY-----'],
      ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----END PGP PRIVATE KEY BLOCK-----'],
    ];
    for (const [begin, end] of variants) {
      const pem = [begin, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==', end].join('\n');
      const result = stripPrivateData(pem);
      expect(result, `failed for ${begin}`).toContain('[REDACTED_PRIVATE_KEY]');
      expect(result, `failed for ${begin}`).not.toContain('b3BlbnNzaC1rZXktdjE');
    }
  });

  it('redacts quoted AWS secret keys and YAML-style separators', () => {
    const secret = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYaa';

    const quoted = `AWS_SECRET_ACCESS_KEY="${secret}"`;
    expect(stripPrivateData(quoted)).toContain('[REDACTED_AWS_SECRET]');
    expect(stripPrivateData(quoted)).not.toContain(secret);

    const yaml = `AWS_SECRET_ACCESS_KEY: ${secret}`;
    expect(stripPrivateData(yaml)).toContain('[REDACTED_AWS_SECRET]');
    expect(stripPrivateData(yaml)).not.toContain(secret);
  });

  it('redacts unquoted .env-style secret assignments', () => {
    const cases = [
      'DB_PASSWORD=hunter2hunter2',
      'MY_API_KEY=abcd1234efgh5678',
      'SESSION_SECRET: superDuperSecretValue',
      'AUTH_TOKEN_PROD=tok-9f8e7d6c5b4a',
    ];
    for (const text of cases) {
      const result = stripPrivateData(text);
      expect(result, `failed for "${text}"`).toContain('[REDACTED]');
      const value = text.split(/[:=]\s*/)[1]!;
      expect(result, `failed for "${text}"`).not.toContain(value);
    }
  });

  it('redacts passwords in URL userinfo, preserving user and host', () => {
    const text = 'DATABASE_URL is postgres://admin:s3cretPass@db.internal:5432/app';
    const result = stripPrivateData(text);
    expect(result).not.toContain('s3cretPass');
    expect(result).toContain('[REDACTED_URL_PASSWORD]');
    expect(result).toContain('postgres://admin:');
    expect(result).toContain('@db.internal:5432/app');
  });

  // ─── False-positive guards for the new patterns ───────────────

  it('does NOT redact identifiers that merely resemble Stripe keys', () => {
    const text = 'const sk_live_docs_url = getDocsUrl();';
    expect(stripPrivateData(text)).toBe(text);
  });

  it('does NOT redact process.env.API_KEY references without a value', () => {
    const text = 'const key = process.env.API_KEY;';
    expect(stripPrivateData(text)).toBe(text);
  });

  it('does NOT redact prose mentioning the word password', () => {
    const text = 'Remember to rotate your password regularly. See the password policy docs.';
    expect(stripPrivateData(text)).toBe(text);
  });

  it('does NOT redact URLs without userinfo (port is not a password)', () => {
    const text = 'Server listening on https://example.com:8080/health';
    expect(stripPrivateData(text)).toBe(text);
  });

  it('does NOT double-redact labels inserted by more specific patterns', () => {
    const text = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
    const result = stripPrivateData(text);
    // The specific GitHub label must survive the generic assignment pass
    expect(result).toContain('[REDACTED_GITHUB_PAT]');
  });

  it('does NOT redact short values below the 8-char floor', () => {
    const text = 'const PASSWORD_MIN_LENGTH = 12;';
    expect(stripPrivateData(text)).toBe(text);
  });
});
