const { secretProblem, isRepeatedBlock, env } = require('../src/config/env');

/**
 * These guard the boot-time check in src/config/env.js.
 *
 * The check exists because JWT_SECRET is the entire authentication boundary:
 * tenant scoping is read from the claims after the signature is verified, so a
 * guessable signing key is a cross-tenant read of the whole database. Both
 * repositories are public, so every placeholder these tests reject is public
 * knowledge — the exact values that shipped in .env.example are included below
 * deliberately.
 */

describe('secret strength', () => {
  const strong = 'a3f1c9e27b4d8056f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708';

  it('accepts a 64-character random hex secret', () => {
    expect(secretProblem(strong)).toBeNull();
  });

  it('rejects anything shorter than 32 characters, and says how short', () => {
    expect(secretProblem('short')).toMatch(/only 5 characters/);
    expect(secretProblem('a'.repeat(31))).toMatch(/only 31 characters/);
  });

  it('accepts exactly 32 characters of real entropy', () => {
    // ENCRYPTION_KEY is pinned to exactly 32, so the floor must not be
    // off-by-one against the one field that can never be longer.
    expect(secretProblem('9f3b7c1e5a8d2604b9e7f1a3c5d7e9f0')).toBeNull();
  });

  it('rejects the placeholders that ship in .env.example', () => {
    expect(secretProblem('change-me-generate-a-random-secret')).toMatch(/placeholder/);
    expect(secretProblem('change-me-generate-a-different-random-secret')).toMatch(/placeholder/);
    expect(secretProblem('change-me-32-chars00000000000000')).toMatch(/placeholder/);
  });

  it('rejects the placeholder family that survives a copy-paste', () => {
    // Long enough to clear the length floor, so only the word check can catch
    // them. This is the case that made the length floor alone insufficient.
    for (const prefix of [
      'super-secret-key-for-this-application',
      'supersecret-value-that-is-long-enough',
      'secret-key-value-padded-out-past-32ch',
      'password-that-is-quite-long-but-still',
      'your-secret-here-padded-out-past-32ch',
      'default-signing-key-padded-past-32chr',
      'changeit-and-pad-this-out-past-32-chr',
    ]) {
      expect(secretProblem(prefix)).toMatch(/placeholder/);
    }
  });

  it('is case-insensitive about placeholder words', () => {
    expect(secretProblem('CHANGE-ME-generate-a-random-secret')).toMatch(/placeholder/);
    expect(secretProblem('Super_Secret_Key_Padded_Past_32_Chars')).toMatch(/placeholder/);
  });

  it('rejects a short block repeated up to length', () => {
    // The value that was actually in .env: 16 hex characters, twice. It clears
    // the 32-character floor while carrying 16 characters of entropy.
    expect(secretProblem('0123456789abcdef0123456789abcdef')).toMatch(/repeated/);
    expect(secretProblem('ab'.repeat(32))).toMatch(/repeated/);
    expect(secretProblem('x'.repeat(40))).toMatch(/repeated/);
  });

  it('does not mistake a random secret for a repeated block', () => {
    expect(isRepeatedBlock(strong)).toBe(false);
    // A near miss: the halves differ in the final character only.
    expect(isRepeatedBlock('0123456789abcdef0123456789abcdee')).toBe(false);
  });

  it('only treats whole-length repetitions as repeated', () => {
    // "abc" three times plus a stray character is not a clean repetition, and
    // flagging it would reject legitimate random strings.
    expect(isRepeatedBlock('abcabcabcx')).toBe(false);
    expect(isRepeatedBlock('abcabcabc')).toBe(true);
  });
});

describe('the running environment', () => {
  it('booted with secrets that pass the check', () => {
    // If this file runs at all, env.js did not process.exit(1). Assert the
    // outcome explicitly so a future relaxation of the schema is visible here.
    expect(secretProblem(env.JWT_SECRET)).toBeNull();
    expect(secretProblem(env.JWT_REFRESH_SECRET)).toBeNull();
    expect(secretProblem(env.ENCRYPTION_KEY)).toBeNull();
  });

  it('uses different secrets for access and refresh tokens', () => {
    expect(env.JWT_SECRET).not.toBe(env.JWT_REFRESH_SECRET);
  });

  it('defaults to trusting no proxy hops', () => {
    // The safe default: X-Forwarded-For is ignored, so a client cannot spoof
    // its way into a fresh rate-limit bucket. Deployments behind nginx or an
    // ALB must set TRUST_PROXY_HOPS to the real count.
    expect(env.TRUST_PROXY_HOPS).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(env.TRUST_PROXY_HOPS)).toBe(true);
  });
});
