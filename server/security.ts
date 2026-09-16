import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';
export function token() { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); }
export function digest(value: string) { return new Bun.CryptoHasher('sha256').update(value).digest('hex'); }
export function csrfFor(sessionToken: string) { return digest(`foundation:csrf:${sessionToken}`); }
export function equal(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function normalizeEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new AppError(422, 'VALIDATION', 'Alamat email tidak valid.', { email: 'Masukkan alamat email yang valid.' });
  return normalized;
}
export function validateName(value: string) { const normalized = value.trim(); if (!normalized || normalized.length > 100) throw new AppError(422, 'VALIDATION', 'Nama harus berisi 1 sampai 100 karakter.'); return normalized; }
export function validatePassword(password: string) { if (password.length < 12 || password.length > 128) throw new AppError(422, 'VALIDATION', 'Password harus berisi 12 sampai 128 karakter.', { password: 'Gunakan 12 sampai 128 karakter.' }); }
export const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
export function readCookie(request: Request, name: string) { const match = request.headers.get('cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`)); return match?.slice(name.length + 1); }
