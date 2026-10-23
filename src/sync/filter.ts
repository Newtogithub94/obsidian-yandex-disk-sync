/**
 * src/sync/filter.ts
 * Path normalization and exclusion rules to protect against platform layout collisions,
 * cache leaks, and OS metadata pollution.
 */

import { DEFAULT_EXCLUDED_PATTERNS } from '../constants';

/**
 * Normalizes any vault or remote path into forward-slash canonical representation
 * with leading and trailing slashes stripped.
 */
export function normalizeVaultPath(rawPath: string): string {
  if (!rawPath) return '';
  // Normalize Unicode to canonical composition form (NFC) across Windows/Android/macOS
  let normalized = rawPath.normalize('NFC').replace(/\\/g, '/');

  // Strip leading and trailing slashes
  normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');

  // Collapse consecutive slashes
  normalized = normalized.replace(/\/{2,}/g, '/');

  return normalized;
}

/**
 * Checks whether a relative path matches default or user-defined exclusion patterns.
 */
export function isPathExcluded(
  path: string,
  customRegexPatterns?: (string | RegExp)[]
): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized) return true;

  // 1. Check built-in system exclusions
  for (const pattern of DEFAULT_EXCLUDED_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // 2. Check user-defined custom patterns
  if (customRegexPatterns && customRegexPatterns.length > 0) {
    for (const pattern of customRegexPatterns) {
      if (typeof pattern === 'string') {
        const trimmed = pattern.trim();
        if (!trimmed) continue;
        try {
          const regex = new RegExp(trimmed, 'i');
          if (regex.test(normalized)) {
            return true;
          }
        } catch {
          // If invalid regex, perform literal substring/wildcard match
          if (normalized.includes(trimmed)) {
            return true;
          }
        }
      } else if (pattern instanceof RegExp) {
        if (pattern.test(normalized)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Filters an array of file paths, discarding all excluded files.
 */
export function filterPaths(paths: string[], customPatterns?: (string | RegExp)[]): string[] {
  return paths
    .map(normalizeVaultPath)
    .filter((p) => p.length > 0 && !isPathExcluded(p, customPatterns));
}
