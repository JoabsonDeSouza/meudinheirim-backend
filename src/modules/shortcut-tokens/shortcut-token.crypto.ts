import { createHash, randomBytes } from 'node:crypto';

export const SHORTCUT_TOKEN_PREFIX = 'mdsc_';

/**
 * Creates a device token: `mdsc_` + 32 random bytes (base64url, 256 bits).
 * Only the SHA-256 hex digest is persisted; the raw token is returned once to the caller.
 */
export function generateShortcutToken(): { token: string; tokenHash: string } {
  const token = `${SHORTCUT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashShortcutToken(token) };
}

export function hashShortcutToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isShortcutTokenShape(value: string): boolean {
  return value.startsWith(SHORTCUT_TOKEN_PREFIX) && value.length > SHORTCUT_TOKEN_PREFIX.length;
}
