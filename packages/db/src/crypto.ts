/**
 * AES-256-GCM encryption/decryption for API keys.
 *
 * Uses Node.js crypto module (Web Crypto API compatible).
 *
 * ## Formats
 *
 * v1 (legacy, read-only): base64(iv[12] + ciphertext + authTag[16])
 *   — compact packed format used by ghagga ≤ v3.x
 *
 * v2 (current): "v2:<base64iv>:<base64cipher>:<base64authtag>"
 *   — aligns with mcp-llm-bridge vault/crypto.ts EncryptedData layout;
 *     each component is separately base64-encoded and colon-delimited.
 *     Canonical implementation: mcp-llm-bridge/src/vault/crypto.ts
 *
 * `decrypt()` auto-detects the format by checking for the "v2:" prefix.
 * `encrypt()` always produces v2. Existing v1 values decrypt transparently.
 *
 * ## Migration
 * ghagga v4 is a fresh deploy — there is no production data to migrate from v1
 * to v2. v2 is the only format `encrypt()` writes; `migrateToV2()` is retained
 * for completeness but currently has no callers.
 *
 * ENCRYPTION_KEY env var: 64 hex characters (32 bytes).
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';
const V2_PREFIX = 'v2:';

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  if (key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @returns v2 format: "v2:<base64iv>:<base64cipher>:<base64authtag>"
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${V2_PREFIX}${iv.toString('base64')}:${encrypted.toString('base64')}:${authTag.toString('base64')}`;
}

/**
 * Decrypt a v1 or v2 encrypted string back to plaintext.
 *
 * v1: base64(iv[12] + ciphertext + authTag[16])
 * v2: "v2:<base64iv>:<base64cipher>:<base64authtag>"
 */
export function decrypt(value: string): string {
  const key = getEncryptionKey();

  if (value.startsWith(V2_PREFIX)) {
    return decryptV2(value.slice(V2_PREFIX.length), key);
  }

  return decryptV1(value, key);
}

function decryptV1(base64str: string, key: Buffer): string {
  const combined = Buffer.from(base64str, 'base64');

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decryptV2(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid v2 encrypted data: expected "iv:cipher:authTag"');
  }

  const iv = Buffer.from(parts[0]!, 'base64');
  const ciphertext = Buffer.from(parts[1]!, 'base64');
  const authTag = Buffer.from(parts[2]!, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Re-encrypt a v1 value as v2. Used by the migration script.
 * Returns the value unchanged if it's already v2.
 */
export function migrateToV2(value: string): string {
  if (value.startsWith(V2_PREFIX)) return value;
  const plaintext = decrypt(value);
  return encrypt(plaintext);
}
