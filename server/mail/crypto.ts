const encoder = new TextEncoder();
const context = encoder.encode('foundation:mail-outbox:v1');

async function keyFromBase64(value: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  if (bytes.length !== 32) throw new Error('MAIL_ENCRYPTION_KEY');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptPayload(value: unknown, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: context },
    await keyFromBase64(key), encoder.encode(JSON.stringify(value)),
  );
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(encrypted).toString('base64')}`;
}

export async function decryptPayload<T>(value: string, key: string): Promise<T> {
  try {
    const [version, nonce, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !ciphertext || extra !== undefined) throw new Error();
    const iv = Uint8Array.from(Buffer.from(nonce, 'base64'));
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: context }, await keyFromBase64(key),
      Uint8Array.from(Buffer.from(ciphertext, 'base64')),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    // Never attach ciphertext or plaintext to errors sent to queue metadata/logs.
    throw new Error('MAIL_PAYLOAD_INVALID');
  }
}
