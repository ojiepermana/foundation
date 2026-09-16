# Data model

**Status**: Implemented and verified within recorded scope
**Date**: 2026-09-16

## Summary
Implementasi keputusan yang disetujui pengguna. Cakupan AC: FND-003, AUTH-001, MAIL-001.

## Requirements dan design
PostgreSQL adalah sumber kebenaran akun, kredensial, session, token, challenge, audit dan outbox. Migrasi SQL berurutan memiliki SHA256, tabel schema_migrations, advisory lock per koneksi, dan transaksi per file. Perubahan schema dilakukan dengan migrasi baru.

| Entitas | Kunci dan relasi | Aturan |
|---|---|---|
| users | UUID id | name 1..100, email lowercase unik, role admin/user, status pending/active/disabled, password_hash nullable hanya sebelum aktif |
| sessions | UUID id, user_id 1:N | token_hash unik, expiry, revoked_at, reauthenticated_at |
| action_tokens | UUID id, user_id 1:N | purpose activation/reset, digest unik, expiry, consumed_at |
| passkey_credentials | credential id text, user_id 1:N | public_key bytea, counter, transports, name, device_type, backed_up, last_used_at |
| webauthn_challenges | UUID id, user_id dan session_id nullable | registration wajib terikat pengguna/session, nonce unik, expiry, consumed_at |
| mail_outbox | UUID id | payload terenkripsi, status, attempts, due time, lease token/expiry, queued/sent timestamps |
| audit_events | UUID id, actor nullable | event, subject, metadata terbatas tanpa secret |

Timestamp menggunakan timestamptz UTC. Nilai UI berasal dari DTO users dan passkey_credentials, bukan token browser. Transisi akun pending ke active hanya saat aktivasi; disabled ke active memerlukan password yang sudah ditetapkan. Tidak ada penghapusan user permanen atau perubahan email pada versi awal.

Registrasi menyimpan user, token digest, dan encrypted mail_outbox dalam satu transaksi. Token dikonsumsi dengan lock baris bersama perubahan password/session. Perubahan role/status admin memakai advisory transaction lock untuk melindungi admin aktif terakhir. Model awal berada di migrasi 0001; migrasi 0002 menetapkan default reauthenticated_at ke epoch agar session baru tidak memperoleh konfirmasi password implisit. Tes memverifikasi constraint dan rollback.

## Decision
Kontrak di atas disetujui dalam rencana Foundation. Default berasal dari rencana dan konfigurasi aplikasi; secret berasal dari environment.

## Build plan
* [x] Implementasikan kontrak dan batas otorisasi (FND-003, AUTH-001, MAIL-001).
* [x] Tambahkan pemeriksaan otomatis untuk hasil normal, input salah, dan kegagalan layanan (FND-003, AUTH-001, MAIL-001).
* [x] Jalankan verifikasi nyata dan catat bukti di matriks AC (FND-003, AUTH-001, MAIL-001).

## Consequences
Pemeriksaan otomatis tidak membuktikan kompatibilitas perangkat fisik. Bukti yang belum diperoleh tetap pending.

## Follow-up
Deployment dan fitur yang ditunda tidak termasuk versi ini. Review spec independen dilewati sesuai pilihan pengguna; review kode auth tetap diperlukan.

## Rationale
Pilihan mengikuti keputusan pengguna agar memakai Bun native dan kontrak library resmi. Referensi: https://www.postgresql.org/docs/18/ddl-constraints.html.

## Evidence
Implementasi, skenario uji, hasil dan batas bukti: [matriks AC](../../verification/ac-matrix.md).
