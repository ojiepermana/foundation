export interface Config {
  databaseUrl: string; redisUrl: string; redisPrefix: string; appUrl: string;
  apiPort: number; encryptionKey: string; production: boolean;
  smtp: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string };
  sessionSeconds: number; activationSeconds: number; resetSeconds: number; challengeSeconds: number;
  rpId: string; rpName: string; webauthnOrigin: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error(`Konfigurasi ${name} wajib diisi.`); return value; };
  const integer = (name: string, fallback: number) => { const value = Number(env[name] ?? fallback); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} harus bilangan bulat positif.`); return value; };
  const url = (name: string, schemes: string[]) => { const value = required(name); const parsed = new URL(value); if (!schemes.includes(parsed.protocol)) throw new Error(`Protokol ${name} tidak valid.`); return value; };
  const encryptionKey = required('APP_ENCRYPTION_KEY');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('APP_ENCRYPTION_KEY harus 32 byte dalam format base64.');
  const appUrl = url('APP_URL', ['http:', 'https:']).replace(/\/$/, '');
  const parsed = new URL(appUrl);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('APP_URL harus origin tanpa path atau kredensial.');
  const production = env['NODE_ENV'] === 'production';
  if (production && parsed.protocol !== 'https:') throw new Error('APP_URL produksi harus HTTPS.');
  const redisPrefix = env['REDIS_PREFIX'] ?? 'foundation';
  if (!/^[a-zA-Z0-9_-]+$/.test(redisPrefix)) throw new Error('REDIS_PREFIX hanya boleh berisi huruf, angka, underscore, dan tanda hubung.');
  return {
    databaseUrl: url('DATABASE_URL', ['postgres:', 'postgresql:']), redisUrl: url('REDIS_URL', ['redis:', 'rediss:']), redisPrefix,
    appUrl, apiPort: integer('API_PORT', 8888), encryptionKey, production,
    smtp: { host: required('SMTP_HOST'), port: integer('SMTP_PORT', 587), secure: env['SMTP_SECURE'] === 'true', user: env['SMTP_USER'] || undefined, password: env['SMTP_PASSWORD'] || undefined, from: required('SMTP_FROM') },
    sessionSeconds: integer('SESSION_TTL_SECONDS', 604800), activationSeconds: integer('ACTIVATION_TTL_SECONDS', 86400),
    resetSeconds: integer('RESET_TTL_SECONDS', 1800), challengeSeconds: integer('PASSKEY_CHALLENGE_TTL_SECONDS', 300),
    rpId: env['WEBAUTHN_RP_ID'] || parsed.hostname, rpName: env['WEBAUTHN_RP_NAME'] || 'Foundation', webauthnOrigin: appUrl,
  };
}
