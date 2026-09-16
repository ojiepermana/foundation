import type { SQL } from 'bun';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Config } from './config';
import type { SqlClient } from './db';
import type { User } from '../shared/contracts';
import { AppError, assert } from './errors';
import { csrfFor, digest, hashPassword, normalizeEmail, token, validateName, validatePassword } from './security';
import { actionMail, enqueueMail } from './mail';

export interface Identity { user: User; sessionId: string; rawToken: string; reauthenticatedAt: Date }
export interface IssuedSession { user: User; csrfToken: string; rawToken: string }
const safeUser = (row: any): User => ({ id: row.id, name: row.name, email: row.email, role: row.role, status: row.status, createdAt: new Date(row.created_at).toISOString() });
const expires = (seconds: number) => new Date(Date.now() + seconds * 1000);

export class AuthService {
  private dummyHash = hashPassword(token());
  constructor(public readonly db: SQL, public readonly config: Config) {}

  async audit(tx: SqlClient, actorId: string | null, event: string, subjectId: string, details = {}) {
    await tx`INSERT INTO audit_events (id, actor_id, event, subject_id, details) VALUES (${crypto.randomUUID()}, ${actorId}, ${event}, ${subjectId}, ${JSON.stringify(details)}::jsonb)`;
  }

  async register(input: { name: string; email: string; role: string }) {
    const name = validateName(input.name); const email = normalizeEmail(input.email);
    assert(input.role === 'admin' || input.role === 'user', 422, 'VALIDATION', 'Role harus admin atau user.');
    const id = crypto.randomUUID();
    try {
      return await this.db.begin(async tx => {
        const [user] = await tx`INSERT INTO users (id, name, email, role) VALUES (${id}, ${name}, ${email}, ${input.role}) RETURNING *`;
        await this.issueAction(tx, user, 'activation');
        await this.audit(tx, null, 'user.registered.cli', id, { role: input.role });
        return safeUser(user);
      });
    } catch (error: any) {
      if (error.errno === '23505') throw new AppError(409, 'EMAIL_EXISTS', 'Alamat email sudah terdaftar.');
      throw error;
    }
  }

  private async issueAction(tx: SqlClient, user: any, purpose: 'activation' | 'reset') {
    const raw = token();
    await tx`UPDATE action_tokens SET consumed_at = now() WHERE user_id = ${user.id} AND purpose = ${purpose} AND consumed_at IS NULL`;
    await tx`INSERT INTO action_tokens (id, user_id, purpose, token_hash, expires_at) VALUES (${crypto.randomUUID()}, ${user.id}, ${purpose}, ${digest(raw)}, ${expires(purpose === 'activation' ? this.config.activationSeconds : this.config.resetSeconds)})`;
    await enqueueMail(tx, this.config, actionMail({ name: user.name, email: user.email, token: raw, purpose, appUrl: this.config.appUrl }));
  }

  async resendActivation(email: string) {
    const normalized = normalizeEmail(email);
    await this.db.begin(async tx => {
      const [user] = await tx`SELECT * FROM users WHERE email = ${normalized} FOR UPDATE`;
      assert(user?.status === 'pending', 422, 'INVALID_ACCOUNT', 'Pengiriman ulang hanya untuk akun yang menunggu aktivasi.');
      await this.issueAction(tx, user, 'activation');
    });
  }

  async forgotPassword(email: string) {
    const normalized = normalizeEmail(email);
    await this.db.begin(async tx => {
      const [user] = await tx`SELECT * FROM users WHERE email = ${normalized} AND status = 'active' FOR UPDATE`;
      if (user) await this.issueAction(tx, user, 'reset');
    });
  }

  async completeAction(raw: string, password: string, purpose: 'activation' | 'reset') {
    validatePassword(password);
    assert(/^[A-Za-z0-9_-]{43}$/.test(raw), 400, 'INVALID_TOKEN', 'Tautan tidak valid atau sudah kedaluwarsa.');
    const passwordHash = await hashPassword(password);
    await this.db.begin(async tx => {
      // Lock the user before the token, consistently with action issuance and password changes.
      const [candidate] = await tx`SELECT user_id FROM action_tokens WHERE token_hash = ${digest(raw)} AND purpose = ${purpose}`;
      assert(candidate, 400, 'INVALID_TOKEN', 'Tautan tidak valid atau sudah kedaluwarsa.');
      const [user] = await tx`SELECT * FROM users WHERE id = ${candidate.user_id} FOR UPDATE`;
      const [action] = await tx`SELECT * FROM action_tokens WHERE token_hash = ${digest(raw)} AND purpose = ${purpose} AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`;
      assert(action && user.status === (purpose === 'activation' ? 'pending' : 'active'), 400, 'INVALID_TOKEN', 'Tautan tidak valid atau sudah kedaluwarsa.');
      await tx`UPDATE users SET password_hash = ${passwordHash}, status = 'active', activated_at = COALESCE(activated_at, now()), updated_at = now() WHERE id = ${user.id}`;
      await tx`UPDATE action_tokens SET consumed_at = now() WHERE user_id = ${user.id} AND consumed_at IS NULL`;
      await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${user.id} AND revoked_at IS NULL`;
      await this.audit(tx, user.id, `auth.${purpose}.completed`, user.id);
    });
  }

  private async issueSession(tx: SqlClient, row: any, passwordAuthenticated: boolean): Promise<IssuedSession> {
    const rawToken = token();
    await tx`INSERT INTO sessions (id, user_id, token_hash, expires_at, reauthenticated_at) VALUES (${crypto.randomUUID()}, ${row.id}, ${digest(rawToken)}, ${expires(this.config.sessionSeconds)}, ${passwordAuthenticated ? new Date() : new Date(0)})`;
    return { user: safeUser(row), rawToken, csrfToken: csrfFor(rawToken) };
  }

  async login(email: string, password: string) {
    const normalized = normalizeEmail(email);
    const [candidate] = await this.db`SELECT * FROM users WHERE email = ${normalized}`;
    const valid = await Bun.password.verify(password, candidate?.password_hash ?? await this.dummyHash);
    assert(valid && candidate?.status === 'active', 401, 'INVALID_CREDENTIALS', 'Email atau password tidak sesuai.');
    return this.db.begin(async tx => {
      const [user] = await tx`SELECT * FROM users WHERE id = ${candidate.id} FOR UPDATE`;
      assert(user.status === 'active' && user.password_hash === candidate.password_hash, 401, 'INVALID_CREDENTIALS', 'Email atau password tidak sesuai.');
      await this.audit(tx, user.id, 'auth.login.password', user.id);
      return this.issueSession(tx, user, true);
    });
  }

  async identity(rawToken?: string): Promise<Identity> {
    assert(rawToken && /^[A-Za-z0-9_-]{43}$/.test(rawToken), 401, 'UNAUTHENTICATED', 'Silakan masuk terlebih dahulu.');
    const [row] = await this.db`SELECT u.*, s.id AS session_id, s.reauthenticated_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ${digest(rawToken)} AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`;
    assert(row, 401, 'UNAUTHENTICATED', 'Session berakhir. Silakan masuk kembali.');
    return { user: safeUser(row), sessionId: row.session_id, rawToken, reauthenticatedAt: new Date(row.reauthenticated_at) };
  }

  private async lockIdentity(tx: SqlClient, identity: Identity) {
    const [user] = await tx`SELECT * FROM users WHERE id = ${identity.user.id} FOR UPDATE`;
    const [session] = await tx`SELECT * FROM sessions WHERE id = ${identity.sessionId} AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`;
    assert(user?.status === 'active' && session, 401, 'UNAUTHENTICATED', 'Session berakhir. Silakan masuk kembali.');
    return { user, session };
  }

  async logout(identity: Identity) {
    await this.db`UPDATE sessions SET revoked_at = now() WHERE id = ${identity.sessionId}`;
  }

  async reauthenticate(identity: Identity, password: string) {
    const [candidate] = await this.db`SELECT password_hash FROM users WHERE id = ${identity.user.id}`;
    assert(candidate && await Bun.password.verify(password, candidate.password_hash), 401, 'INVALID_CREDENTIALS', 'Password tidak sesuai.');
    await this.db.begin(async tx => {
      const { user } = await this.lockIdentity(tx, identity);
      assert(user.password_hash === candidate.password_hash, 401, 'UNAUTHENTICATED', 'Password sudah berubah.');
      await tx`UPDATE sessions SET reauthenticated_at = now() WHERE id = ${identity.sessionId}`;
    });
  }

  async updateProfile(identity: Identity, name: string) {
    const normalized = validateName(name);
    return this.db.begin(async tx => {
      await this.lockIdentity(tx, identity);
      const [user] = await tx`UPDATE users SET name = ${normalized}, updated_at = now() WHERE id = ${identity.user.id} RETURNING *`;
      return safeUser(user);
    });
  }

  async changePassword(identity: Identity, currentPassword: string, password: string) {
    validatePassword(password);
    const [candidate] = await this.db`SELECT password_hash FROM users WHERE id = ${identity.user.id}`;
    assert(candidate && await Bun.password.verify(currentPassword, candidate.password_hash), 400, 'INVALID_CREDENTIALS', 'Password saat ini tidak sesuai.');
    const hashed = await hashPassword(password);
    return this.db.begin(async tx => {
      const { user } = await this.lockIdentity(tx, identity);
      assert(user.password_hash === candidate.password_hash, 409, 'PASSWORD_CHANGED', 'Password sudah berubah. Muat ulang dan coba kembali.');
      await tx`UPDATE users SET password_hash = ${hashed}, updated_at = now() WHERE id = ${user.id}`;
      await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${user.id} AND revoked_at IS NULL`;
      await tx`UPDATE action_tokens SET consumed_at = now() WHERE user_id = ${user.id} AND consumed_at IS NULL`;
      await this.audit(tx, user.id, 'auth.password.changed', user.id);
      return this.issueSession(tx, user, true);
    });
  }

  async listUsers(identity: Identity, page: number, limit: number, search: string) {
    assert(identity.user.role === 'admin', 403, 'FORBIDDEN', 'Akses hanya untuk administrator.');
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.begin(async tx => {
      const { user } = await this.lockIdentity(tx, identity);
      assert(user.role === 'admin', 403, 'FORBIDDEN', 'Akses hanya untuk administrator.');
      const rows = await tx`SELECT * FROM users WHERE name ILIKE ${pattern} OR email ILIKE ${pattern} ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
      const [count] = await tx`SELECT count(*)::int AS total FROM users WHERE name ILIKE ${pattern} OR email ILIKE ${pattern}`;
      return { data: rows.map(safeUser), meta: { total: count.total, page, limit } };
    });
  }

  async updateUser(identity: Identity, id: string, input: { name?: string; role?: 'admin' | 'user'; status?: 'active' | 'disabled' }) {
    assert(identity.user.role === 'admin', 403, 'FORBIDDEN', 'Akses hanya untuk administrator.');
    return this.db.begin(async tx => {
      // Serialize all admin role/status changes before any user row lock.
      await tx`SELECT pg_advisory_xact_lock(884282)`;
      const { user: actor } = await this.lockIdentity(tx, identity);
      assert(actor.role === 'admin', 403, 'FORBIDDEN', 'Akses hanya untuk administrator.');
      const [target] = await tx`SELECT * FROM users WHERE id = ${id} FOR UPDATE`;
      assert(target, 404, 'NOT_FOUND', 'Pengguna tidak ditemukan.');
      const name = input.name === undefined ? target.name : validateName(input.name);
      const role = input.role ?? target.role; const status = input.status ?? target.status;
      assert(status !== 'active' || target.password_hash, 422, 'ACTIVATION_REQUIRED', 'Pengguna perlu menyelesaikan aktivasi email.');
      if (target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active')) {
        const [count] = await tx`SELECT count(*)::int AS total FROM users WHERE role = 'admin' AND status = 'active'`;
        assert(count.total > 1, 409, 'LAST_ADMIN', 'Administrator aktif terakhir tidak dapat dinonaktifkan atau diturunkan.');
      }
      const [updated] = await tx`UPDATE users SET name = ${name}, role = ${role}, status = ${status}, updated_at = now() WHERE id = ${id} RETURNING *`;
      if (status === 'disabled') await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${id} AND revoked_at IS NULL`;
      await this.audit(tx, actor.id, 'user.updated', id, { role, status });
      return safeUser(updated);
    });
  }

  private requireRecent(session: any) {
    assert(Date.now() - new Date(session.reauthenticated_at).getTime() < 300_000, 403, 'REAUTH_REQUIRED', 'Konfirmasi password terlebih dahulu.');
  }

  async listPasskeys(identity: Identity) {
    const rows = await this.db`SELECT id, name, created_at, last_used_at FROM passkey_credentials WHERE user_id = ${identity.user.id} ORDER BY created_at DESC`;
    return rows.map((row: any) => ({ id: row.id, name: row.name, createdAt: new Date(row.created_at).toISOString(), lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null }));
  }

  async registrationOptions(identity: Identity) {
    return this.db.begin(async tx => {
      const { user, session } = await this.lockIdentity(tx, identity); this.requireRecent(session);
      const credentials = await tx`SELECT id, transports FROM passkey_credentials WHERE user_id = ${user.id}`;
      assert(credentials.length < 20, 409, 'PASSKEY_LIMIT', 'Maksimal 20 passkey per akun.');
      const options = await generateRegistrationOptions({ rpName: this.config.rpName, rpID: this.config.rpId, userName: user.email, userDisplayName: user.name, userID: new TextEncoder().encode(user.id), attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: credentials.map((row: any) => ({ id: row.id, transports: row.transports })) });
      await tx`UPDATE webauthn_challenges SET consumed_at = now() WHERE session_id = ${session.id} AND purpose = 'registration' AND consumed_at IS NULL`;
      await tx`INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, session_id, expires_at) VALUES (${crypto.randomUUID()}, ${options.challenge}, 'registration', ${user.id}, ${session.id}, ${expires(this.config.challengeSeconds)})`;
      return options;
    });
  }

  async verifyRegistration(identity: Identity, response: RegistrationResponseJSON, name: string) {
    const normalized = validateName(name);
    await this.db.begin(async tx => {
      const { user, session } = await this.lockIdentity(tx, identity); this.requireRecent(session);
      const [challenge] = await tx`SELECT * FROM webauthn_challenges WHERE session_id = ${session.id} AND purpose = 'registration' AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      assert(challenge, 400, 'INVALID_CHALLENGE', 'Permintaan passkey kedaluwarsa. Coba kembali.');
      let verification;
      try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.webauthnOrigin, expectedRPID: this.config.rpId, requireUserVerification: true }); }
      catch { throw new AppError(400, 'INVALID_PASSKEY', 'Passkey tidak dapat diverifikasi.'); }
      assert(verification.verified && verification.registrationInfo, 400, 'INVALID_PASSKEY', 'Passkey tidak dapat diverifikasi.');
      const info = verification.registrationInfo;
      const [count] = await tx`SELECT count(*)::int AS total FROM passkey_credentials WHERE user_id = ${user.id}`;
      assert(count.total < 20, 409, 'PASSKEY_LIMIT', 'Maksimal 20 passkey per akun.');
      await tx`INSERT INTO passkey_credentials (id,user_id,name,public_key,counter,transports,device_type,backed_up) VALUES (${info.credential.id},${user.id},${normalized},${Buffer.from(info.credential.publicKey)},${info.credential.counter},${JSON.stringify(info.credential.transports ?? [])}::jsonb,${info.credentialDeviceType},${info.credentialBackedUp})`;
      await tx`UPDATE webauthn_challenges SET consumed_at = now() WHERE id = ${challenge.id}`;
      await this.audit(tx, user.id, 'passkey.registered', user.id);
    });
  }

  async removePasskey(identity: Identity, id: string) {
    await this.db.begin(async tx => {
      const { user, session } = await this.lockIdentity(tx, identity); this.requireRecent(session);
      const rows = await tx`DELETE FROM passkey_credentials WHERE id = ${id} AND user_id = ${user.id} RETURNING id`;
      assert(rows.length, 404, 'NOT_FOUND', 'Passkey tidak ditemukan.');
      await this.audit(tx, user.id, 'passkey.deleted', user.id);
    });
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.config.rpId, userVerification: 'required' });
    const challengeId = crypto.randomUUID();
    await this.db`INSERT INTO webauthn_challenges (id, challenge, purpose, expires_at) VALUES (${challengeId}, ${options.challenge}, 'authentication', ${expires(this.config.challengeSeconds)})`;
    return { challengeId, options };
  }

  async verifyAuthentication(challengeId: string, response: AuthenticationResponseJSON) {
    return this.db.begin(async tx => {
      const [candidate] = await tx`SELECT user_id FROM passkey_credentials WHERE id = ${response.id}`;
      assert(candidate, 401, 'INVALID_PASSKEY', 'Passkey tidak dapat digunakan.');
      const [user] = await tx`SELECT * FROM users WHERE id = ${candidate.user_id} FOR UPDATE`;
      const [credential] = await tx`SELECT * FROM passkey_credentials WHERE id = ${response.id} FOR UPDATE`;
      const [challenge] = await tx`SELECT * FROM webauthn_challenges WHERE id = ${challengeId} AND purpose = 'authentication' AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`;
      assert(user?.status === 'active' && credential && challenge, 401, 'INVALID_PASSKEY', 'Passkey tidak dapat digunakan atau permintaan kedaluwarsa.');
      const handle = response.response.userHandle;
      assert(handle && Buffer.from(handle, 'base64url').toString() === user.id, 401, 'INVALID_PASSKEY', 'Passkey tidak dapat digunakan.');
      let verification;
      try { verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.webauthnOrigin, expectedRPID: this.config.rpId, requireUserVerification: true, credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: Number(credential.counter), transports: credential.transports } }); }
      catch { throw new AppError(401, 'INVALID_PASSKEY', 'Passkey tidak dapat diverifikasi.'); }
      assert(verification.verified, 401, 'INVALID_PASSKEY', 'Passkey tidak dapat diverifikasi.');
      await tx`UPDATE passkey_credentials SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = now() WHERE id = ${credential.id}`;
      await tx`UPDATE webauthn_challenges SET consumed_at = now() WHERE id = ${challenge.id}`;
      await this.audit(tx, user.id, 'auth.login.passkey', user.id);
      return this.issueSession(tx, user, false);
    });
  }
}
