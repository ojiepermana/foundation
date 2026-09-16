import { describe, expect, test } from 'bun:test';
import { encryptPayload, decryptPayload } from '../../server/mail/crypto';
import { actionMail, mailErrorCode } from '../../server/mail';
import { validateMessage } from '../../server/mail/templates';

const key = Buffer.alloc(32, 19).toString('base64');

describe('encrypted mail payload', () => {
  test('round trips with a fresh nonce and hides content', async () => {
    const message = { to: 'user@example.test', token: 'private-activation-token' };
    const first = await encryptPayload(message, key);
    const second = await encryptPayload(message, key);
    expect(first).not.toBe(second);
    expect(first).not.toContain(message.to);
    expect(first).not.toContain(message.token);
    expect(await decryptPayload<typeof message>(first, key)).toEqual(message);
  });

  test('rejects tampering, a wrong key, and unknown envelope versions', async () => {
    const encrypted = await encryptPayload({ secret: 'hidden' }, key);
    const parts = encrypted.split('.');
    const bytes = Buffer.from(parts[2]!, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    parts[2] = bytes.toString('base64');
    for (const input of [parts.join('.'), encrypted.replace('v1.', 'v2.'), 'garbage']) {
      expect(decryptPayload(input, key)).rejects.toThrow('MAIL_PAYLOAD_INVALID');
    }
    expect(decryptPayload(encrypted, Buffer.alloc(32, 23).toString('base64'))).rejects.toThrow('MAIL_PAYLOAD_INVALID');
  });
});

describe('action email', () => {
  test('uses fragment tokens and escapes user controlled markup', () => {
    const message = actionMail({ name: '<script>alert(1)</script>', email: 'user@example.test', token: 'secret+value', purpose: 'activation', appUrl: 'http://localhost:8088' });
    expect(message.text).toContain('http://localhost:8088/activate#token=secret%2Bvalue');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('?token=');
    expect(message.subject).toBe('Aktivasi akun Foundation');
    expect(() => validateMessage(message)).not.toThrow();
  });

  test('reset mail includes a text alternative and no executable content', () => {
    const message = actionMail({ name: 'Ojie', email: 'user@example.test', token: 'secret', purpose: 'reset', appUrl: 'https://foundation.example' });
    expect(message.text).toContain('/reset-password#token=secret');
    expect(message.text).toContain('Jika Anda tidak meminta');
    expect(message.html).toContain('lang="id"');
  });

  test('rejects address or subject header injection', () => {
    const base = { to: 'user@example.test', subject: 'Subject', text: 'Text', html: '<p>Text</p>' };
    expect(() => validateMessage({ ...base, subject: 'Subject\r\nBcc: private@example.test' })).toThrow('MAIL_MESSAGE_INVALID');
    expect(() => validateMessage({ ...base, to: 'user@example.test\n' })).toThrow('MAIL_MESSAGE_INVALID');
  });

  test('SMTP error handling never stores remote text or credentials', () => {
    expect(mailErrorCode({ code: 'EAUTH', message: 'secret user:password rejected' })).toBe('SMTP_EAUTH');
    expect(mailErrorCode(new Error('Server disclosed token=private'))).toBe('MAIL_DELIVERY_FAILED');
    expect(mailErrorCode({ code: 'PRIVATE_TOKEN' })).toBe('MAIL_DELIVERY_FAILED');
  });
});
