/**
 * src/crypto/envelope.ts
 * Binary serialization, parsing, and validation for OYDS cryptographic envelopes.
 */

import {
  ENVELOPE_MAGIC_BYTES,
  ENVELOPE_VERSION,
  CIPHER_ALGORITHM_AES_256_GCM,
  PBKDF2_SALT_LENGTH,
  AES_GCM_IV_LENGTH,
  AES_GCM_TAG_LENGTH,
  ENVELOPE_HEADER_LENGTH,
} from '../constants';
import { EnvelopeHeader, EncryptedPayload, SyncError } from '../types';

/**
 * Validates if an ArrayBuffer starts with valid OYDS magic bytes and supported version.
 */
export function isEnvelope(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < ENVELOPE_HEADER_LENGTH + AES_GCM_TAG_LENGTH) {
    return false;
  }

  const view = new Uint8Array(buffer, 0, 4);
  return (
    view[0] === ENVELOPE_MAGIC_BYTES[0] &&
    view[1] === ENVELOPE_MAGIC_BYTES[1] &&
    view[2] === ENVELOPE_MAGIC_BYTES[2] &&
    view[3] === ENVELOPE_MAGIC_BYTES[3]
  );
}

/**
 * Creates the canonical 36-byte binary header used for OYDS envelopes and AAD authentication.
 */
export function createEnvelopeHeader(salt: Uint8Array, iv: Uint8Array): Uint8Array {
  if (salt.byteLength !== PBKDF2_SALT_LENGTH) {
    throw new SyncError(
      `Invalid salt length: expected ${PBKDF2_SALT_LENGTH}, got ${salt.byteLength}`,
      'CRYPTO_CORRUPTED_ENVELOPE'
    );
  }
  if (iv.byteLength !== AES_GCM_IV_LENGTH) {
    throw new SyncError(
      `Invalid IV length: expected ${AES_GCM_IV_LENGTH}, got ${iv.byteLength}`,
      'CRYPTO_CORRUPTED_ENVELOPE'
    );
  }

  const header = new Uint8Array(ENVELOPE_HEADER_LENGTH);
  // Magic bytes: "OYDS" (4 bytes)
  header.set(ENVELOPE_MAGIC_BYTES, 0);
  // Version: 1 (1 byte)
  header[4] = ENVELOPE_VERSION;
  // Cipher algorithm: 1 (AES-256-GCM) (1 byte)
  header[5] = CIPHER_ALGORITHM_AES_256_GCM;
  // Reserved: 0x00, 0x00 (2 bytes)
  header[6] = 0x00;
  header[7] = 0x00;
  // PBKDF2 Salt: 16 bytes (offset 8..23)
  header.set(salt, 8);
  // AES-GCM IV: 12 bytes (offset 24..35)
  header.set(iv, 24);

  return header;
}

/**
 * Parses a binary OYDS envelope into header metadata, raw AAD header, and ciphertext.
 */
export function parseEnvelope(buffer: ArrayBuffer): EncryptedPayload {
  if (!isEnvelope(buffer)) {
    throw new SyncError(
      'Buffer is not a valid OYDS encrypted envelope.',
      'CRYPTO_CORRUPTED_ENVELOPE'
    );
  }

  const bytes = new Uint8Array(buffer);
  const version = bytes[4] ?? 0;
  if (version !== ENVELOPE_VERSION) {
    throw new SyncError(
      `Unsupported envelope version: ${version} (expected ${ENVELOPE_VERSION})`,
      'CRYPTO_UNSUPPORTED_VERSION'
    );
  }

  const cipherAlgo = bytes[5] ?? 0;
  if (cipherAlgo !== CIPHER_ALGORITHM_AES_256_GCM) {
    throw new SyncError(
      `Unsupported cipher algorithm: ${cipherAlgo}`,
      'CRYPTO_UNSUPPORTED_VERSION'
    );
  }

  const salt = bytes.slice(8, 24);
  const iv = bytes.slice(24, 36);
  const rawHeader = bytes.slice(0, ENVELOPE_HEADER_LENGTH);
  const ciphertext = bytes.slice(ENVELOPE_HEADER_LENGTH);

  const header: EnvelopeHeader = {
    magic: 'OYDS',
    version,
    cipherAlgo,
    reserved: 0,
    salt,
    iv,
  };

  return {
    header,
    rawHeader,
    ciphertext,
    buffer,
  };
}

/**
 * Packs raw header and ciphertext into a single continuous ArrayBuffer.
 */
export function serializeEnvelope(rawHeader: Uint8Array, ciphertext: Uint8Array): ArrayBuffer {
  const totalLength = rawHeader.byteLength + ciphertext.byteLength;
  const out = new Uint8Array(totalLength);
  out.set(rawHeader, 0);
  out.set(ciphertext, rawHeader.byteLength);
  return out.buffer;
}
