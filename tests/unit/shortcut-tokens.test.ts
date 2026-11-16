import { describe, expect, it } from 'vitest';
import {
  generateShortcutToken,
  hashShortcutToken,
  isShortcutTokenShape,
  SHORTCUT_TOKEN_PREFIX,
} from '../../src/modules/shortcut-tokens/shortcut-token.crypto.js';
import {
  createShortcutTokenSchema,
  shortcutTransactionSchema,
} from '../../src/modules/shortcut-tokens/shortcut-tokens.schema.js';

const validBody = {
  clientMutationId: '11111111-1111-4111-8111-111111111111',
  kind: 'expense',
  amount: { minorUnits: 1250, currency: 'BRL' },
  categoryCode: 'FOOD',
  accountId: '22222222-2222-4222-8222-222222222222',
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  timeZone: 'America/Sao_Paulo',
  note: 'Café',
  paid: true,
};

describe('shortcut token crypto', () => {
  it('generates mdsc_ tokens with 256 bits of base64url entropy and stores only a SHA-256 hex digest', () => {
    const { token, tokenHash } = generateShortcutToken();
    expect(token.startsWith(SHORTCUT_TOKEN_PREFIX)).toBe(true);
    expect(token.slice(SHORTCUT_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(hashShortcutToken(token));
    expect(tokenHash).not.toContain(token);
  });

  it('does not repeat tokens across many generations', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) seen.add(generateShortcutToken().token);
    expect(seen.size).toBe(500);
  });

  it('recognises only the device-token shape', () => {
    expect(isShortcutTokenShape('mdsc_abc')).toBe(true);
    expect(isShortcutTokenShape('mdsc_')).toBe(false);
    expect(isShortcutTokenShape('eyJhbGciOi.firebase.jwt')).toBe(false);
  });
});

describe('shortcut token management schema', () => {
  it('requires exactly the transactions:create scope and a bounded device name', () => {
    expect(createShortcutTokenSchema.safeParse({ deviceName: 'iPhone', scopes: ['transactions:create'] }).success).toBe(true);
    expect(createShortcutTokenSchema.safeParse({ deviceName: 'iPhone', scopes: ['*'] }).success).toBe(false);
    expect(createShortcutTokenSchema.safeParse({ deviceName: 'iPhone', scopes: [] }).success).toBe(false);
    expect(createShortcutTokenSchema.safeParse({ deviceName: '', scopes: ['transactions:create'] }).success).toBe(false);
    expect(createShortcutTokenSchema.safeParse({ deviceName: 'x'.repeat(61), scopes: ['transactions:create'] }).success).toBe(false);
    expect(createShortcutTokenSchema.safeParse({ deviceName: 'iPhone', scopes: ['transactions:create'], maxAmountMinor: 9e9 }).success).toBe(false);
  });
});

describe('shortcut transaction schema', () => {
  it('accepts a minimal valid expense', () => {
    expect(shortcutTransactionSchema.safeParse(validBody).success).toBe(true);
  });

  it('rejects anything other than an expense that is already paid', () => {
    expect(shortcutTransactionSchema.safeParse({ ...validBody, kind: 'income' }).success).toBe(false);
    expect(shortcutTransactionSchema.safeParse({ ...validBody, kind: 'transfer' }).success).toBe(false);
    expect(shortcutTransactionSchema.safeParse({ ...validBody, paid: false }).success).toBe(false);
  });

  it('rejects unknown fields, non-positive amounts, and future dates beyond the tolerance', () => {
    expect(shortcutTransactionSchema.safeParse({ ...validBody, paid_at: 'x' }).success).toBe(false);
    expect(shortcutTransactionSchema.safeParse({ ...validBody, amount: { minorUnits: 0, currency: 'BRL' } }).success).toBe(false);
    expect(shortcutTransactionSchema.safeParse({ ...validBody, amount: { minorUnits: -5, currency: 'BRL' } }).success).toBe(false);
    const farFuture = new Date(Date.now() + (60 * 60 * 1000)).toISOString();
    expect(shortcutTransactionSchema.safeParse({ ...validBody, occurredAt: farFuture }).success).toBe(false);
  });

  it('rejects an invalid IANA timezone', () => {
    expect(shortcutTransactionSchema.safeParse({ ...validBody, timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});
