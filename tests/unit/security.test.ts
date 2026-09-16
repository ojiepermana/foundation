import { describe, expect, test } from 'bun:test';
import { csrfFor, digest, equal, normalizeEmail, token, validatePassword } from '../../server/security';
import { loadConfig } from '../../server/config';
import { redact } from '../../server/logger';
describe('auth primitives and config', () => {
  test('uses independent random tokens and stable cryptographic digests', () => {
    const a = token(); const b = token(); expect(a).not.toBe(b); expect(a).toHaveLength(43);
    expect(digest(a)).toHaveLength(64); expect(csrfFor(a)).not.toBe(digest(a)); expect(equal(a, a)).toBe(true); expect(equal(a, b)).toBe(false); expect(equal(a, '')).toBe(false);
  });
  test('normalizes identity and rejects malformed inputs', () => {
    expect(normalizeEmail('  TEST@Example.test ')).toBe('test@example.test'); expect(() => normalizeEmail('not-email')).toThrow();
    expect(() => validatePassword('short')).toThrow(); expect(() => validatePassword('x'.repeat(129))).toThrow(); expect(() => validatePassword('x'.repeat(12))).not.toThrow();
  });
  test('redacts nested credentials and payloads', () => {
    expect(redact({ requestId: 'id', auth: { password: 'secret', token: 'value' }, payload: { any: 'secret' } })).toEqual({ requestId: 'id', auth: { password: '[REDACTED]', token: '[REDACTED]' }, payload: '[REDACTED]' });
  });
  test('rejects missing encryption key and unsafe production origin', () => {
    const env = { DATABASE_URL: 'postgres://localhost/test', REDIS_URL: 'redis://localhost:6379', APP_URL: 'http://localhost:8088', SMTP_HOST: 'localhost', SMTP_FROM: 'test@example.test', APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(loadConfig(env).apiPort).toBe(8888); expect(loadConfig(env).sessionSeconds).toBe(604800);
    expect(() => loadConfig({ ...env, APP_ENCRYPTION_KEY: '' })).toThrow();
    expect(() => loadConfig({ ...env, NODE_ENV: 'production' })).toThrow();
    expect(() => loadConfig({ ...env, REDIS_PREFIX: '*' })).toThrow();
    expect(() => loadConfig({ ...env, APP_URL: 'http://localhost/a' })).toThrow();
  });
});
