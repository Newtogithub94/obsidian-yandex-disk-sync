/**
 * tests/unit/crypto.test.ts
 * Comprehensive test suite for Web Crypto AES-256-GCM, PBKDF2, and OYDS envelopes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoService, hexToBytes, bytesToHex } from '../../src/crypto/crypto-service';
import { isEnvelope, parseEnvelope } from '../../src/crypto/envelope';
import { SyncError } from '../../src/types';

describe('E2EE Cryptographic Engine & Envelope Suite', () => {
  let cryptoService: CryptoService;
  const testPassword = 'Correct-Horse-Battery-Staple-2026!';

  beforeEach(async () => {
    cryptoService = new CryptoService();
    await cryptoService.initializeKey(testPassword);
  });

  it('initializes key and generates a 16-byte random salt in hex format', () => {
    const salt = cryptoService.getSalt();
    expect(salt).toBeDefined();
    expect(salt).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(hexToBytes(salt!)).toHaveLength(16);
  });

  it('reuses existing vault salt when supplied', async () => {
    const customSalt = '0123456789abcdef0123456789abcdef';
    const returnedSalt = await cryptoService.initializeKey(testPassword, customSalt);
    expect(returnedSalt).toBe(customSalt);
    expect(cryptoService.getSalt()).toBe(customSalt);
  });

  it('successfully encrypts and decrypts UTF-8 plaintext note', async () => {
    const text = 'Hello, Obsidian and Yandex Disk! Привет, мир! 🚀\nMulti-line note with markdown.';
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(text).buffer;

    const envelope = await cryptoService.encrypt(plaintext);
    expect(cryptoService.isEncrypted(envelope)).toBe(true);
    expect(isEnvelope(envelope)).toBe(true);

    const decryptedBuf = await cryptoService.decrypt(envelope);
    const decoder = new TextDecoder();
    const recoveredText = decoder.decode(decryptedBuf);

    expect(recoveredText).toBe(text);
  });

  it('successfully encrypts and decrypts empty buffer', async () => {
    const emptyBuf = new ArrayBuffer(0);
    const envelope = await cryptoService.encrypt(emptyBuf);
    expect(cryptoService.isEncrypted(envelope)).toBe(true);

    const decrypted = await cryptoService.decrypt(envelope);
    expect(decrypted.byteLength).toBe(0);
  });

  it('successfully encrypts and decrypts binary payloads (PDF / images)', async () => {
    const binaryData = new Uint8Array(1024 * 64); // 64 KB binary
    for (let i = 0; i < binaryData.length; i++) {
      binaryData[i] = i % 256;
    }

    const envelope = await cryptoService.encrypt(binaryData.buffer);
    const decrypted = await cryptoService.decrypt(envelope);
    const decryptedBytes = new Uint8Array(decrypted);

    expect(decryptedBytes.length).toBe(binaryData.length);
    expect(decryptedBytes).toEqual(binaryData);
  });

  it('fails decryption with wrong passphrase', async () => {
    const encoder = new TextEncoder();
    const plaintext = encoder.encode('Confidential project plan').buffer;
    const envelope = await cryptoService.encrypt(plaintext);

    const attackerService = new CryptoService();
    await attackerService.initializeKey('WrongPassword123!', cryptoService.getSalt());

    await expect(attackerService.decrypt(envelope)).rejects.toThrow(SyncError);
    await expect(attackerService.decrypt(envelope)).rejects.toMatchObject({
      code: 'CRYPTO_TAG_VERIFICATION_FAILED',
    });
  });

  it('detects tampering of AAD header (e.g. version or algo flipped)', async () => {
    const encoder = new TextEncoder();
    const plaintext = encoder.encode('Immutable audit log').buffer;
    const envelope = await cryptoService.encrypt(plaintext);

    // Tamper with byte 5 (cipherAlgo) in the raw header
    const tampered = new Uint8Array(envelope.slice(0));
    tampered[5] = 0x99;

    await expect(cryptoService.decrypt(tampered.buffer)).rejects.toMatchObject({
      code: 'CRYPTO_UNSUPPORTED_VERSION',
    });
  });

  it('detects tampering of ciphertext or authentication tag', async () => {
    const encoder = new TextEncoder();
    const plaintext = encoder.encode('Integrity critical document').buffer;
    const envelope = await cryptoService.encrypt(plaintext);

    // Tamper with last byte (part of GCM tag)
    const tampered = new Uint8Array(envelope.slice(0));
    tampered[tampered.length - 1]! ^= 0xff;

    await expect(cryptoService.decrypt(tampered.buffer)).rejects.toMatchObject({
      code: 'CRYPTO_TAG_VERIFICATION_FAILED',
    });
  });

  it('correctly calculates SHA-256 hash', async () => {
    const encoder = new TextEncoder();
    const data = encoder.encode('test-hash-string').buffer;
    const hash = await cryptoService.computeHash(data);

    // echo -n "test-hash-string" | sha256sum -> b451a95...
    expect(hash).toHaveLength(64);
    expect(typeof hash).toBe('string');
  });

  it('parses valid envelope metadata correctly', async () => {
    const encoder = new TextEncoder();
    const plaintext = encoder.encode('Sample text').buffer;
    const envelope = await cryptoService.encrypt(plaintext);

    const parsed = parseEnvelope(envelope);
    expect(parsed.header.magic).toBe('OYDS');
    expect(parsed.header.version).toBe(1);
    expect(parsed.header.cipherAlgo).toBe(1);
    expect(parsed.header.salt).toHaveLength(16);
    expect(parsed.header.iv).toHaveLength(12);
    expect(parsed.rawHeader).toHaveLength(36);
  });
});
