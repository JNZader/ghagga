import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.js';

const TEST_KEY = randomBytes(32).toString('hex');

describe('crypto', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it('should encrypt and decrypt a string roundtrip', () => {
    const plaintext = 'sk-ant-api03-my-secret-key-12345';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
    expect(encrypted).not.toBe(plaintext);
  });

  it('should produce different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same-key-twice';
    const encrypted1 = encrypt(plaintext);
    const encrypted2 = encrypt(plaintext);

    expect(encrypted1).not.toBe(encrypted2);
    expect(decrypt(encrypted1)).toBe(plaintext);
    expect(decrypt(encrypted2)).toBe(plaintext);
  });

  it('should handle empty string', () => {
    const encrypted = encrypt('');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe('');
  });

  it('should handle unicode characters', () => {
    const plaintext = '🔑 mi clave secreta con ñ y émojis 🚀';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('should handle long strings', () => {
    const plaintext = 'a'.repeat(10_000);
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('should throw on tampered ciphertext', () => {
    const encrypted = encrypt('secret');
    const buf = Buffer.from(encrypted, 'base64');
    // Flip a byte in the ciphertext portion
    buf[15] = buf[15]! ^ 0xff;
    const tampered = buf.toString('base64');

    expect(() => decrypt(tampered)).toThrow();
  });

  it('should throw on truncated ciphertext', () => {
    expect(() => decrypt('dG9vc2hvcnQ=')).toThrow('Invalid encrypted data: too short');
  });

  it('should throw with different encryption key', () => {
    const encrypted = encrypt('secret');
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

    expect(() => decrypt(encrypted)).toThrow();
  });

  it('should throw when ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY environment variable is not set');
  });

  it('should throw when ENCRYPTION_KEY is invalid length', () => {
    process.env.ENCRYPTION_KEY = 'tooshort';
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  it('should throw when ENCRYPTION_KEY has non-hex chars', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64);
    expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY must be exactly 64 hex characters');
  });

  // ── v2 component length enforcement (Sprint 2) ──
  //
  // Node's GCM implementation accepts truncated auth tags (e.g. 4 bytes),
  // which drops forgery resistance from 2^128 to 2^32 for an attacker with
  // DB write access. decrypt() must reject any IV/tag of the wrong length.

  it('rejects a v2 payload with a truncated auth tag', () => {
    const encrypted = encrypt('secret');
    const [iv, cipher, authTag] = encrypted.slice('v2:'.length).split(':') as [
      string,
      string,
      string,
    ];

    // Truncate the 16-byte tag to 4 bytes
    const truncatedTag = Buffer.from(authTag, 'base64').subarray(0, 4).toString('base64');
    const forged = `v2:${iv}:${cipher}:${truncatedTag}`;

    expect(() => decrypt(forged)).toThrow('auth tag must be exactly 16 bytes');
  });

  it('rejects a v2 payload with a wrong-length IV', () => {
    const encrypted = encrypt('secret');
    const [, cipher, authTag] = encrypted.slice('v2:'.length).split(':') as [
      string,
      string,
      string,
    ];

    for (const badIvBytes of [8, 16, 1]) {
      const badIv = randomBytes(badIvBytes).toString('base64');
      const forged = `v2:${badIv}:${cipher}:${authTag}`;
      expect(() => decrypt(forged), `IV of ${badIvBytes} bytes must be rejected`).toThrow(
        'IV must be exactly 12 bytes',
      );
    }
  });

  it('rejects a v2 payload with an empty auth tag', () => {
    const encrypted = encrypt('secret');
    const [iv, cipher] = encrypted.slice('v2:'.length).split(':') as [string, string, string];
    expect(() => decrypt(`v2:${iv}:${cipher}:`)).toThrow('auth tag must be exactly 16 bytes');
  });

  it('still decrypts legacy v1 format (packed iv+cipher+tag)', () => {
    // Build a v1 blob manually: base64(iv[12] + ciphertext + authTag[16])
    const key = Buffer.from(TEST_KEY, 'hex');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const v1 = Buffer.concat([iv, ciphertext, authTag]).toString('base64');

    expect(decrypt(v1)).toBe('legacy-secret');
  });
});
