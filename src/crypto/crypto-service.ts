/**
 * src/crypto/crypto-service.ts
 * Production-grade Web Crypto implementation of AES-256-GCM authenticated encryption,
 * PBKDF2-HMAC-SHA256 key derivation, and content hashing.
 */

import {
  AES_KEY_BIT_LENGTH,
  AES_GCM_IV_LENGTH,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_LENGTH,
} from '../constants';
import { ICryptoService, SyncError } from '../types';
import {
  isEnvelope,
  createEnvelopeHeader,
  parseEnvelope,
  serializeEnvelope,
} from './envelope';

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new SyncError('Invalid hex string length', 'CRYPTO_CORRUPTED_ENVELOPE');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export class CryptoService implements ICryptoService {
  private passphrase?: string;
  private vaultSaltBytes?: Uint8Array;
  private vaultSaltHex?: string;
  private cachedKey?: CryptoKey;

  /**
   * Initializes or updates encryption credentials.
   * Derives and caches a 256-bit AES-GCM key using PBKDF2 with 100,000 iterations.
   * Returns the vault salt as a hex string.
   */
  public async initializeKey(passphrase: string, vaultSaltHex?: string): Promise<string> {
    if (!passphrase || passphrase.trim().length === 0) {
      throw new SyncError('Master passphrase cannot be empty.', 'CRYPTO_PASSWORD_REQUIRED');
    }

    this.passphrase = passphrase;

    if (vaultSaltHex && vaultSaltHex.trim().length > 0) {
      this.vaultSaltBytes = hexToBytes(vaultSaltHex.trim());
      this.vaultSaltHex = vaultSaltHex.trim().toLowerCase();
    } else {
      const generated = new Uint8Array(PBKDF2_SALT_LENGTH);
      crypto.getRandomValues(generated);
      this.vaultSaltBytes = generated;
      this.vaultSaltHex = bytesToHex(generated);
    }

    this.cachedKey = await this.deriveKey(this.passphrase, this.vaultSaltBytes);
    return this.vaultSaltHex;
  }

  /**
   * Derives an AES-GCM CryptoKey from a passphrase and salt.
   */
  private async deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const passphraseBytes = encoder.encode(passphrase);

    const baseKey = await crypto.subtle.importKey(
      'raw',
      passphraseBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt as BufferSource,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      {
        name: 'AES-GCM',
        length: AES_KEY_BIT_LENGTH,
      },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypts plaintext data into a standard OYDS envelope with AES-256-GCM.
   * Uses the 36-byte envelope header as Additional Authenticated Data (AAD)
   * to guarantee complete header integrity and tamper resistance.
   */
  public async encrypt(plaintext: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.cachedKey || !this.vaultSaltBytes) {
      throw new SyncError(
        'E2EE is enabled but crypto service has not been initialized with a passphrase.',
        'CRYPTO_PASSWORD_REQUIRED'
      );
    }

    // Generate random 12-byte IV for this specific encryption operation
    const iv = new Uint8Array(AES_GCM_IV_LENGTH);
    crypto.getRandomValues(iv);

    // Build the 36-byte raw header
    const rawHeader = createEnvelopeHeader(this.vaultSaltBytes, iv);

    // Encrypt with rawHeader bound as AAD
    let ciphertextBuf: ArrayBuffer;
    try {
      ciphertextBuf = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource,
          additionalData: rawHeader as BufferSource,
        },
        this.cachedKey,
        plaintext
      );
    } catch (err: any) {
      throw new SyncError(
        `AES-GCM encryption failed: ${err?.message || err}`,
        'VAULT_WRITE_FAILED',
        { originalError: err }
      );
    }

    return serializeEnvelope(rawHeader, new Uint8Array(ciphertextBuf));
  }

  /**
   * Decrypts an OYDS binary envelope.
   * Verifies the AAD header and GCM authentication tag.
   */
  public async decrypt(envelope: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.passphrase) {
      throw new SyncError(
        'Cannot decrypt: encryption passphrase has not been configured.',
        'CRYPTO_PASSWORD_REQUIRED'
      );
    }

    const payload = parseEnvelope(envelope);
    const saltBytes = payload.header.salt;
    const ivBytes = payload.header.iv;
    const rawHeader = payload.rawHeader;
    const ciphertextBytes = payload.ciphertext;

    // Determine appropriate key for this envelope's salt
    let keyToUse = this.cachedKey;
    const envelopeSaltHex = bytesToHex(saltBytes);

    if (!keyToUse || envelopeSaltHex !== this.vaultSaltHex) {
      // Ephemeral derivation if salt differs from session salt
      keyToUse = await this.deriveKey(this.passphrase, saltBytes);
    }

    try {
      return await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: ivBytes as BufferSource,
          additionalData: rawHeader as BufferSource,
        },
        keyToUse,
        ciphertextBytes as BufferSource
      );
    } catch (err: any) {
      throw new SyncError(
        'Decryption failed: authentication tag verification failed (incorrect password or corrupted data).',
        'CRYPTO_TAG_VERIFICATION_FAILED',
        { originalError: err }
      );
    }
  }

  /**
   * Checks whether a buffer represents a valid OYDS encrypted envelope.
   */
  public isEncrypted(buffer: ArrayBuffer): boolean {
    return isEnvelope(buffer);
  }

  /**
   * Calculates SHA-256 cryptographic hash of arbitrary binary data, returning lower-case hex.
   */
  public async computeHash(data: ArrayBuffer): Promise<string> {
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(new Uint8Array(hashBuf));
  }

  /**
   * Retrieves the current vault salt hex string.
   */
  public getSalt(): string | undefined {
    return this.vaultSaltHex;
  }
}
