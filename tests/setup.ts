import { webcrypto } from 'node:crypto';

// Ensure global Web Crypto API is active in test runner
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  // @ts-ignore
  globalThis.crypto = webcrypto;
}

// Ensure global TextEncoder and TextDecoder are active
if (typeof globalThis.TextEncoder === 'undefined') {
  const util = await import('node:util');
  // @ts-ignore
  globalThis.TextEncoder = util.TextEncoder;
  // @ts-ignore
  globalThis.TextDecoder = util.TextDecoder;
}

// Ensure global window is active in test runner for Web APIs
if (typeof globalThis.window === 'undefined') {
  // @ts-ignore
  globalThis.window = globalThis;
}
