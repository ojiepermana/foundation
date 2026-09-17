# User, auth dan passkey

**Status**: Superseded by [0008](../0008-email-link-auth/index.md)
**Date**: 2026-09-16

## Summary
Implementasi keputusan yang disetujui pengguna. Cakupan AC: AUTH-001, AUTH-002, AUTH-003, USER-001, PASSKEY-001.

## Requirements dan design
AUTH-001: bun run user:register --name --email --role admin|user membuat akun pending dan email aktivasi dalam transaksi. Email dinormalisasi; duplikat menghasilkan kegagalan CLI tanpa membuat akun tambahan. bun run user:resend-activation --email hanya mengirim ulang akun pending, membatalkan token sebelumnya.

AUTH-002: tautan /activate#token=... berlaku24jam dan sekali pakai. Password12..128karakter dihash Argon2id melalui Bun.password (memory64MiB,time3). Login menerima email/password, hanya akun active. Session token random32byte memakai cookie HttpOnly, SameSite=Lax, Path=/ dan Secure pada HTTPS. Digest SHA256 berada di DB; TTL absolut7hari. CSRF token diturunkan dengan SHA256 dari token session dan domain separator, dikirim melalui response session, dibandingkan konstan waktunya. Mutasi wajib origin APP_URL; mutasi authenticated juga X-CSRF-Token. Cookie bukan sumber role; DB memeriksa status/role setiap request.

AUTH-003: logout mencabut session. Forgot password selalu memberi respons generik. Token reset30menit, sekali pakai, seluruh session dicabut saat reset. Perubahan password melalui profil mencabut seluruh session dan memberi session baru. Reauthentication password memberi jendela 5 menit untuk mutasi passkey. Login passkey membuat session tanpa konfirmasi password terbaru; konfirmasi password tetap diwajibkan sebelum mutasi kredensial. Pembatasan percobaan per IP peer terpercaya dan digest email menggunakan Redis atomic window; Redis gagal membuat auth mutation gagal tertutup dengan503, bukan melewati limiter.

USER-001: GET /users hanya admin dengan search dan pagination1..100; PATCH /users/:id menerima name, role, status active/disabled. Admin aktif terakhir tidak dapat diturunkan atau dinonaktifkan, termasuk permintaan bersamaan. Disable mencabut session. PATCH /me hanya nama; pengguna tidak dapat mengubah role dirinya melalui profil. Semua mutasi sensitif dicatat dengan metadata terbatas.

PASSKEY-001: SimpleWebAuthn14 memverifikasi kriptografi. Registration menggunakan residentKey required, userVerification required, attestation none, userHandle berbasis UUID. Challenge5menit terikat session/user dan sekali pakai. Authentication discoverable memakai challengeId dan credential id, memverifikasi userHandle, origin, RP ID, UV, counter, dan account active. Counter nol yang sah pada synced passkey mengikuti verifier. Public key dan counter disimpan PostgreSQL. Credential list/revoke dibatasi pemilik.

| Method | Path relatif /api/v1 | Input / hasil |
|---|---|---|
| POST | /auth/login | email,password -> SessionData |
| GET | /auth/session | cookie -> SessionData |
| POST | /auth/logout | CSRF -> ok |
| POST | /auth/activate | token,password -> ok |
| POST | /auth/forgot-password | email -> pesan generik |
| POST | /auth/reset-password | token,password -> ok |
| POST | /auth/reauthenticate | password -> ok |
| PATCH | /me | name -> User |
| POST | /me/password | currentPassword,password -> SessionData |
| GET | /me/passkeys | Passkey[] |
| POST | /me/passkeys/options | registration options |
| POST | /me/passkeys/verify | response,name -> ok |
| DELETE | /me/passkeys/:id | pemilik+reauth -> ok |
| POST | /auth/passkey/options | challengeId,options |
| POST | /auth/passkey/verify | challengeId,response -> SessionData |
| GET/PATCH | /users, /users/:id | admin, DTO aman |

Tidak ada registrasi publik, OAuth, tenant, atau password di argumen CLI. Public request bodies dibatasi dan divalidasi. Token tidak berada dalam query URL atau log.

## Decision
Kontrak di atas disetujui dalam rencana Foundation. Default berasal dari rencana dan konfigurasi aplikasi; secret berasal dari environment.

## Build plan
* [x] Implementasikan kontrak dan batas otorisasi (AUTH-001, AUTH-002, AUTH-003, USER-001, PASSKEY-001).
* [x] Tambahkan pemeriksaan otomatis untuk hasil normal, input salah, dan kegagalan layanan (AUTH-001, AUTH-002, AUTH-003, USER-001, PASSKEY-001).
* [ ] Jalankan verifikasi nyata dan catat bukti di matriks AC (AUTH-001, AUTH-002, AUTH-003, USER-001, PASSKEY-001).

## Consequences
Pemeriksaan otomatis tidak membuktikan kompatibilitas perangkat fisik. Bukti yang belum diperoleh tetap pending.

## Follow-up
Deployment dan fitur yang ditunda tidak termasuk versi ini. Review spec independen dilewati sesuai pilihan pengguna; review kode auth tetap diperlukan.

## Rationale
Reasoning dan sumber: [rationale.md](rationale.md).

## Evidence
Implementasi, skenario uji, hasil dan batas bukti: [matriks AC](../../../verification/ac-matrix.md). Verifikasi perangkat fisik belum dilakukan; status GA belum ditutup.
