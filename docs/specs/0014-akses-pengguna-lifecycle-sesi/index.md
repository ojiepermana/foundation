# 0014. Akses pengguna dan lifecycle sesi

**Date**: 2026-10-06
**Status**: Accepted

## Summary

Alur pertama akses pengguna adalah masuk dan keluar dengan email dan password, melihat sesi aktif milik sendiri, dan mengakhiri salah satunya. Akun dibuat operator lewat perintah sekali jalan di image runner database, tanpa registrasi publik. Sesi disimpan di server (PostgreSQL schema `auth`) dan browser hanya memegang cookie `HttpOnly` berisi token acak; database hanya menyimpan hash token, password memakai Argon2id, dan setiap perubahan data dari browser wajib lolos pemeriksaan origin serta token CSRF (pelindung dari request palsu lintas situs). Spec ini juga mengisi hook fitur 15 dari spec 0013: perintah pencabutan seluruh sesi untuk restore dan insiden, beserta bukti bahwa sesi lama ditolak sesudah restore.

## Requirements

**User stories**:

- Sebagai pengguna yang akunnya dibuat operator, Anda dapat masuk dengan email dan password, melihat identitas dan sesi aktif Anda, mengakhiri sesi di perangkat lain, dan keluar, tanpa token tersimpan di browser storage.
- Sebagai operator, Anda dapat membuat akun, mengganti password akun (sekaligus mencabut sesinya), dan mencabut sesi satu akun atau seluruh akun lewat job runner yang aman diulang, termasuk sesudah restore backup.
- Sebagai pemilik release, Anda melihat bukti bahwa akses lintas pengguna ditolak backend, sesi kedaluwarsa dan dicabut ditolak, request lintas situs ditolak, percobaan berlebih dibatasi, dan credential tidak bocor pada response, log, maupun artefak test.

**Acceptance criteria**:

- **AC-1**: Model data. Runner migration spec 0005 menerapkan tepat sembilan file baru tabel *Migration* (satu statement per file, urutan global `0002` sampai `0010`), sehingga objek di tabel *Model data* ada dengan kolom, tipe, nullability, default, constraint, FK lintas schema, dan index persis seperti tabel itu, semuanya milik `foundation_owner`, tanpa row level security, trigger, atau schema baru. Rerun mencetak `Migrations: 0 applied, 10 skipped`. `REQUIRED_MIGRATION` di `apps/backend/src/features/health/health.queries.ts` menjadi `0010-auth-grant-backend-sign-in-attempts.sql` pada commit yang sama. Provisioning ulang sesudah migration tetap `verified`.
- **AC-2**: Privilege. Sesudah migration, `foundation_backend` mempunyai tepat privilege tabel *Matriks grant backend* (tingkat tabel dan kolom, tanpa grant option) dan tidak lebih: pada PostgreSQL 18 nyata, setiap baris "diizinkan" berhasil dan setiap baris "ditolak" gagal dengan `permission denied`, termasuk `INSERT` ke `users.users`, `SELECT created_at` dari `users.users`, `UPDATE` atau `INSERT` ke `auth.password_credentials`, `DELETE` dan `TRUNCATE` pada `auth.sessions`, `SELECT revoked_reason` dari `auth.sessions`, DDL pada `users` dan `auth`, serta `SET ROLE foundation_owner`. `PUBLIC` tidak mendapat privilege apa pun pada keempat tabel. `foundation_backup` tetap membaca keempat tabel hanya sesudah `SET ROLE pg_read_all_data`. Tidak ada role baru.
- **AC-3**: Perintah operator. `database/accounts.ts` (root script `db:accounts`, dan perintah `migrate` di image runner) menerima tepat bentuk tabel *Perintah operator*, memeriksa masukan menurut urutan *Prioritas galat* tabel itu sebelum membuka koneksi, memakai `FOUNDATION_MIGRATOR_DATABASE_URL` dengan pemeriksaan identitas, lock `(638727, 5)` dan `(638727, 6)`, `SET LOCAL ROLE foundation_owner`, dan syarat semua migration terapan yang sama dengan seed spec 0005, lalu menghasilkan keluaran, stream, dan exit tepat tabel itu. Password akun hanya dibaca dari `FOUNDATION_ACCOUNT_PASSWORD`, wajib memenuhi aturan *Password* tabel *Kebijakan* untuk penetapan, dan disimpan sebagai hash Argon2id `m=19456,t=2,p=1` dari bentuk NFKC nya; nama tampilan wajib memenuhi aturan *Nama tampilan* tanpa pemotongan diam diam. `set-password` dan `revoke-sessions --email` mengambil lock per akun yang sama dengan transaksi masuk; `set-password` menulis `password_hash` dan `updated_at = transaction_timestamp()` lalu mencabut seluruh sesi aktif akun itu dalam transaksi yang sama, sehingga masuk yang memverifikasi password lama tidak dapat membuat sesi sesudahnya (AC-4). `create` untuk email yang sudah ada keluar 1 dengan `Account exists` tanpa perubahan apa pun. `revoke-sessions --all` aman diulang: run kedua mencetak `Sessions revoked: 0` dan keluar 0. Keluaran tidak pernah memuat password, hash, email, atau DSN. Image runner berisi `libs/server/auth/` dan menjalankan perintah ini sebagai job `migrate` tanpa backend.
- **AC-4**: Masuk. `POST /api/auth/session` dengan origin yang diizinkan, `Content-Type: application/json`, dan email serta password yang benar menjawab 200 model `AuthSession` dengan `Cache-Control: no-store` dan tepat satu `Set-Cookie` menurut tabel *Cookie sesi* untuk mode komposisi. Satu baris `auth.sessions` baru menyimpan `token_hash` (SHA 256 heksadesimal dari token), bukan token, dengan `expires_at` 12 jam dan `idle_expires_at` 30 menit dari `now()` database. Bila request membawa cookie sesi yang masih valid (milik siapa pun), sesi itu dicabut dengan alasan `replaced` sebelum sesi baru dibuat (rotasi saat masuk), dan sesudah masuk akun mempunyai paling banyak 10 sesi aktif (yang paling lama tidak aktif dicabut dengan alasan `session_limit`), juga saat dua request masuk berjalan bersamaan. Baris percobaan akun itu dihapus. Transaksi masuk baru dimulai sesudah verifikasi berhasil, mengambil lock per akun, lalu membaca ulang `password_hash`; hash yang berbeda dari hash yang diverifikasi (password diganti operator di antaranya) menjawab 401 `Invalid credentials` tanpa sesi baru. Tidak ada koneksi database atau transaksi yang ditahan selama hash atau verifikasi Argon2id.
- **AC-5**: Tanpa enumerasi akun. Untuk email tidak terdaftar dan untuk email terdaftar dengan password salah, `POST /api/auth/session` menjawab sama: status 401, body `{"error":"Invalid credentials"}`, dan nama serta nilai header yang sama kecuali `X-Request-Id` dan `Date`, tanpa `Set-Cookie`. Kedua jalur menjalankan tepat satu verifikasi Argon2id dengan parameter yang sama lewat satu fungsi verifikasi (`Bun.password.verify`, atau opsi `auth.verify` `createApp` di test) dengan jalur email tidak terdaftar memakai hash tiruan per proses, dan satu pencatatan percobaan; median durasi 20 percobaan tiap jalur pada PostgreSQL nyata berbeda paling banyak 1,5 kali. Email yang sesudah normalisasi tidak memenuhi aturan *Email*, atau password yang tidak memenuhi aturan *Password* untuk masuk, menjawab 400 `Invalid request` sebelum slot verifikasi, pencatatan percobaan, dan Argon2id. Body yang tidak sah menurut schema, termasuk JSON rusak, menjawab 400 `Invalid request`; properti body yang tidak dikenal dibuang (normalisasi bawaan Elysia) tanpa memengaruhi jawaban. Media type selain aturan *Content-Type* menjawab 415 `Unsupported media type`, origin yang tidak diizinkan 403 `Forbidden`, dan database yang tidak tersedia 503 `Service unavailable`, semuanya tanpa membuat sesi dan menurut prioritas daftar *Urutan pemeriksaan per request*: origin salah dengan JSON rusak tetap 403, dan media type salah dengan body rusak (termasuk multipart tanpa boundary) tetap 415. Body di atas 1.024 byte dijawab 413 oleh Bun atau edge sebelum Elysia, di luar kontrak operasi dan bukan `AuthError`.
- **AC-6**: Batas percobaan. Per akun (kunci `sha256` dari `sign-in:` ditambah email ternormalisasi, ada atau tidak akunnya) paling banyak 10 percobaan masuk dalam jendela tetap 15 menit, dihitung sebelum verifikasi password secara atomik; percobaan ke 11 dalam jendela menjawab 429 `{"error":"Too many requests"}` tanpa verifikasi, juga dengan password benar dan juga untuk email tidak terdaftar, dan request bersamaan tidak dapat melewati batas itu. Jendela yang berakhir mengizinkan percobaan lagi, dan masuk yang berhasil menghapus baris kunci itu. Pada kedua jalur, sesudah reservasi, satu statement terpisah menghapus paling banyak 10 baris kunci lain yang jendelanya sudah berakhir. Per proses backend paling banyak 4 verifikasi password berjalan bersamaan dengan antrean paling banyak 12 request selama paling lama 2.000 ms; selebihnya 503 `Service unavailable`. Per alamat client, edge membatasi `POST /api/auth/session` pada 30 request per menit dengan burst 10, dan kelebihan dijawab edge 429 dengan body yang sama dan header API tanpa diteruskan ke backend.
- **AC-7**: Validasi dan masa berlaku sesi. `GET /api/auth/session` dengan cookie sesi valid menjawab 200 `AuthSession`; tanpa cookie, dengan cookie yang bentuknya salah, dengan nama cookie sesi lebih dari satu kali, atau dengan sesi yang dicabut, melewati `idle_expires_at`, atau melewati `expires_at`, menjawab 401 `{"error":"Unauthorized"}` dan menghapus cookie bila cookie sesi dikirim. Waktu selalu dibandingkan dengan `now()` database. Request terautentikasi menjalankan satu statement perpanjangan baris *Perpanjangan sesi* tabel *Value sourcing*: `last_seen_at` dan `idle_expires_at` (menjadi `least(now() + 30 menit, expires_at)`) berubah bersama, paling sering sekali per 60 detik per sesi, dan statement itu mengubah nol baris untuk sesi yang dicabut atau kedaluwarsa; masa berlaku absolut 12 jam tidak pernah diperpanjang. Route GET tidak mengubah data akun atau data bisnis; pembaruan dua kolom itu adalah pencatatan sesi.
- **AC-8**: Keluar, daftar, dan pencabutan. `DELETE /api/auth/session` mencabut sesi pemanggil dengan alasan `sign_out` dan menjawab 204 dengan cookie dihapus; tanpa sesi valid tetapi dengan header `x-csrf-token` yang bentuknya benar menjawab 204 dan menghapus cookie tanpa perubahan data. `GET /api/auth/sessions` menjawab hanya sesi aktif milik pemanggil (paling banyak 10, urut `last_seen_at` lalu `created_at` menurun) dengan `current` benar tepat pada sesi pemanggil. `DELETE /api/auth/sessions/{sessionId}` mencabut sesi aktif milik pemanggil dengan alasan `revoked` (204, cookie dihapus bila itu sesi pemanggil), dan tanpa sesi valid dengan header yang bentuknya benar menjawab 401; sesi milik pengguna lain, sesi yang sudah berakhir, dan id yang tidak ada sama sama menjawab 404 `{"error":"Not found"}` tanpa mengubah sesi pengguna lain. Pada kedua route `DELETE`, header `x-csrf-token` yang tidak ada atau bentuknya salah selalu menjawab 400, ada atau tidak ada sesi, dan `sessionId` di luar pola UUID huruf kecil (misalnya bentuk `urn:uuid:` atau huruf besar) menjawab 400. Token sesi yang sudah keluar atau dicabut ditolak 401 walau dikirim ulang.
- **AC-9**: CSRF dan origin. Ketiga route yang mengubah data (`POST` dan `DELETE /api/auth/session`, `DELETE /api/auth/sessions/{sessionId}`) menolak dengan 403 `Forbidden` di guard `onRequest` plugin auth, sebelum body diurai, tanpa menjalankan handler, dan tanpa perubahan data, request tanpa header `Origin`, dengan `Origin` yang tidak sama persis dengan salah satu origin yang diizinkan (tabel *Konfigurasi*), atau dengan `Sec-Fetch-Site` selain `same-origin` bila header itu ada. Setiap jawaban guard (404, 400, 403, 415) membawa body `AuthError` dan `Cache-Control: no-store`, dan pada komposisi dengan sink log menulis tepat satu baris log request. Kedua route `DELETE` dengan sesi valid juga wajib membawa `X-CSRF-Token` yang sama dengan token CSRF sesi itu (tabel *Token*); nilai yang salah menjawab 403. Form HTML lintas situs dengan `application/x-www-form-urlencoded` ditolak. Komposisi production tanpa opsi `publicOrigin` menolak semua request yang mengubah data, dan `index.ts` dengan `NODE_ENV=production` gagal start bila `PUBLIC_ORIGIN` tidak ada atau tidak sah.
- **AC-10**: Credential tidak bocor. Response tidak pernah memuat password, hash password, token sesi, atau hash token; token sesi hanya ada di `Set-Cookie` dan token CSRF hanya di body `AuthSession`. Log request dan log event `auth` (tabel *Log keamanan*) tidak memuat email, password, cookie, token, token CSRF, atau body. `openapi.json` tidak memuat contoh nilai credential. Pemindaian artefak `test:database:real`, `test:readiness:real`, `test:tooling:real`, dan `test:deployment:real` mencakup password akun uji sebagai nilai dan setiap token sesi serta token CSRF yang diperoleh test lewat mekanisme *Sidik token uji*, tanpa temuan; token tidak pernah ditulis ke file mana pun. Di browser, sesudah masuk dan sesudah aksi apa pun, `localStorage`, `sessionStorage`, dan IndexedDB kosong dari nilai auth, `document.cookie` tidak memuat cookie sesi, dan bundle production lolos `check:frontend:bundle`.
- **AC-11**: Kontrak OpenAPI dan SDK. `openapi.json` memuat kelima operasi tabel *API surface* dengan `operationId`, tag `auth`, `security`, parameter, model, dan status persis tabel itu, 204 tanpa `content`, `$ref` `#/components/schemas/AuthError` pada setiap status galat, security scheme `sessionCookie` (`apiKey` di `cookie`), dan tanpa parameter cookie; kedua operasi 204 mengikuti resep *Ekspor route 204 dengan galat*. `REQUIRED_OPERATIONS` bertambah tiga entri tabel *Operasi wajib baru*, masing masing dengan mutasi yang hanya melanggar entri itu dan ditolak `required-operation`. `bun run api:sync` dan `bun run api:check` lulus tanpa perubahan tabel *Aturan checker* spec 0008. Adapter `apps/frontend/src/app/features/auth/auth-api.ts` mengikuti kontrak adapter spec 0009 dan pemetaan tabel *Pemetaan adapter*, dibuktikan `HttpTestingController` untuk bentuk request dan setiap baris pemetaan, dan backend harness nyata spec 0009 (tanpa perubahan environment) untuk `session()` dan `sessions()` yang menjadi `unavailable` karena backend tanpa database menjawab 503 pada route GET, yang tidak memeriksa origin.
- **AC-12**: Frontend. Route `/masuk` dan `/akun` serta item navigasi statis `Akun` bekerja menurut tabel *Halaman*, *State halaman*, dan *Teks halaman*: masuk berhasil membuka `/akun` yang menampilkan nama, email, dan sesi aktif; setiap state tampil dengan teks dan elemen tabel *State halaman*; `/akun` tanpa sesi berpindah ke `/masuk` dengan teks sesi berakhir; mengakhiri sesi lain dan keluar bekerja tanpa muat ulang. Form memakai `novalidate`, label, `autocomplete` `username` dan `current-password`, dapat dioperasikan dengan keyboard, mengumumkan galat lewat elemen `role="alert"` dan hasil lain lewat `role="status"`, mencegah kirim ganda, dan tanpa overflow horizontal pada 1280×812 dan 375×812. Komponen hanya dari entry point publik `@ojiepermana/angular`. Membuka `/` dan `/kesiapan` tetap tidak membuat request ke `/api/`.
- **AC-13**: Komposisi dan deployment. Kedua komposisi `createApp` memasang route auth dengan teks akhir *Teks akhir `createApp`*; komposisi production tetap tanpa OpenAPI dan route development. `deploy/compose.yaml` memberi backend `PUBLIC_ORIGIN` dari `FOUNDATION_PUBLIC_ORIGIN`, edge menerapkan batas AC-6 dan named location 429, dan image runner memuat `libs/server/auth/`. `test:deployment:real` lulus dengan check baru tabel *Perubahan deployment* bersama check lama, dengan urutan eksekusi dan anggaran request tabel itu: akun dibuat lewat job `migrate`, masuk lewat edge memberi cookie `__Host-foundation_session` dengan `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, tanpa `Domain` dan tanpa `Max-Age`, origin dan CSRF ditolak lewat edge, kapasitas Argon2id di dalam batas container backend, batas edge per client, alur browser production lewat edge, serta baris log `auth` yang diterima `log_structure` dan berkorelasi dengan baris request nya pada `log_correlation`.
- **AC-14**: Hook fitur 15 spec 0013. `docs/rules/backup.md` mengganti setiap `tidak berlaku sampai fitur 15` dengan perintah `revoke-sessions --all` (langkah 8 *Runbook restore* dan *Prosedur insiden*) dengan string wajib tabel *Dokumen yang diperbarui*, dan mencatat keputusan butir 3, 4, dan 5 tabel *Keputusan hook backup*. BKP-009 di `tests/scenarios/backup.json` membuktikan pada `test:database:real`: sesi yang dibuat di sumber sebelum backup diterima `createApp('production')` target sesudah restore (sesi ikut backup), ditolak 401 sesudah `database/accounts.ts revoke-sessions --all --apply` atas target, dan run kedua mencetak `Sessions revoked: 0`; hasilnya tercatat di field `sessions` `restore.json` dan `restore.json` tetap `passed`. BKP-009 adalah test terakhir `backup.test.ts` (sesudah test probe fingerprint), sehingga setiap pembandingan target dengan fingerprint sumber sudah selesai sebelum target diubah, dan asersi BKP-003 serta BKP-004 berubah menurut baris `backup.test.ts` tabel *Test dan file lama yang berubah*.
- **AC-15**: Bukti dan gate. Registry `tests/scenarios/auth.json` (`source` spec ini) memuat AUTH-001 sampai AUTH-014 tabel *Critical test scenarios* dan lolos `test:scenarios`; AUTH-012 dan AUTH-013 `critical` dengan check Playwright. Suite database baru terdaftar pada `tests/orchestration/signal-cleanup.ts` dan GATE-009. Setiap dokumen tabel *Dokumen yang diperbarui* memuat string wajibnya secara harfiah (diperiksa AUTH-014 dan BKP-001), dan setiap file tabel *Test dan file lama yang berubah* berubah menurut tabel itu pada commit yang sama dengan perubahan yang memicunya. `bun run test:ci`, `bun run test:ci:real`, dan `bun run test:ci:security` lulus pada pohon kandidat.

## Decision

**Chosen option**: Opsi 1, sesi opaque yang disimpan server di PostgreSQL dengan implementasi sendiri memakai fasilitas native Bun (`Bun.password` Argon2id dan `crypto`), cookie `HttpOnly` `SameSite=Strict`, token CSRF turunan HMAC dari token sesi, dan akun yang dibuat operator lewat job runner.

Alur pertama dibatasi pada masuk, keluar, identitas, daftar dan pencabutan sesi milik sendiri, serta perintah operator; registrasi, profil, pemulihan akun, MFA, dan peran lain menjadi tindak lanjut. Semua keputusan diambil agent atas delegasi pemilik pada 2026-10-06; pertanyaan, pilihan, rekomendasi, dan alasannya ada di [rationale.md](rationale.md). (basis: aturan keamanan tentang sesi opaque di server, cookie `HttpOnly`, hash token di `auth`, dan Argon2id lewat `Bun.password`; keputusan schema scope dan `foundation.md` bagian 6 dan 9)

**Implementation skills**: `elysiajs` (skill pengguna, `~/.claude/skills/elysiajs/`), terutama `references/lifecycle.md` (urutan request, parse, transform, validasi; probe 2026-10-06 di rationale: hanya `onRequest` yang dapat menolak sebelum body diurai) dan `references/cookie.md`; `angular-developer` (skill pengguna, `~/.claude/skills/angular-developer/`) untuk form, `rxResource`, dan router. Aturan proyek tetap berlaku di atas keduanya.

## Feature design

**Batas alur**: Termasuk masuk, keluar, identitas pemanggil, daftar dan pencabutan sesi milik sendiri, perintah operator (buat akun, ganti password, cabut sesi), dan hook backup. Tidak termasuk registrasi publik, ubah profil, pemulihan akun dan email, MFA, peran selain satu peran implisit pengguna, nonaktif atau hapus akun, label perangkat, dan rehash password saat masuk (tindak lanjut). Otorisasi di alur ini adalah kepemilikan: setiap query sesi difilter `user_id` dari sesi yang tervalidasi, tidak pernah dari payload.

**Data model sketch** (schema dari scope dan `foundation.md` bagian 6 dan 9, tidak ditanyakan ulang: identitas bisnis di `users`, credential, hash token, sesi, penghitung percobaan, dan otorisasi di `auth`; relasi lintas schema `auth` ke `users` dicatat di sini sesuai aturan database):

**Model data**:

| Objek | Kolom dan constraint | Relasi |
| --- | --- | --- |
| `users.users` | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`; `email text NOT NULL` dengan constraint `users_email_key UNIQUE` dan `users_email_check CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email ~ '^[!-?A-~]{1,64}@[!-?A-~]{1,252}$')`; `display_name text NOT NULL` dengan `users_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name) AND display_name !~ '[[:cntrl:]]')`; `created_at timestamptz NOT NULL DEFAULT transaction_timestamp()`; `updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()` | Induk sesi dan credential |
| `auth.password_credentials` | `user_id uuid PRIMARY KEY` dengan FK `password_credentials_user_id_fkey REFERENCES users.users (id) ON DELETE CASCADE`; `password_hash text NOT NULL` dengan `password_credentials_hash_check CHECK (password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$')`; `created_at` dan `updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()` | 1:1 ke `users.users`, opsional (akun tanpa password kelak mungkin) |
| `auth.sessions` | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`; `user_id uuid NOT NULL` dengan FK `sessions_user_id_fkey REFERENCES users.users (id) ON DELETE CASCADE`; `token_hash text NOT NULL` dengan `sessions_token_hash_key UNIQUE` dan `sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$')`; `created_at timestamptz NOT NULL DEFAULT transaction_timestamp()`; `last_seen_at timestamptz NOT NULL DEFAULT transaction_timestamp()`; `idle_expires_at timestamptz NOT NULL`; `expires_at timestamptz NOT NULL`; `revoked_at timestamptz` (nullable); `revoked_reason text` (nullable) dengan `sessions_revoked_reason_check CHECK (revoked_reason IN ('sign_out', 'revoked', 'replaced', 'session_limit', 'credential_change', 'operator'))`; constraint tabel `sessions_revocation_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))` dan `sessions_expiry_check CHECK (created_at < expires_at AND idle_expires_at <= expires_at)` | N:1 ke `users.users` |
| Index `auth.sessions_user_active_idx` | `ON auth.sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL` | Daftar, pembatasan 10 sesi, dan pencabutan per akun |
| `auth.sign_in_attempts` | `key_hash text PRIMARY KEY` dengan `sign_in_attempts_key_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$')`; `attempt_count integer NOT NULL` dengan `sign_in_attempts_count_check CHECK (attempt_count >= 1)`; `window_started_at timestamptz NOT NULL` | Tanpa FK; kunci ada juga untuk email tidak terdaftar |

Nullable hanya `revoked_at` dan `revoked_reason` di database; kontrak HTTP tidak memakai nullable (spec 0008). Sesi aktif berarti `revoked_at IS NULL AND idle_expires_at > now()` (dengan `idle_expires_at <= expires_at`, masa absolut ikut tercakup). Retensi: baris percobaan yang jendelanya sudah berakhir dihapus sedikit demi sedikit oleh backend (paling banyak 10 baris per percobaan masuk, baris *Pembersihan percobaan* tabel *Value sourcing*, memakai grant `DELETE` yang sudah dibutuhkan masuk berhasil), sehingga ukuran tabel itu mengikuti jumlah kunci dalam 15 menit terakhir ditambah sisa yang belum terhapus. Baris sesi tetap ada sesudah berakhir sampai job pembersihan fitur 16, karena backend sengaja tanpa `DELETE` pada `auth.sessions`; pertumbuhannya dibatasi masuk yang berhasil, yaitu paling banyak 43.200 baris per alamat client per hari oleh batas edge (30 per menit), dan dicatat sebagai keterbatasan yang disengaja. Rekomendasi untuk fitur 16 adalah menghapus sesi 30 hari sesudah berakhir (dicabut atau kedaluwarsa) dan percobaan yang jendelanya lebih tua dari 15 menit.

**Migration** (satu statement per file, dijalankan runner spec 0005 sebagai `foundation_owner`):

| File | Statement |
| --- | --- |
| `0002-users-create-users.sql` | `CREATE TABLE users.users (...)` sesuai *Model data* |
| `0003-auth-create-password-credentials.sql` | `CREATE TABLE auth.password_credentials (...)` |
| `0004-auth-create-sessions.sql` | `CREATE TABLE auth.sessions (...)` |
| `0005-auth-create-sessions-user-active-index.sql` | `CREATE INDEX sessions_user_active_idx ON auth.sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL` |
| `0006-auth-create-sign-in-attempts.sql` | `CREATE TABLE auth.sign_in_attempts (...)` |
| `0007-users-grant-backend-users.sql` | `GRANT SELECT (id, email, display_name) ON users.users TO foundation_backend` |
| `0008-auth-grant-backend-password-credentials.sql` | `GRANT SELECT (user_id, password_hash) ON auth.password_credentials TO foundation_backend` |
| `0009-auth-grant-backend-sessions.sql` | `GRANT SELECT (id, user_id, token_hash, created_at, last_seen_at, idle_expires_at, expires_at, revoked_at), INSERT (user_id, token_hash, idle_expires_at, expires_at), UPDATE (last_seen_at, idle_expires_at, revoked_at, revoked_reason) ON auth.sessions TO foundation_backend` |
| `0010-auth-grant-backend-sign-in-attempts.sql` | `GRANT SELECT, INSERT, DELETE, UPDATE (attempt_count, window_started_at) ON auth.sign_in_attempts TO foundation_backend` |

**Matriks grant backend** (amandemen matriks spec 0004 untuk `foundation_backend`; atribut role, membership, dan privilege schema tidak berubah):

| Tabel | Diizinkan | Ditolak (dibuktikan AUTH-002) |
| --- | --- | --- |
| `users.users` | `SELECT (id, email, display_name)` | `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `SELECT created_at`, `SELECT updated_at`, `SELECT ... FOR UPDATE` |
| `auth.password_credentials` | `SELECT (user_id, password_hash)` | `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `SELECT created_at` |
| `auth.sessions` | `SELECT` delapan kolom baris 0009, `INSERT (user_id, token_hash, idle_expires_at, expires_at)` dengan default untuk kolom lain, `UPDATE (last_seen_at, idle_expires_at, revoked_at, revoked_reason)` | `DELETE`, `TRUNCATE`, `SELECT revoked_reason`, `INSERT` dengan `id` atau `created_at` eksplisit, `UPDATE user_id` atau `token_hash` atau `expires_at` |
| `auth.sign_in_attempts` | `SELECT`, `INSERT`, `DELETE`, `UPDATE (attempt_count, window_started_at)` | `TRUNCATE`, `UPDATE key_hash` |
| Semua | Tanpa grant option, tanpa DDL, tanpa `REFERENCES` atau `TRIGGER` | `CREATE` di `users` dan `auth`, `SET ROLE foundation_owner` |

**Kontrak role worker kelak** (diteruskan ke fitur 16, tidak dibuat di sini): role worker pembersihan hanya mendapat `USAGE` pada `auth`, `SELECT (revoked_at, idle_expires_at, expires_at)` dan `DELETE` pada `auth.sessions`, serta `SELECT (window_started_at)` dan `DELETE` pada `auth.sign_in_attempts`, tanpa akses `token_hash`, `users`, atau `auth.password_credentials`, dan bukan anggota `pg_read_all_data`. Kolom kedaluwarsa disimpan sebagai nilai, sehingga worker tidak perlu mengetahui konstanta kebijakan.

**State transitions**: Sesi: dibuat (aktif) → aktif dengan `idle_expires_at` diperpanjang → berakhir karena salah satu dari: `sign_out`, `revoked` (pengguna mengakhiri lewat daftar), `replaced` (masuk lagi dengan cookie yang masih valid), `session_limit` (sesi ke 11), `credential_change` (operator `set-password`), `operator` (`revoke-sessions`), atau waktu (`idle_expires_at` atau `expires_at` lewat, tanpa menulis kolom). Sesi berakhir tidak pernah aktif lagi. Percobaan: tidak ada → jendela dibuka (`attempt_count` 1) → bertambah sampai 10 → terkunci sampai jendela 15 menit berakhir → baris dihapus saat masuk berhasil, atau jendela baru dibuka saat percobaan berikutnya sesudah jendela berakhir.

**API surface** (semua path di bawah `/api/auth/`, tag `auth`, model body bernama di tabel *Model kontrak*). Semua jawaban untuk path di bawah `/api/auth/`, termasuk 400 validasi, 400 JSON rusak, 404 path tidak dikenal, dan 500, membawa `Cache-Control: no-store`: guard `onRequest` plugin auth menetapkan `set.headers['cache-control'] = 'no-store'` untuk setiap request di bawah prefix itu sebelum langkah lain, dan header itu terbawa ke jawaban `onError` root (probe 2026-10-06), sedangkan jawaban guard sendiri membawanya di `Response` nya. `onError` root tetap didaftarkan sebelum `.use()` plugin auth; dengan urutan terbalik, jawaban validasi bawaan Elysia memuat nilai yang dikirim, termasuk password. Status 413 untuk body di atas 1.024 byte berasal dari Bun atau edge, tidak dideklarasikan di kontrak, dan dipetakan adapter ke `failed`.

| Endpoint | Method | `operationId` | Key inputs | Key outputs | Auth (`security`) | Key errors |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/auth/session` | POST | `signIn` | Header `Origin`; body `SignInRequest` `{ email, password }` JSON | 200 `AuthSession` dan `Set-Cookie` | `[]` | 400, 401 `Invalid credentials`, 403, 415, 429, 500, 503 |
| `/api/auth/session` | GET | `getAuthSession` | Cookie sesi | 200 `AuthSession` | `[{ sessionCookie: [] }]` | 400 (query atau body), 401, 500, 503 |
| `/api/auth/session` | DELETE | `signOut` | Cookie sesi, header `Origin`, header `x-csrf-token` (wajib, pola `^[A-Za-z0-9_-]{43}$`) | 204, cookie dihapus | `[{ sessionCookie: [] }]` | 400, 403, 500, 503 |
| `/api/auth/sessions` | GET | `listAuthSessions` | Cookie sesi | 200 `AuthSessionList` | `[{ sessionCookie: [] }]` | 400, 401, 500, 503 |
| `/api/auth/sessions/{sessionId}` | DELETE | `revokeAuthSession` | Path `sessionId` (string `format: uuid` dengan `pattern` `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, karena format `uuid` Elysia 1.4.30 menerima awalan `urn:uuid:` dan huruf besar yang ditolak PostgreSQL atau tidak pernah tersimpan), cookie sesi, `Origin`, `x-csrf-token` (wajib, pola sama) | 204 | `[{ sessionCookie: [] }]` | 400, 401, 403, 404, 500, 503 |

**Model kontrak** (didaftarkan `.model()` dan dirujuk dengan nama; semua `additionalProperties: false`, semua properti wajib, tanpa nullable). Plugin auth memakai normalisasi bawaan Elysia: properti request yang tidak dikenal dibuang sebelum handler (bukan 400), dan properti response di luar model juga dibuang, sehingga response tidak dapat membawa field tambahan:

| Model | Isi |
| --- | --- |
| `SignInRequest` | `email` string `minLength` 3, `maxLength` 254; `password` string `minLength` 1, `maxLength` 256 (satuan UTF 16 TypeBox; batas 128 code point diperiksa handler menurut aturan *Password*, sehingga password 128 code point di luar BMP tetap lolos schema) |
| `AuthSession` | `user` object `{ id: string format uuid, email: string, displayName: string }` (tanpa `format: email`, karena constraint `users_email_check` menerima domain tanpa titik seperti `admin@localhost`); `session` object `{ id: string format uuid, createdAt, lastSeenAt, idleExpiresAt, expiresAt: string format date-time }`; `csrfToken` string tepat 43 karakter pola `^[A-Za-z0-9_-]{43}$` |
| `AuthSessionList` | `sessions` array object `{ id: string format uuid, createdAt: string format date-time, lastSeenAt: string format date-time, current: boolean }` |
| `AuthError` | `error` string `enum` tepat `Invalid request`, `Invalid credentials`, `Unauthorized`, `Forbidden`, `Not found`, `Unsupported media type`, `Too many requests`, `Service unavailable`, `Internal server error`; dipakai setiap status 4xx dan 5xx kelima operasi |

Security scheme `components.securitySchemes.sessionCookie`: `{ type: 'apiKey', in: 'cookie', name: '__Host-foundation_session', description: 'Cookie sesi HttpOnly. Komposisi development memakai nama foundation_session tanpa Secure karena berjalan di HTTP lokal.' }`, dideklarasikan lewat `documentation.components` plugin OpenAPI. Route tidak mendeklarasikan schema `cookie` Elysia, karena plugin akan mengekspornya sebagai parameter `in: cookie` yang ditolak rule `parameter`; cookie dibaca dari header `cookie` request. `x-csrf-token` dideklarasikan sebagai schema `headers` (parameter `in: header` skalar yang diterima rule `parameter`).

**Ekspor route 204 dengan galat** (probe 2026-10-06 dengan `@elysia/openapi` 1.4.16 dan `validateOpenApi` repository): resep spec 0008 (`detail.responses` berisi 204 tanpa schema `response[204]`) tidak berlaku bila route yang sama juga mempunyai map `response`, karena entri 204 di `detail.responses` lalu hilang dan operasi tanpa 2xx ditolak rule `response`; 204 sebagai `t.Undefined`, `t.Void`, atau `t.Null` di map juga ditolak. Karena itu `signOut` dan `revokeAuthSession` tidak mendeklarasikan map `response`; semua status ada di `detail.responses`, yaitu 204 sebagai `{ description }` dan setiap status galat sebagai `{ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthError' } } } }`. Kedua route itu tidak mempunyai validasi response saat runtime, sehingga handler nya hanya mengembalikan jawaban 204 tanpa body atau body `AuthError` yang dibentuk satu fungsi bersama. Ketiga operasi 200 mendeklarasikan 200 dan setiap status galat di map `response` dengan nama model. Dokumen root mendeklarasikan tag `{ name: 'auth' }` di `documentation.tags`.

**Operasi wajib baru** (`REQUIRED_OPERATIONS` di `scripts/validate-openapi.ts`, tabel *Tabel operasi wajib* spec 0008):

| Path | Method | `operationId` | Tag | Security | Response sukses dan asersi komponen |
| --- | --- | --- | --- | --- | --- |
| `/api/auth/session` | `post` | `signIn` | `auth` | `[]` | 200 `AuthSession`: object, `additionalProperties: false`, properti tepat `user`, `session`, `csrfToken`, semuanya `required`, tanpa properti bernama `token`, `password`, `passwordHash`, atau `tokenHash` di tingkat mana pun |
| `/api/auth/session` | `get` | `getAuthSession` | `auth` | `[{ sessionCookie: [] }]` | 200 `AuthSession` dengan asersi yang sama |
| `/api/auth/sessions` | `get` | `listAuthSessions` | `auth` | `[{ sessionCookie: [] }]` | 200 `AuthSessionList`: properti tepat `sessions` berupa array object dengan properti tepat `id`, `createdAt`, `lastSeenAt`, `current` |

**Urutan pemeriksaan per request** (berhenti pada langkah pertama yang menolak). Probe 2026-10-06 pada Elysia 1.4.30: body diurai sebelum `onTransform`, `onTransform` yang mengembalikan `Response` tidak menghentikan lifecycle (handler tetap berjalan), dan hanya `onRequest` yang mengembalikan `Response` menjawab sebelum body diurai tanpa menjalankan handler, tetapi tanpa `onAfterResponse`. Karena itu langkah 1 sampai 4 berjalan di satu guard `onRequest` plugin auth yang hanya menangani path berawalan `/api/auth/`, membaca method, header, `requestTarget(request.url)`, dan `routedPath(request.url)` dari `plugins/request-guard.ts` (tanpa decode, tanpa membaca body), dan menolak dengan mengembalikan `Response` JSON `AuthError` dengan `Content-Type: application/json` dan `Cache-Control: no-store`. Karena `onAfterResponse` tidak berjalan untuk jawaban itu, guard menulis sendiri satu baris log request spec 0012 lewat `writeRequestLine` (*Log keamanan*) bila sink ada. Tidak ada penolakan di `onTransform`; langkah 5 dan seterusnya berjalan di lifecycle biasa, dan setiap jawaban di sana adalah jawaban handler, `status(...)`, atau `onError` root.

1. Method dan path yang tidak sama dengan salah satu route → 404 `Not found`: tepat `POST`, `GET`, atau `DELETE` `/api/auth/session`, `GET /api/auth/sessions`, dan `DELETE /api/auth/sessions/<satu segmen tidak kosong tanpa />` (pola segmen diperiksa langkah 5), tanpa garis miring akhir; `HEAD` termasuk 404. Guard menangani request bila pathname `requestTarget` atau path yang dipakai router Elysia (`routedPath`: `request.url` mulai dari `/` pertama pada indeks 11 atau sesudahnya) berawalan `/api/auth/`, dan keduanya wajib sama; bila berbeda → 404. Tanpa syarat ini Host 3 karakter atau kurang, atau Host yang membuat Bun menulis `request.url` sebagai target saja, membawa misalnya `//api/auth/session` ke handler tanpa guard (amandemen 2026-10-06 sesudah code review, keputusan 74 rationale). Karena itu variasi path tidak dapat melewati batas edge yang memakai path mentah yang sama.
2. Query string apa pun, atau header body (`content-length` selain `0` atau `transfer-encoding`) pada GET dan DELETE → 400 `Invalid request` (aturan `strictGet`).
3. Hanya route yang mengubah data: aturan origin AC-9 → 403 `Forbidden`, dan event log `auth` `request_rejected` dengan `outcome` `origin`.
4. Hanya `POST /api/auth/session`: aturan *Content-Type* → 415 `Unsupported media type`.
5. Elysia mengurai body JSON dan memvalidasi schema (body, header `x-csrf-token`, path `sessionId`); JSON rusak atau schema tidak sah → 400 `Invalid request` lewat `onError` root.
6. Tanpa pool database → 503 `Service unavailable`.
7. Route masuk: normalisasi email dan pemeriksaan aturan *Email* dan *Password* → 400; slot verifikasi (AC-6) → 503 bila penuh; reservasi percobaan → 429; pembersihan percobaan; lookup; verifikasi (hash akun atau hash tiruan) → 401; transaksi masuk (lock per akun, baca ulang hash → 401 bila berubah, rotasi, sesi baru, batas 10, hapus percobaan) → 200.
8. Route lain: resolusi sesi dari cookie → 401 (GET dan revoke) atau 204 tanpa perubahan (sign out).
9. Route `DELETE`: token CSRF → 403 `Forbidden`, event `request_rejected` dengan `outcome` `csrf`.
10. Aksi, lalu jawaban. Galat database di langkah mana pun → 503 tanpa pesan database.

**Content-Type** (langkah 4): nilai header, sesudah spasi di awal dan akhir dibuang, adalah media type `application/json` persis huruf kecil, boleh diikuti tepat satu parameter `charset=utf-8` dengan nama dan nilai parameter tanpa membedakan huruf besar kecil dan spasi opsional di sekitar `;`. Media type huruf besar, parameter lain, atau header yang tidak ada → 415. Media type wajib huruf kecil karena Elysia 1.4.30 hanya mengurai bentuk itu sebagai JSON (probe: `Application/JSON` sampai ke validasi sebagai teks), sehingga guard dan parser selalu sepakat.

**Cookie sesi**:

| Mode komposisi | Nama | Atribut saat menetapkan | Atribut saat menghapus |
| --- | --- | --- | --- |
| `production` | `__Host-foundation_session` | `Path=/; Secure; HttpOnly; SameSite=Strict`, tanpa `Domain`, `Expires`, atau `Max-Age` (cookie sesi browser; masa berlaku dijaga server) | Nilai kosong dengan atribut yang sama ditambah `Max-Age=0` |
| `development` | `foundation_session` | `Path=/; HttpOnly; SameSite=Strict`, tanpa `Secure` (HTTP lokal 127.0.0.1, dinyatakan khusus development), tanpa `Domain`, `Expires`, atau `Max-Age` | Sama, ditambah `Max-Age=0` |

Nama dan atribut ditentukan oleh mode komposisi `createApp`, bukan variable environment, sehingga production tidak dapat menonaktifkan `Secure` diam diam. Nilai cookie yang tidak cocok `^[A-Za-z0-9_-]{43}$`, atau nama cookie sesi yang muncul lebih dari sekali di header `Cookie`, berarti tidak ada sesi valid.

**Token**:

| Nilai | Cara dibuat atau diperiksa |
| --- | --- |
| Token sesi | 32 byte `crypto.getRandomValues`, dikodekan base64url tanpa padding (43 karakter); hanya di `Set-Cookie` |
| `token_hash` | SHA 256 dari byte UTF 8 token 43 karakter, heksadesimal kecil; lookup `WHERE token_hash = $1` |
| Token CSRF | base64url tanpa padding dari HMAC SHA 256 dengan kunci byte UTF 8 token sesi dan pesan `foundation-csrf-v1` (43 karakter); tidak disimpan, dihitung ulang dari cookie setiap request; dibandingkan dengan `timingSafeEqual` pada panjang yang sama |
| Kunci percobaan | SHA 256 heksadesimal dari `sign-in:` ditambah email ternormalisasi |
| `accountKey` log | 16 karakter pertama kunci percobaan |
| Hash tiruan | Hash Argon2id parameter sama dari 32 byte acak, dibuat sekali per instance plugin auth sebagai satu promise yang di memo: request masuk pertama (di kedua jalur, sesudah pemeriksaan format dan sebelum slot verifikasi) memulai promise itu, request bersamaan lain menunggu promise yang sama, dan hash tidak pernah dibuat ulang. Pembuatannya di luar slot verifikasi, sehingga ekspor OpenAPI dan `createApp` tidak menghitung hash dan kedua jalur request pertama menunggu hal yang sama |

**Kebijakan** (konstanta di `apps/backend/src/features/auth/auth.policy.ts`, berubah hanya lewat pembaruan spec ini, tidak lewat environment):

| Hal | Nilai |
| --- | --- |
| Masa berlaku absolut | 12 jam dari `created_at` |
| Masa idle | 30 menit, diperpanjang paling sering sekali per 60 detik |
| Sesi aktif per akun | 10 |
| Percobaan per kunci | 10 per jendela tetap 15 menit |
| Verifikasi password per proses | 4 berjalan, antrean 12, tunggu paling lama 2.000 ms |
| Hash password | Argon2id `memoryCost` 19456 KiB dan `timeCost` 2 yang ditulis eksplisit (bawaan Bun 1.4.2 adalah `m=65536`, tidak dipakai), parallelism 1 (satu satunya nilai Bun), di `libs/server/auth/credentials.ts` |
| Password | Satu fungsi di `libs/server/auth/credentials.ts` dipakai operator dan backend. Penetapan (operator): nilai mentah wajib `isWellFormed()`, tanpa karakter kontrol `\p{Cc}`, paling banyak 128 code point, dan sesudah NFKC 15 sampai 128 code point; yang di hash adalah bentuk NFKC. Masuk: schema membatasi 1 sampai 256 satuan UTF 16, lalu handler mewajibkan `isWellFormed()`, paling banyak 128 code point mentah, dan 1 sampai 128 code point sesudah NFKC, selain itu 400 `Invalid request`; tanpa pemotongan. Password yang memenuhi aturan penetapan selalu lolos aturan masuk, dan body masuknya paling besar 792 byte bila email tidak memuat `"` atau `\` (email 254 byte, password 128 code point tanpa karakter kontrol paling banyak 512 byte JSON, ditambah 26 byte struktur), di bawah batas 1.024 byte; body di atas batas itu dijawab 413 |
| Email | `trim` spasi, huruf A sampai Z menjadi kecil, lalu wajib cocok pola dan panjang constraint `users_email_check`; nilai yang tidak cocok menjawab 400 saat masuk (sebelum slot, reservasi, dan Argon2id) dan `Invalid email` di perintah operator |
| Nama tampilan | Perintah operator menolak, tanpa memotong atau menormalisasi, nilai yang tidak `isWellFormed()`, panjangnya di luar 1 sampai 100 code point, diawali atau diakhiri spasi U+0020, atau memuat karakter `\p{Cc}`, sehingga setiap nilai yang lolos juga lolos `users_display_name_check`; nilai disimpan apa adanya |
| Batas edge | `POST /api/auth/session`: 30 request per menit per alamat client, burst 10 tanpa jeda |

**Perintah operator** (`database/accounts.ts`; argumen tepat dalam urutan kolom pertama, setiap baris keluaran tepat satu baris):

| Perintah atau keadaan | Masukan | Keluaran | Stream | Exit |
| --- | --- | --- | --- | --- |
| `create --email <email> --display-name <nama> --apply` berhasil | `FOUNDATION_ACCOUNT_PASSWORD` | `Account created: <uuid>` | stdout | 0 |
| `create` untuk email yang sudah ada | `FOUNDATION_ACCOUNT_PASSWORD` | `Account exists` (password dan nama tidak berubah) | stderr | 1 |
| `set-password --email <email> --apply` berhasil | `FOUNDATION_ACCOUNT_PASSWORD` | `Password changed: <uuid>; sessions revoked: <n>` (alasan `credential_change`, `n` boleh 0) | stdout | 0 |
| `revoke-sessions --email <email> --apply` berhasil | Tidak ada | `Sessions revoked: <n>` (alasan `operator`, `n` boleh 0) | stdout | 0 |
| `set-password` atau `revoke-sessions --email` untuk akun yang tidak ada | | `Account not found` | stderr | 1 |
| `revoke-sessions --all --apply` | Tidak ada | `Sessions revoked: <n>` atas semua sesi aktif (alasan `operator`); run kedua `Sessions revoked: 0` | stdout | 0 |
| Bentuk argumen lain: tanpa perintah, perintah lain, flag lain, flag berulang, urutan lain, nilai flag kosong, atau `--apply` yang tidak ada atau tidak terakhir | | `Use create, set-password, or revoke-sessions with --apply` | stderr | 1 |
| Email tidak memenuhi aturan *Email* | | `Invalid email` | stderr | 1 |
| Nama tidak memenuhi aturan *Nama tampilan* (`create`) | | `Invalid display name` | stderr | 1 |
| `FOUNDATION_ACCOUNT_PASSWORD` tidak ada atau tidak memenuhi aturan *Password* penetapan (`create`, `set-password`) | | `Missing or invalid FOUNDATION_ACCOUNT_PASSWORD` | stderr | 1 |
| Kegagalan runner | | Kategori `RunnerError` spec 0005 (misalnya `Migrations pending`), selain itu `Account command failed`; tanpa DSN atau galat database mentah | stderr | 1 |

*Prioritas galat*: bentuk argumen, lalu email, lalu nama tampilan, lalu password, semuanya sebelum koneksi dibuka; lalu kegagalan runner (koneksi, identitas, lock, migration tertunda); lalu `Account exists` atau `Account not found`. Galat pertama menurut urutan ini yang dicetak, hanya satu baris. `revoke-sessions` mengabaikan `FOUNDATION_ACCOUNT_PASSWORD` bila ada. `set-password` memakai `INSERT ... ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = transaction_timestamp()` pada `auth.password_credentials` (tidak ada trigger yang menulis `updated_at`), sesudah mengambil lock per akun `pg_advisory_xact_lock(hashtextextended(user_id::text, 638727))` yang sama dengan transaksi masuk, lalu mencabut sesi aktif akun itu di transaksi yang sama; `revoke-sessions --email` mengambil lock yang sama sebelum mencabut. Lock per akun memakai ruang kunci satu `bigint`, terpisah dari lock dua `integer` `(638727, 5)` dan `(638727, 6)`, dan diambil sesudah keduanya, sehingga urutannya tetap dan tidak ada deadlock dengan backend yang hanya mengambil lock per akun. `revoke-sessions --all` tidak mengambil lock per akun: masuk yang selesai sesudahnya adalah masuk baru yang sah dengan password yang berlaku, dan runbook restore menjalankannya saat backend berhenti.

Di image runner: `docker compose --env-file .env.deploy -f deploy/compose.yaml --profile migrate run --rm [-e FOUNDATION_ACCOUNT_PASSWORD] migrate database/accounts.ts <perintah>`. `database/runner.ts` mengekspor satu fungsi transaksi pemilik (identitas, kedua lock, `SET LOCAL ROLE foundation_owner`, metadata, dan syarat semua migration terapan) yang dipakai seed dan perintah ini, sehingga tidak ada salinan pemeriksaan.

**Konfigurasi**:

| Variable | Pemakai | Aturan |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | Backend (`readConfiguration` di `config/env.ts`, yang mengembalikan `publicOrigin`) | Wajib di production: harus sama persis dengan `new URL(nilai).origin`, skema `https:`, tanpa path, query, userinfo, atau garis miring akhir; origin yang diizinkan tepat nilai itu. Opsional di development (skema `http:` atau `https:`); bila tidak ada, origin yang diizinkan `http://127.0.0.1:8889` dan `http://localhost:8889`. Nilai yang tidak sah melempar `Invalid PUBLIC_ORIGIN configuration`, sehingga `index.ts` menulis `startup_failed` dan keluar 1 seperti konfigurasi lain yang tidak sah |
| `FOUNDATION_PUBLIC_ORIGIN` | `.env.deploy`, diteruskan `deploy/compose.yaml` sebagai `PUBLIC_ORIGIN` backend | Wajib, misalnya `https://app.example.com`; bukan secret |
| `FOUNDATION_ACCOUNT_PASSWORD` | `database/accounts.ts` saja, lewat `-e` dari shell operator | Secret; tidak ditulis ke file env mana pun; dihapus `scripts/serve.ts` dari environment anak seperti variable provisioning |

**Value sourcing**:

| Aksi | Nilai | Sumber |
| --- | --- | --- |
| Masuk | Email ternormalisasi | Body `email` lewat aturan *Kebijakan* |
| Masuk | Akun dan hash password | `SELECT u.id, u.email, u.display_name, c.password_hash FROM users.users u JOIN auth.password_credentials c ON c.user_id = u.id WHERE u.email = $1` |
| Masuk | Hash pembanding untuk email tidak terdaftar | Hash tiruan per proses (*Token*) |
| Masuk | Hitungan percobaan | Satu transaksi pendek sendiri berisi `INSERT ... ON CONFLICT (key_hash) DO UPDATE ... RETURNING attempt_count` yang membuka jendela baru bila `window_started_at <= now() - interval '15 minutes'` |
| Masuk | Pembersihan percobaan | Transaksi pendek sendiri sesudah reservasi pada kedua jalur: `DELETE FROM auth.sign_in_attempts WHERE key_hash IN (SELECT key_hash FROM auth.sign_in_attempts WHERE window_started_at <= now() - interval '15 minutes' AND key_hash <> $1 LIMIT 10)` |
| Masuk | Verifikasi password | Opsi `auth.verify` `createApp` bila diberikan test, selain itu `Bun.password.verify`; dipanggil tepat sekali per percobaan yang lolos reservasi, dengan hash akun atau hash tiruan, tanpa koneksi atau transaksi yang terbuka |
| Masuk | Token, `token_hash`, token CSRF | *Token* |
| Masuk | `expires_at`, `idle_expires_at`, `created_at`, `last_seen_at`, `id` | `now() + interval '12 hours'`, `now() + interval '30 minutes'`, default kolom, dikembalikan `RETURNING` |
| Masuk | Urutan sesi bersamaan per akun dan password yang berubah | Transaksi masuk yang dimulai sesudah verifikasi: `pg_advisory_xact_lock(hashtextextended(user_id::text, 638727))`, lalu `SELECT password_hash FROM auth.password_credentials WHERE user_id = $1` yang wajib sama dengan hash yang diverifikasi (selain itu rollback dan 401), lalu rotasi, sesi baru, pencabutan sesi di luar 10 terbaru menurut `last_seen_at`, `created_at`, dan penghapusan baris percobaan |
| Masuk | Sesi yang diganti | Cookie request yang valid, dicabut `replaced` pada transaksi yang sama |
| Semua route | Origin yang diizinkan | `PUBLIC_ORIGIN` atau default development (*Konfigurasi*), diberikan `index.ts` ke `createApp` lewat opsi `publicOrigin`; tanpa opsi, development memakai origin bawaan dan production tidak mengizinkan origin apa pun |
| Semua route | Nama dan atribut cookie | Mode `createApp` (*Cookie sesi*) |
| Semua route | Batas slot verifikasi | Opsi `auth.slots` `createApp` bila diberikan test, selain itu konstanta `auth.policy.ts` (4 berjalan, antrean 12, tunggu 2.000 ms) |
| GET sesi | `user`, `session`, `csrfToken` | Join sesi aktif dengan `users.users` via `token_hash`; token CSRF dari cookie |
| Request terautentikasi | Perpanjangan sesi | Satu statement sesudah resolusi sesi: `UPDATE auth.sessions SET last_seen_at = now(), idle_expires_at = least(now() + interval '30 minutes', expires_at) WHERE id = $1 AND revoked_at IS NULL AND idle_expires_at > now() AND last_seen_at <= now() - interval '60 seconds'`; nol baris berarti tidak ada perpanjangan, bukan galat. Setiap `UPDATE` sesi lain di backend dan perintah operator juga memuat `revoked_at IS NULL`, karena grant kolom mengizinkan nilai apa pun dan database tidak mencegah pencabutan dibatalkan |
| Daftar sesi | `current` | `sessions.id` sama dengan id sesi pemanggil |
| Pencabutan | Pemilik | `UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'revoked' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND idle_expires_at > now()`; nol baris → 404. Statement ini dan *Perpanjangan sesi* pemanggil berjalan dalam urutan id sesi, sehingga dua sesi yang saling mencabut tidak membentuk deadlock (keputusan 75 rationale) |
| Semua waktu | Jam | `now()` PostgreSQL; jam proses backend tidak pernah dipakai untuk kedaluwarsa |
| Log | `requestId` | Id yang dicatat `onRequest` plugin log spec 0012 untuk request itu, dibaca lewat `requestIdFor(request)` (*Log keamanan*), sehingga baris request dan baris `auth` satu request selalu sama |
| Log | `userId`, `sessionId`, `accountKey`, sink | Kolom sesi, *Token*, dan sink `AppOptions.log` yang sama dengan log request |
| Operator | Email, nama, password | Argumen, argumen, `FOUNDATION_ACCOUNT_PASSWORD` |
| Operator | Jumlah sesi dicabut | Jumlah baris `UPDATE` |
| Frontend | Token CSRF dan identitas | Body `AuthSession` dari masuk atau `getAuthSession`, disimpan di signal memori `core/session/` |
| Frontend | Pesan sesudah pindah ke `/masuk` | Signal `notice` (`expired`, `signed-out`, atau kosong) di `core/session/session-state.ts`, diisi sebelum navigasi dan dibaca lalu dikosongkan `/masuk` saat dibuat; tidak lewat query, state router, atau storage |
| Frontend | Waktu sesi | `createdAt` dan `lastSeenAt` dari API sebagai atribut `datetime` elemen `<time>`, teksnya `Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' })` pada zona waktu browser |
| Frontend | Teks | Tabel *Teks halaman* dan *State halaman* |
| Deployment | Origin publik | `FOUNDATION_PUBLIC_ORIGIN` di env file test, sama dengan URL edge `https://localhost:<port>` run itu |
| Test | Sidik token | `FOUNDATION_TEST_TOKEN_KEY` dan `FOUNDATION_TEST_TOKEN_FINGERPRINTS` dari orkestrasi (*Sidik token uji*) |

**Log keamanan** (hanya komposisi production yang mempunyai sink log, spec 0012; satu baris JSON `info` ke stdout per event, dengan key tepat `time`, `level`, `event` bernilai `auth`, `requestId`, `action`, `outcome`, `userId`, `sessionId`, `accountKey`, dan nilai `null` bila tidak berlaku):

| `action` | `outcome` | `userId` dan `sessionId` | `accountKey` |
| --- | --- | --- | --- |
| `sign_in` | `succeeded`, `failed`, `limited`, `busy` | Hanya `succeeded` | Ada |
| `sign_out` | `succeeded` | Ada | `null` |
| `session_revoke` | `succeeded`, `not_found` | Pemanggil; `sessionId` adalah sesi yang dicabut hanya saat `succeeded` | `null` |
| `request_rejected` | `origin`, `csrf` | `null` | `null` |

Setiap request menulis tepat satu baris request spec 0012 ditambah paling banyak satu baris `auth`, dengan `requestId` yang sama. Baris request memuat path `DELETE /api/auth/sessions/<uuid>` apa adanya; UUID sesi bukan credential. Untuk itu `plugins/request-log.ts` menyimpan `{ at, id }` per request di satu `WeakMap` tingkat modul (bukan per instance plugin) yang diisi `onRequest` plugin log, dan mengekspor `requestIdFor(request)` (id yang tercatat, atau id baru yang langsung dicatat bila belum ada) serta `writeRequestLine(sink, request, status)` (menulis baris request dari entri itu lalu menghapusnya, sehingga `onAfterResponse` tidak menulis baris kedua). Guard `onRequest` plugin auth memanggil `writeRequestLine` untuk setiap jawabannya karena `onAfterResponse` tidak berjalan untuk jawaban `onRequest` (probe); event `auth` ditulis lewat sink `AppOptions.log` yang sama dengan `requestIdFor`. `createRequestLog(sink)` tetap mengembalikan plugin Elysia, sehingga pemakai lamanya tidak berubah. Rekomendasi alert untuk platform: lebih dari 50 `sign_in` `failed` atau `limited` per 5 menit, lebih dari 20 per `accountKey` per 5 menit, atau lebih dari 50 jawaban edge 429 pada `/api/auth/session` per 5 menit.

**Halaman** (`apps/frontend/src/app/features/auth/`, route lazy di `app.routes.ts`, untuk build development dan production):

| Route | Isi dan perilaku |
| --- | --- |
| `/masuk` | Judul `Masuk`; form `novalidate` dengan email (`type="email"`, `autocomplete="username"`) dan password (`type="password"`, `autocomplete="current-password"`), tombol `Masuk`. Tidak memanggil API saat dibuka. Kirim: email di `trim`; bila email atau password kosong, teks isian kosong tanpa request; selain itu tombol dinonaktifkan sampai hasil adapter tiba. Berhasil → state sesi di `core/session/` diisi, navigasi ke `/akun`. Gagal → teks galat, input email tetap, password dikosongkan, tombol aktif lagi |
| `/akun` | Judul `Akun`; bagian `Profil` (nama dan email) dan `Sesi aktif` (setiap sesi: waktu dibuat dan terakhir aktif sebagai `<time>` baris *Waktu sesi* tabel *Value sourcing*, penanda `Sesi ini` pada sesi pemanggil, dan tombol `Akhiri sesi` hanya pada sesi lain), serta tombol `Keluar`. Saat dibuka memanggil `getAuthSession` lalu `listAuthSessions`. Tanpa dialog konfirmasi; tombol yang sedang berjalan dinonaktifkan |
| Navigasi | Item statis `Akun` menuju `/akun` di semua build (production: Beranda, Akun; development: Beranda, Akun, Kesiapan). Navigasi dan shell tidak memanggil API; input `user` wrapper diisi dari state `core/session/` bila sudah diketahui, kosong bila belum |

`core/session/session-state.ts` hanya berisi state signal (status, user, token CSRF, `notice`) tanpa impor SDK; adapter fitur `auth` dan halaman mengisinya. `core/` tidak mengimpor `features/`.

**Pemetaan adapter** (`AuthApi`, `@Service()`, method mengembalikan `Observable` dingin tanpa error; status 502 dan 504 dari proxy development dan status 0 menjadi `network`):

| Method | Hasil |
| --- | --- |
| `signIn(email, password)` | `signed-in` dengan `AuthSession`, `invalid` (401), `limited` (429), `forbidden` (403), `unavailable` (503), `network`, `failed` (selain itu) |
| `session()` | `signed-in`, `unauthenticated` (401), `unavailable`, `network`, `failed` |
| `sessions()` | `listed` dengan daftar, `unauthenticated`, `unavailable`, `network`, `failed` |
| `signOut(csrfToken)` | `signed-out` (204), `forbidden`, `unavailable`, `network`, `failed` |
| `revoke(sessionId, csrfToken)` | `revoked` (204), `unauthenticated`, `not-found` (404), `forbidden`, `unavailable`, `network`, `failed` |

**Teks halaman**:

| State | Teks |
| --- | --- |
| Isian kosong | `Isi email dan password.` |
| `invalid` | `Email atau password salah.` |
| `limited` | `Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.` |
| `forbidden` | `Permintaan ditolak. Muat ulang halaman, lalu coba lagi.` |
| `unavailable` | `Layanan belum tersedia. Coba lagi beberapa saat lagi.` |
| `network` | `Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.` |
| `failed` | `Permintaan gagal. Coba lagi beberapa saat lagi.` |
| Sesi berakhir | `Sesi Anda berakhir. Masuk lagi untuk melanjutkan.` |
| Sudah keluar | `Anda sudah keluar.` |
| Memuat akun | `Memuat akun.` |
| Tombol muat ulang akun | `Coba lagi` |
| Pencabutan berhasil | `Sesi diakhiri.` |
| Sesi yang dicabut sudah tidak ada (`not-found`) | `Sesi sudah berakhir.` |
| Pencabutan gagal (`failed`) | `Sesi tidak dapat diakhiri. Coba lagi.` |

**State halaman** (setiap halaman mempunyai satu wilayah `role="alert"` untuk galat dan satu wilayah `role="status"` untuk pesan lain, keduanya di awal konten utama dan selalu ada di DOM; masing masing menampilkan paling banyak satu teks, dan teks baru menggantikan yang lama):

| Halaman | Keadaan | Teks | Wilayah | Perilaku |
| --- | --- | --- | --- | --- |
| `/masuk` | Dibuka dengan `notice` `expired` | Sesi berakhir | `status` | `notice` dikosongkan |
| `/masuk` | Dibuka dengan `notice` `signed-out` | Sudah keluar | `status` | `notice` dikosongkan |
| `/masuk` | Isian kosong | Isian kosong | `alert` | Tanpa request |
| `/masuk` | `invalid`, `limited`, `forbidden`, `unavailable`, `network`, `failed` | Teks state yang sama | `alert` | Password dikosongkan |
| `/akun` | Memuat | Memuat akun | `status` | Bagian profil dan sesi belum tampil |
| `/akun` | `session()` atau `sessions()` `unauthenticated` | | | State dikosongkan, `notice` `expired`, navigasi ke `/masuk` dengan `replaceUrl` |
| `/akun` | `session()` atau `sessions()` `unavailable`, `network`, `failed` | Teks state yang sama | `alert` | Tombol `Coba lagi` mengulang kedua panggilan |
| `/akun` | Pencabutan `revoked` | Pencabutan berhasil | `status` | Daftar dimuat ulang lewat `sessions()` |
| `/akun` | Pencabutan `not-found` | Sesi yang dicabut sudah tidak ada | `alert` | Daftar dimuat ulang lewat `sessions()` |
| `/akun` | Pencabutan `forbidden`, `unavailable`, `network` | Teks state yang sama | `alert` | Daftar tetap |
| `/akun` | Pencabutan `failed` | Pencabutan gagal | `alert` | Daftar tetap |
| `/akun` | Pencabutan `unauthenticated` | | | Sama dengan `unauthenticated` saat memuat |
| `/akun` | Keluar `signed-out` | | | State dikosongkan, `notice` `signed-out`, navigasi ke `/masuk` |
| `/akun` | Keluar `forbidden`, `unavailable`, `network`, `failed` | Teks state yang sama | `alert` | State tetap, tombol `Keluar` aktif lagi |

Test memeriksa atribut `datetime` sama dengan nilai API dan teks `<time>` tidak kosong, bukan teks tanggal tertentu, sehingga locale Playwright tidak berpengaruh.

**Perubahan deployment** (amandemen spec 0012):

| Bagian | Perubahan |
| --- | --- |
| `app.ts` | Teks akhir *Teks akhir `createApp`* di bawah: kedua komposisi memasang plugin auth sesudah log request dan sebelum health; production tetap tanpa OpenAPI dan route development |
| `deploy/compose.yaml` | `backend.environment.PUBLIC_ORIGIN: ${FOUNDATION_PUBLIC_ORIGIN:?}`; `.env.deploy.example` menambah baris wajib bukan secret |
| `database/Dockerfile` dan `.dockerignore` nya | `!libs/server/auth/` dan `COPY libs/server/auth/ /app/libs/server/auth/` |
| `apps/frontend/edge/nginx.conf` | `map "$request_method:$foundation_path" $foundation_sign_in_client` (`"POST:/api/auth/session"` → `$binary_remote_addr`, selain itu kosong), `limit_req_zone $foundation_sign_in_client zone=sign_in:10m rate=30r/m`, `limit_req_status 429`, di location `/api/` `limit_req zone=sign_in burst=10 nodelay` dan `error_page 429 @api_too_many_requests`, named location yang menjawab `{"error":"Too many requests"}` dengan header API dan `Cache-Control: no-store` |
| `DEPLOYMENT_CHECKS` | `auth_account_job` disisipkan sesudah `readiness_after_migration` (dijalankan sesudah seed dan readiness 200, sebelum edge dan `browser_flow`, karena alur browser membutuhkan akun); `auth_session_cookie`, `auth_origin_csrf`, `auth_capacity`, dan `auth_edge_rate_limit` disisipkan dalam urutan itu sesudah `browser_flow` dan sebelum `backend_shutdown_restart`. Urutan daftar sama dengan urutan eksekusi. Kriteria berbentuk `0014/AC-n`; `browser_flow` menambah `0014/AC-12` (spec `tests/e2e/deployment/auth.deployment.e2e.spec.ts` berjalan di invocation Playwright yang sama), `log_structure`, `log_correlation`, dan `log_no_data` menambah `0014/AC-10`, dan `container_environment` mengharapkan `PUBLIC_ORIGIN` pada backend (`SERVICE_ENVIRONMENT` dan `declarationProblems` di `tests/orchestration/deployment-real.ts`) |
| Anggaran request masuk lewat edge | Semua alamat client run sama (bridge Docker), sehingga satu bucket edge dipakai bersama. `browser_flow`, `auth_session_cookie`, dan `auth_origin_csrf` bersama sama mengirim paling banyak 10 `POST /api/auth/session` lewat edge (masing masing mencatat jumlahnya di `detail`), sehingga tidak satu pun dari check itu dapat menerima 429 edge berapa pun durasinya. Sesudah `auth_edge_rate_limit` tidak ada lagi `POST /api/auth/session` lewat edge di run itu |
| `auth_edge_rate_limit` | 30 `POST /api/auth/session` lewat edge, paling banyak 5 berjalan bersamaan, masing masing dengan email berbeda yang bukan akun (seed run ditambah nomor), sehingga batas per akun tidak pernah menjawab dan akun uji tidak terkunci. Lulus bila setiap jawaban adalah 401 `{"error":"Invalid credentials"}` dari backend atau 429 `{"error":"Too many requests"}` dengan header API, paling sedikit satu jawaban 429, dan setiap 429 mempunyai baris log edge dengan `upstreamStatus` kosong dan tidak mempunyai baris request backend. Jumlah 401 dan 429 dicatat di `detail`. Dengan burst 10 dan isi ulang satu per 2 detik, paling banyak 11 ditambah satu per 2 detik durasi yang lolos edge, sehingga hasilnya tidak bergantung pada kecepatan runner |
| `auth_capacity` | 8 request masuk bersamaan dari dalam container backend ke `127.0.0.1:8888` (tidak lewat edge, sehingga batas edge tidak ikut) dengan `Origin` `FOUNDATION_PUBLIC_ORIGIN` dan akun kedua run (`FOUNDATION_DEPLOY_AUTH_OTHER_*`), yang di run itu tidak pernah menerima password salah: setiap jawaban 200 atau 503, paling sedikit 4 jawaban 200, durasi jawaban 200 terlama paling lama 2.000 ms, `GET /health/ready` yang dikirim bersamaan menjawab 200 (pool tidak habis karena verifikasi tidak menahan koneksi), dan backend tidak restart serta tidak `OOMKilled`; durasi dicatat di `detail` |
| `parseBackendLogLine` dan `BackendLogLine` | Varian baru `event` `auth` dengan key tepat `time`, `level`, `event`, `requestId`, `action`, `outcome`, `userId`, `sessionId`, `accountKey`: `level` `info`, `requestId` 32 heksadesimal kecil, `action` dan `outcome` menurut tabel *Log keamanan*, `userId` dan `sessionId` UUID atau `null` sesuai tabel itu, `accountKey` 16 heksadesimal kecil atau `null` sesuai tabel itu. `log_structure` menerima baris itu dengan aturan stream yang sama (info hanya stdout); filter yang hanya membaca baris request tetap mengabaikannya; `log_correlation` menambah pemeriksaan bahwa satu masuk lewat edge mempunyai baris request dan baris `auth` `sign_in` dengan `requestId` yang sama dengan header `X-Request-Id` jawabannya; test statis DEP menambah kasus parser untuk varian itu (diterima, key kurang atau lebih ditolak, nilai di luar kosakata ditolak) |
| Kebijakan endpoint | Baris baru *Auth* di `docs/rules/deployment.md`: route `/api/auth/` publik lewat edge dengan kontrol spec 0014; admin tetap tidak ada |

**Teks akhir `createApp`** (SDK-005 spec 0009 mengganti dua literal teks ini, sehingga keduanya ditulis persis):

```ts
export interface AppOptions {
  database?: SQL;
  log?: RequestLogSink;
  /** Origin publik dari index.ts (PUBLIC_ORIGIN). */
  publicOrigin?: string;
  /** Hanya test: tidak pernah dibaca dari environment dan tidak pernah diberikan index.ts. */
  auth?: { verify?: (password: string, hash: string) => Promise<boolean>; slots?: { running: number; queue: number; waitMs: number } };
}

export function createApp(mode: 'development' | 'production', options: AppOptions = {}) {
  const app = new Elysia().onError(/* tidak berubah */);
  if (options.log !== undefined) app.use(createRequestLog(options.log));
  const healthRoutes = createHealthRoutes(options.database);
  const authRoutes = createAuthRoutes(mode, options);
  if (mode === 'production') return app.use(authRoutes).use(healthRoutes);
  return app.use(openapi({
    provider: null, openapiVersion: '3.1.0',
    documentation: { info: { title: 'Foundation development API', version: '0.1.0' }, tags: [{ name: 'auth' }, { name: 'development' }, { name: 'health' }], security: [], components: { securitySchemes: { sessionCookie: /* tabel Model kontrak */ } } },
  })).use(createReadinessRoutes(options.database)).use(developmentRoutes).use(authRoutes).use(healthRoutes);
}
```

Literal SDK-005 yang baru: `tags: [{ name: 'auth' }, { name: 'development' }, { name: 'health' }]` dan `.use(developmentRoutes).use(authRoutes).use(healthRoutes);`.

**Keputusan hook backup** (mengisi *Hook fitur 15* spec 0013):

| Butir | Keputusan |
| --- | --- |
| 1 | `database/accounts.ts revoke-sessions --all --apply` sebagai job `migrate` di image runner dengan `foundation_migrator` lalu `foundation_owner`, selalu saat backend berhenti; langkah 8 *Runbook restore* pada project target (sebelum backend dijalankan langkah 9), dan pada *Prosedur insiden* untuk kehilangan data (lewat langkah 8 itu), credential bocor, dan backup bocor (backend dihentikan, perintah dijalankan, lalu backend dijalankan lagi) |
| 2 | BKP-009 (AC-14) |
| 3 | Tabel sesi dan percobaan ikut backup (backup tanpa filter schema tetap), lalu seluruh sesi dicabut saat restore. Hash password yang ikut bocor memicu reset paksa: operator membaca daftar email lewat koneksi admin yang sama dengan bagian *Rotasi password role* aturan deployment dengan query tepat `SELECT email FROM users.users ORDER BY email`, hanya ke terminal nya, lalu menjalankan `set-password` untuk setiap email itu dengan password baru yang dikirim lewat jalur di luar aplikasi, sampai fitur pemulihan akun tersedia |
| 4 | Enkripsi sisi client dan tanda tangan backup tidak ditambahkan di fitur ini. Risiko diterima dan dicatat: token sesi hanya tersimpan sebagai SHA 256 dari 256 bit acak dan dicabut saat restore, token CSRF tidak disimpan, password memakai Argon2id dengan minimal 15 karakter, dan keaslian archive tetap dijaga pembandingan sha256 dengan catatan independen. Enkripsi terautentikasi menjadi tindak lanjut saat platform penyimpanan dipilih |
| 5 | Fitur ini tidak menyalakan row level security; model akses backup tidak berubah |

**Key invariants**:

1. Database tidak pernah menyimpan token sesi atau token CSRF mentah; response tidak pernah memuat password, hash password, token sesi, atau `token_hash`.
2. Identitas pemanggil hanya berasal dari sesi yang tervalidasi lewat cookie; `user_id` tidak pernah dibaca dari body, path, atau header lain.
3. Sesi berakhir (dicabut atau kedaluwarsa) tidak pernah menjadi aktif lagi; setiap pencabutan menulis `revoked_at` dan `revoked_reason` bersama. Database tidak mencegah pembatalan pencabutan (grant kolom dan CHECK menerima `revoked_at = NULL`, dan trigger tidak dipakai), sehingga kontrolnya adalah setiap `UPDATE` sesi memuat `revoked_at IS NULL`, perpanjangan memakai statement tunggal *Perpanjangan sesi*, dan tidak ada statement yang menulis `NULL` ke `revoked_at`.
4. Setiap masuk yang berhasil menghasilkan token baru; token dari client tidak pernah diterima sebagai token sesi baru (tanpa session fixation).
5. Respons masuk gagal identik untuk akun ada dan tidak ada, dan batas percobaan berlaku sama untuk keduanya.
6. Semua kedaluwarsa dibandingkan dengan `now()` database dalam query yang sama dengan lookup.
7. Route GET tidak mengubah data akun atau bisnis; hanya `last_seen_at` dan `idle_expires_at` yang diperbarui.
8. Setiap transaksi auth backend memakai `SET LOCAL statement_timeout = '2s'`; galat database menjadi 503 tanpa pesan database.
9. Konfigurasi production tidak dapat menonaktifkan `Secure`, `HttpOnly`, `SameSite=Strict`, atau pemeriksaan origin lewat environment; opsi `auth` `createApp` hanya untuk test, tidak pernah dibaca dari environment, dan tidak pernah diberikan `index.ts`.
10. Tidak ada koneksi pool atau transaksi yang ditahan selama hash atau verifikasi Argon2id: reservasi, pembersihan percobaan, dan lookup masing masing satu transaksi pendek sendiri (dengan batas invariant 8) yang selesai sebelum verifikasi, dan transaksi masuk baru dimulai sesudah verifikasi berhasil. Pool backend tetap 5 koneksi.
11. Penolakan langkah 1 sampai 4 hanya terjadi di guard `onRequest` dengan `Response`, sehingga handler tidak pernah berjalan untuk request yang ditolak; `onTransform` tidak dipakai untuk menolak.

**Security model**: Sesi opaque di server dengan cookie `HttpOnly`, `SameSite=Strict`, dan prefix `__Host-` di production; CSRF dicegah berlapis oleh `SameSite=Strict`, pemeriksaan `Origin` dan `Sec-Fetch-Site`, `Content-Type` JSON untuk masuk (form lintas situs tidak dapat mengirimnya tanpa preflight, dan tidak ada CORS), dan token CSRF terikat sesi untuk route `DELETE`. Masuk dilindungi Argon2id, batas per akun di database bersama (berlaku lintas container), batas per alamat client di edge (backend tidak menerima alamat client, spec 0012), batas verifikasi per proses, dan jawaban identik tanpa enumerasi. Otorisasi adalah kepemilikan sesi; pengguna A tidak dapat membaca, mencabut, atau mendeteksi sesi B. Operator memakai credential migrator dan role owner lewat job runner, tidak lewat endpoint; penggantian password diurutkan dengan masuk lewat lock per akun dan pembacaan ulang hash, sehingga password yang bocor tidak menghasilkan sesi sesudah reset. Pembatalan pencabutan oleh backend dicegah oleh bentuk statement, bukan oleh database (invariant 3). Data pribadi yang disimpan: email dan nama tampilan; tidak ada alamat IP atau user agent. `key_hash` percobaan dan `accountKey` log adalah SHA 256 tanpa kunci dari email, sehingga pembaca log atau backup dapat memastikan apakah email tebakan pernah dicoba masuk; risiko ini diterima dan dicatat (keputusan 77 rationale). Belum ada kewajiban regulasi yang dipilih produk; retensi backup 35 hari spec 0013 berarti data akun yang dihapus kelak masih ada di backup selama itu. Rujukan kontrol: OWASP ASVS (sesi, autentikasi, CSRF) dan cheat sheet OWASP yang tercantum di aturan keamanan.

**Configuration required**: `PUBLIC_ORIGIN`, `FOUNDATION_PUBLIC_ORIGIN`, dan `FOUNDATION_ACCOUNT_PASSWORD` menurut tabel *Konfigurasi*. Tidak ada secret server baru, karena token CSRF diturunkan dari token sesi.

**Dokumen yang diperbarui** (AUTH-014 memeriksa setiap string secara harfiah, kecuali `docs/rules/backup.md` yang diperiksa BKP-001):

| File | String wajib |
| --- | --- |
| `docs/rules/security.md` | `spec 0014`, `__Host-foundation_session`, `SameSite=Strict`, `X-CSRF-Token`, `m=19456,t=2,p=1`, `10 percobaan per 15 menit`, `onRequest` |
| `docs/rules/database.md` | `users.users`, `auth.password_credentials`, `auth.sessions`, `auth.sign_in_attempts`, `GRANT SELECT (id, email, display_name) ON users.users TO foundation_backend`, `role worker pembersihan`, `revoked_at IS NULL` |
| `docs/rules/deployment.md` | `FOUNDATION_PUBLIC_ORIGIN`, `limit_req zone=sign_in`, `database/accounts.ts create`, `-e FOUNDATION_ACCOUNT_PASSWORD`, `revoke-sessions --all --apply`, `publik lewat edge dengan kontrol spec 0014`, `sign_in` |
| `docs/rules/backup.md` | Baris pertama langkah 8 `8. Cabut seluruh sesi sebelum backend berjalan (*Hook fitur 15*):` diikuti blok perintah yang memuat `--profile migrate run --rm migrate database/accounts.ts revoke-sessions --all --apply` dan keluaran `Sessions revoked:`; baris insiden kehilangan data memuat `Cabut seluruh sesi lewat langkah 8 *Runbook restore*`; baris insiden credential bocor memuat `cabut seluruh sesi dengan backend berhenti`; baris insiden backup bocor memuat `SELECT email FROM users.users ORDER BY email` dan `set-password`; paragraf penutup *Hook fitur 15* tepat `Kontrak ini terisi oleh spec 0014 (tabel *Keputusan hook backup*).`; bagian itu tetap lima butir bernomor; string `tidak berlaku sampai fitur 15` tidak ada lagi di file itu |
| `docs/rules/openapi-sdk.md` | `sessionCookie`, `x-csrf-token`, `Route 204 yang juga mendeklarasikan galat tidak memakai map response` |
| `docs/rules/development-commands.md` | `bun run db:accounts create`, `FOUNDATION_ACCOUNT_PASSWORD`, `http://127.0.0.1:8889` |
| `docs/rules/testing.md` | `tests/scenarios/auth.json`, `FOUNDATION_TEST_TOKEN_FINGERPRINTS`, `FOUNDATION_E2E_ACCOUNT_EMAIL` |
| `README.md` | `bun run db:accounts` |
| `.env.example` | `# PUBLIC_ORIGIN=` |

**Amandemen spec lain** (ditulis sebagai catatan bertanggal pada spec terkait saat langkah build yang mewujudkannya selesai, bukan sebelumnya):

| Spec | Amandemen |
| --- | --- |
| 0003 | `test:tooling:real` membuat dua akun uji sesudah migration dan menjalankan `tests/e2e/auth/auth.real.e2e.spec.ts` di bawah `serve`; `serve` menghapus `FOUNDATION_ACCOUNT_PASSWORD` dari environment anak |
| 0004 | AC-3 dan matriks role: grant tabel `foundation_backend` menurut *Matriks grant backend*; role dan atribut tidak berubah |
| 0006 | READY-007: navigasi production berisi Beranda dan Akun; READY-006: Beranda, Akun, Kesiapan; tetap tanpa request `/api/` di `/` dan `/kesiapan`. `test:readiness:real` membuat dua akun uji dan memindai password serta sidik tokennya |
| 0007 | Item navigasi `Akun` |
| 0008 | Tiga entri *Operasi wajib baru*; tabel *Aturan checker* tidak berubah; resep *Ekspor route 204 dengan galat* melengkapi resep 204 tanpa galat |
| 0009 | SDK-005 memakai literal baru *Teks akhir `createApp`*; harness backend tetap lima variable |
| 0012 | Tabel *Perubahan deployment*; log backend production menjadi satu baris request per request ditambah paling banyak satu baris `auth` dengan `requestId` yang sama (semula satu baris per request); guard `onRequest` plugin auth menulis baris request nya sendiri; DEP-006 navigasi production Beranda dan Akun; `PUBLIC_ORIGIN` wajib untuk backend production |
| 0013 | *Keputusan hook backup*; field `sessions` `restore.json` (`{ beforeRevokeStatus: 200, afterRevokeStatus: 401, revoked: number, rerunRevoked: 0 }`, dengan `sessions` di himpunan `failures`); BKP-009; string wajib BKP-001 untuk `docs/rules/backup.md` menurut tabel *Dokumen yang diperbarui* (string `tidak berlaku sampai fitur 15` keluar dari daftar dan AC-9 spec 0013 tidak lagi memintanya); batas `bun test` `test:database:real` naik dari 600.000 ms menjadi 900.000 ms dengan grace 75.000 ms tetap, masih di bawah batas langkah tier nyata 1.500.000 ms |

**Test dan file lama yang berubah** (diubah pada commit yang sama dengan perubahan yang memicunya):

| File | Perubahan |
| --- | --- |
| `tests/integration/backend/application.test.ts` | `readConfiguration` production (baris 49) dan listener bundle production (baris 96) memberi `PUBLIC_ORIGIN` `https://foundation.test`; kasus baru production tanpa `PUBLIC_ORIGIN`, dengan `http:`, dengan path, dan dengan garis miring akhir gagal `Invalid PUBLIC_ORIGIN configuration` |
| `tests/integration/backend/logging.test.ts` | Ketiga spawn production (baris 379, 489, 524) memberi `PUBLIC_ORIGIN`; DEP-007 menambah baris `auth` pada sink, `requestId` yang sama dengan baris request, dan satu baris request untuk jawaban guard |
| `tests/integration/backend/readiness.test.ts` | Spawn production (baris 219) memberi `PUBLIC_ORIGIN` |
| `tests/integration/contract/sdk.test.ts` | SDK-005 memakai dua literal baru *Teks akhir `createApp`* |
| `tests/integration/deployment/static.test.ts` (DEP-001) | `nginx.conf` (`map`, `limit_req_zone`, `limit_req`, named location 429), `deploy/compose.yaml` (`PUBLIC_ORIGIN`), `.env.deploy.example`, `database/Dockerfile` dan `.dockerignore` nya (`libs/server/auth/`), serta setiap pemeriksaan yang menjalankan backend production di luar Compose memberi `PUBLIC_ORIGIN` |
| `tests/orchestration/deployment-real.ts` | Check baru, urutan, dan anggaran tabel *Perubahan deployment*; `BackendLogLine` dan `parseBackendLogLine`; `SERVICE_ENVIRONMENT` dan `declarationProblems` dengan `PUBLIC_ORIGIN`; akun uji lewat job `migrate`; *Sidik token uji* |
| `scripts/lib/gate.ts` | Baris `DEPLOYMENT_CHECKS`; batas langkah tier nyata 1.500.000 ms tidak berubah |
| `tests/integration/gate/*.test.ts` | Jumlah dan nama `DEPLOYMENT_CHECKS` di test tier, laporan, dan release |
| `tests/orchestration/database-real.ts` | Batas `bun test` 900.000 ms (grace 75.000 ms tetap), suite `auth.test.ts`, dan *Sidik token uji* |
| `tests/orchestration/readiness-real.ts` dan orkestrasi `test:tooling:real` | Dua akun uji pada database milik run, password di daftar pindai, *Sidik token uji* |
| `tests/integration/database/backup.test.ts` | `beforeAll` membuat akun di sumber lewat `database/accounts.ts create` dengan DSN migrator sumber, lalu satu masuk lewat `createApp('production', { database: <pool backend sumber>, publicOrigin: 'https://foundation.test' })`, sebelum backup BKP-003. Daftar tabel sumber BKP-003 menjadi `auth.password_credentials`, `auth.sessions`, `auth.sign_in_attempts`, `common.schema_migrations`, `users.restore_fixture`, `users.users` (urutan mengikuti asersi yang ada); jumlah baris per tabel, `migrations.count` 11, dan `migrations.last` berakhiran nama migration fixture `0011-users-restore-fixture.sql`; isi fingerprint dan tabel di `restore.json` mengikuti. BKP-009 menjadi test terakhir file itu, sesudah test probe fingerprint, dan gagal dengan alasan bernama bila lebih dari 25 menit berlalu sejak masuk di sumber (masa idle 30 menit), bukan dengan 401 yang menyesatkan |
| `tests/integration/deployment/backup-static.test.ts` (BKP-001) | String wajib `docs/rules/backup.md` tabel *Dokumen yang diperbarui*, termasuk baris pertama langkah 8 dan ketiga baris insiden; pemeriksaan lima butir *Hook fitur 15* tetap |
| `tests/integration/database/migration.test.ts`, test DEP rerun, `tests/integration/tooling-real/doctor-smoke.ts` | Jumlah migration repository 10 |
| `tests/e2e/ui-shell/foundation-shell.e2e.spec.ts`, `tests/e2e/readiness/readiness.e2e.spec.ts`, `tests/e2e/readiness/readiness-production.e2e.spec.ts`, `tests/e2e/deployment/edge.deployment.e2e.spec.ts`, `apps/frontend/src/app/app.spec.ts` | Navigasi: production Beranda dan Akun, development Beranda, Akun, Kesiapan, termasuk urutan tautan dan `aria-current` |
| `tsconfig.tooling.json`, `tsconfig.contract.json`, `tsconfig.e2e.json` | `database/accounts.ts`, `tests/integration/database/auth.test.ts`, `tests/integration/backend/auth.test.ts`, `tests/integration/deployment/auth-static.test.ts`, dan `tests/e2e/auth/*.ts` masuk ke daftar file atau `include` yang sesuai, sehingga setiap file baru diperiksa salah satu `typecheck` |
| `tests/orchestration/signal-cleanup.ts` dan `tests/integration/gate/signal-cleanup.test.ts` (GATE-009) | Resource suite `auth.test.ts` dan folder sidik token didaftarkan sebelum dibuat |

**Sidik token uji** (cara pemindaian artefak mencakup token tanpa pernah menulis token): setiap orkestrasi yang menjalankan test auth (`test:database:real`, `test:readiness:real`, `test:tooling:real`, `test:deployment:real`) membuat kunci acak 32 byte dan file kosong mode 0600 di folder `mkdtemp` miliknya sendiri di luar setiap akar artefak yang dipindai, mendaftarkan folder itu ke `signal-cleanup.ts`, lalu memberikan `FOUNDATION_TEST_TOKEN_KEY` (heksadesimal) dan `FOUNDATION_TEST_TOKEN_FINGERPRINTS` (path file) ke proses anak test. Setiap test yang memperoleh token sesi (Playwright `context.cookies()`, atau `Set-Cookie` di `bun:test`) atau token CSRF (body `AuthSession`) menambah satu baris HMAC SHA 256 heksadesimal dengan kunci itu atas token, tidak pernah token nya; check yang dijalankan orkestrasi deployment sendiri menambah sidik ke himpunan di memori. Sesudah proses anak selesai, orkestrasi membaca himpunan sidik (wajib tidak kosong bila langkah itu menjalankan test masuk, sehingga mekanisme tidak dapat terlewat diam diam), lalu pada setiap file yang sudah dipindainya (JUnit, `restore.json`, bundle frontend, `test-results` termasuk screenshot, `artifact-scan.json`, `result.json`, dan keluaran container) menghitung HMAC setiap deret tepat 43 karakter `[A-Za-z0-9_-]` yang dibatasi karakter lain atau tepi file; satu kecocokan adalah temuan. Password akun uji dipindai sebagai nilai biasa. Folder sidik dihapus sesudah pemindaian. Trace Playwright tetap `off` pada `playwright.real.config.ts` dan `playwright.deployment.config.ts`, karena archive trace terkompresi tidak dapat dipindai.

**Critical test scenarios** (registry `tests/scenarios/auth.json`, kecuali BKP-009 di `tests/scenarios/backup.json`):

| ID | Pembuktian | File dan script | AC |
| --- | --- | --- | --- |
| AUTH-001 | Bentuk tabel, constraint, FK, index, owner, tanpa RLS; rerun runner; provisioning `verified` | `tests/integration/database/auth.test.ts`, `test:database:real` | AC-1 |
| AUTH-002 | Setiap baris diizinkan dan ditolak *Matriks grant backend*, `PUBLIC`, dan `foundation_backup` | `tests/integration/database/auth.test.ts`, `test:database:real` | AC-2 |
| AUTH-003 | Setiap baris *Perintah operator* dengan stream dan exit, *Prioritas galat*, aturan nama tampilan dan password penetapan, `updated_at` sesudah `set-password`, idempotensi, pencabutan saat ganti password, `set-password` yang berpacu dengan masuk yang ditahan di antara verifikasi dan transaksi (lewat opsi `auth.verify` yang menunggu sinyal test) sehingga tidak ada sesi aktif sesudahnya, keluaran tanpa secret; job di image runner | `auth.test.ts` (`test:database:real`) dan check `auth_account_job` (`command`, `test:deployment:real`) | AC-3 |
| AUTH-004 | Masuk berhasil di kedua mode, atribut cookie, hash di database, rotasi, batas 10 sesi termasuk dua masuk bersamaan, hash yang berubah sesudah verifikasi menjawab 401 tanpa sesi | `auth.test.ts`, `test:database:real` | AC-4 |
| AUTH-005 | Jawaban identik akun ada dan tidak ada, satu verifikasi per jalur dihitung lewat opsi `auth.verify` dengan hash berawalan `$argon2id$v=19$m=19456,t=2,p=1$` pada kedua jalur, median durasi (test menghapus baris percobaan lewat koneksi admin di antara percobaan agar batas AC-6 tidak tercapai), email yang tidak lolos aturan *Email* sesudah normalisasi dan password di luar aturan *Password* (400 tanpa baris percobaan dan tanpa panggilan verifier), properti tidak dikenal dibuang, 400, 415 (termasuk media type huruf besar dan multipart tanpa boundary), 403 (termasuk origin salah dengan JSON rusak), 503 | `auth.test.ts` (`test:database:real`) dan `tests/integration/backend/auth.test.ts` (`test:integration`) | AC-5 |
| AUTH-006 | Batas per kunci, request bersamaan, jendela berakhir, pembersihan paling banyak 10 baris kedaluwarsa per percobaan, slot verifikasi dengan opsi `auth.verify` lambat dan `auth.slots`, batas edge | `auth.test.ts` (database dan backend) serta check `auth_edge_rate_limit` dan `auth_capacity` (`test:deployment:real`) | AC-6 |
| AUTH-007 | Idle, absolut, dicabut, cookie rusak dan ganda, perpanjangan paling sering 60 detik (waktu digeser lewat SQL admin), statement perpanjangan mengubah nol baris untuk sesi dicabut dan kedaluwarsa | `auth.test.ts`, `test:database:real` | AC-7 |
| AUTH-008 | Keluar, daftar, pencabutan sendiri, akses lintas pengguna 404 tanpa efek, token dikirim ulang ditolak, kedua `DELETE` tanpa sesi dengan header benar (204 dan 401) dan tanpa header (400), `sessionId` bentuk `urn:uuid:` dan huruf besar (400) | `auth.test.ts`, `test:database:real` | AC-8 |
| AUTH-009 | Origin hilang, salah, `null`, `Sec-Fetch-Site` lintas situs, form urlencoded, CSRF hilang dan salah, production tanpa `PUBLIC_ORIGIN`, validasi konfigurasi; origin palsu dengan body sah tidak mengubah `auth.sessions` dan `auth.sign_in_attempts` dan tidak memanggil verifier; origin palsu dengan JSON rusak 403; media type salah dengan body rusak 415; setiap jawaban guard menulis tepat satu baris log request; `Cache-Control: no-store` pada 400, 401, 403, 404, 415, dan 500; password bertipe salah menjawab body tepat `{"error":"Invalid request"}` | `tests/integration/backend/auth.test.ts` (`test:integration`), `auth.test.ts` database, check `auth_origin_csrf` | AC-9 |
| AUTH-010 | Log sink production tanpa nilai rahasia, response tanpa credential, browser storage kosong, pemindaian artefak keempat orkestrasi dengan *Sidik token uji* (termasuk kontrol positif: sidik token yang sengaja ditulis ke file sementara di luar artefak terdeteksi oleh fungsi pemindai) | `auth.test.ts` database, `tests/e2e/auth/auth.real.e2e.spec.ts`, check `log_no_data` | AC-10 |
| AUTH-011 | Kontrak OpenAPI (setiap operasi tepat status tabel *API surface*, 204 tanpa `content`, `$ref` `AuthError` pada setiap status galat), mutasi `REQUIRED_OPERATIONS`, adapter `AuthApi` | `tests/integration/contract/openapi-contract.test.ts` (`test:integration`), `apps/frontend/src/app/features/auth/auth-api.integration.spec.ts` (`test:frontend`) | AC-11 |
| AUTH-012 | Alur browser development: masuk, akun, dua konteks browser, akhiri sesi lain, keluar, akses lintas pengguna lewat API dari halaman, setiap baris *State halaman*, 1280×812 dan 375×812, keyboard; serta halaman masuk tanpa database (503) | `tests/e2e/auth/auth.real.e2e.spec.ts` (`test:readiness:real` dan `test:tooling:real`), `tests/e2e/auth/sign-in.e2e.spec.ts` (`test:e2e`); `critical` | AC-10, AC-12 |
| AUTH-013 | Alur production lewat edge dengan cookie `__Host-`, CSP final, navigasi, dan keluar | `tests/e2e/deployment/auth.deployment.e2e.spec.ts` (`test:deployment:real`) dan check `auth_session_cookie`; `critical` | AC-12, AC-13 |
| AUTH-014 | Setiap string wajib tabel *Dokumen yang diperbarui* selain `docs/rules/backup.md` ada secara harfiah, dengan mutasi yang menghapus satu string ditolak | `tests/integration/deployment/auth-static.test.ts` (`test:deployment:plan`) | AC-15 |
| BKP-009 | Akun dan sesi dibuat di sumber sebelum backup BKP-003 (sehingga fingerprint sumber sudah memuatnya); sebagai test terakhir `backup.test.ts`, sesi itu diterima di target, ditolak sesudah `revoke-sessions --all`, dan run kedua 0; password akun uji ikut daftar pindai `secretScan` dan tidak ada di dump | `tests/integration/database/backup.test.ts`, `test:database:real` | AC-14 |

Orkestrasi `test:readiness:real` dan `test:tooling:real` membuat dua akun uji pada database milik run itu lewat `database/accounts.ts create` dengan email dan password acak turunan seed run, menambah password ke daftar pindai, lalu meneruskan email dan password ke Playwright lewat `FOUNDATION_E2E_ACCOUNT_EMAIL`, `FOUNDATION_E2E_ACCOUNT_PASSWORD`, `FOUNDATION_E2E_OTHER_EMAIL`, dan `FOUNDATION_E2E_OTHER_PASSWORD`; `test:deployment:real` melakukan hal yang sama lewat job `migrate` dengan nama variable `FOUNDATION_DEPLOY_AUTH_*`. Token tidak pernah ditulis ke file mana pun; pemindaian token memakai *Sidik token uji*. `playwright.config.ts` tetap mengecualikan `*.real.e2e.spec.ts` dan `*.deployment.e2e.spec.ts`, sehingga pola file baru tercakup tabel pemilik `scripts/lib/test-inventory.ts` yang ada tanpa baris baru. Test yang menghitung jumlah migration repository diperbarui menurut tabel *Test dan file lama yang berubah*.

## Build plan

Urutan Tracer Bullet: satu benang tipis masuk sampai halaman akun lewat semua lapisan pada database nyata, lalu dipertebal per kemampuan, lalu dibuktikan di topologi deployment dan backup.

1. Benang tipis. Sembilan migration dan `REQUIRED_MIGRATION`; `libs/server/auth/credentials.ts` (aturan email, password, dan nama tampilan, parameter Argon2id); fungsi transaksi pemilik di `database/runner.ts` dan `database/accounts.ts create` dengan root script `db:accounts`; plugin auth backend dengan guard `onRequest` (langkah 1, 2, dan `Cache-Control: no-store`), `POST` dan `GET /api/auth/session` di kedua komposisi menurut *Teks akhir `createApp`*, cookie per mode, `PUBLIC_ORIGIN` di `readConfiguration`; ekspor `requestIdFor` dan `writeRequestLine` dari `plugins/request-log.ts`; `api:sync`; `core/session/`, adapter `AuthApi`, halaman `/masuk` dan `/akun` (profil saja), item navigasi `Akun`; `test:readiness:real` membuat akun dan satu test browser masuk sampai nama tampil; baris tabel *Test dan file lama yang berubah* yang dipicu langkah ini (spawn production dengan `PUBLIC_ORIGIN`, SDK-005, jumlah migration, navigasi). Satisfies **AC-1**, **AC-3**, **AC-4**, **AC-11**, **AC-12**.
2. Lifecycle sesi. `DELETE /api/auth/session`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{sessionId}` dengan resep *Ekspor route 204 dengan galat* dan pola `sessionId`, idle dan absolut, statement *Perpanjangan sesi*, rotasi, batas 10 dengan lock per akun dan pembacaan ulang hash, `set-password` dan `revoke-sessions` dengan lock per akun, tabel *Perintah operator* lengkap; bagian `Sesi aktif` dan tombol `Keluar`; suite `tests/integration/database/auth.test.ts` dengan GATE-009 dan `signal-cleanup.ts`; AUTH-001 sampai AUTH-004, AUTH-007, AUTH-008. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-7**, **AC-8**, **AC-12**.
3. Pertahanan. Guard `onRequest` lengkap (origin, `Sec-Fetch-Site`, aturan *Content-Type* 415, baris log request untuk jawabannya), token CSRF, aturan format email dan password sebelum slot, reservasi dan pembersihan percobaan, hash tiruan ber memo, slot verifikasi dan opsi `auth` `createApp`, log event `auth`, `REQUIRED_OPERATIONS` dan mutasinya, `tests/integration/backend/auth.test.ts`, test adapter, AUTH-005, AUTH-006, AUTH-009 sampai AUTH-011. Satisfies **AC-5**, **AC-6**, **AC-9**, **AC-10**, **AC-11**.
4. Frontend lengkap dan browser. Semua baris *State halaman* dan *Teks halaman*, signal `notice`, pencegahan kirim ganda, aksesibilitas, kedua viewport, `sign-in.e2e.spec.ts`, `auth.real.e2e.spec.ts` lengkap di `test:readiness:real` dan `test:tooling:real` (akun uji, pemindaian password, *Sidik token uji*), amandemen READY-006 dan READY-007; AUTH-012. Satisfies **AC-10**, **AC-12**.
5. Deployment. `deploy/compose.yaml`, `.env.deploy.example`, Dockerfile runner, edge `limit_req`, `DEPLOYMENT_CHECKS` dengan urutan dan anggaran tabel *Perubahan deployment*, varian `auth` `parseBackendLogLine`, *Sidik token uji* di orkestrasi deployment, `auth.deployment.e2e.spec.ts`, DEP-001, DEP-006, DEP-007, dan test gate yang menghitung check; AUTH-013. Satisfies **AC-6**, **AC-9**, **AC-10**, **AC-13**.
6. Hook backup. `beforeAll` akun dan sesi sumber, asersi BKP-003 dan BKP-004 yang baru, BKP-009 sebagai test terakhir `backup.test.ts`, field `sessions` di `restore.json` dan `restore-evidence.ts` bila perlu, batas `bun test` 900.000 ms dan *Sidik token uji* di `database-real.ts`, `docs/rules/backup.md` (langkah 8, prosedur insiden, keputusan hook) dengan string wajibnya dan BKP-001. Satisfies **AC-10**, **AC-14**.
7. Bukti dan dokumen. `tests/scenarios/auth.json`, setiap dokumen dan string wajib tabel *Dokumen yang diperbarui* dengan AUTH-014, sisa baris tabel *Test dan file lama yang berubah*, catatan amandemen spec lain, `serve` menghapus `FOUNDATION_ACCOUNT_PASSWORD`, lalu `bun run test:ci`, `bun run test:ci:real`, `bun run test:ci:security`, dan `bun run test:report`. Satisfies **AC-10**, **AC-15**.

## Consequences

**Positive**:

- Produk berikutnya mempunyai identitas dan sesi yang dapat dicabut di server, dengan bukti negatif lintas pengguna, CSRF, dan batas percobaan sejak alur pertama.
- Tidak ada dependency, secret server, role, atau schema baru; semua memakai Bun, PostgreSQL, runner, edge, dan gate yang ada.
- Operasi insiden dan restore akhirnya dapat mencabut sesi dengan satu job yang aman diulang.

**Negative / tradeoffs**:

- Implementasi auth sendiri menuntut test dan review yang ketat; kesalahan kecil di urutan pemeriksaan berdampak keamanan.
- Setiap request terautentikasi membaca database, dan paling sering sekali per menit per sesi juga menulis; tidak ada cache.
- Akun hanya dapat dibuat dan dipulihkan operator; pengguna yang lupa password bergantung pada operator.
- Batas percobaan per akun memungkinkan pihak lain mengunci akun selama 15 menit; batas edge per alamat dapat menahan banyak pengguna di balik satu NAT.
- Batas per alamat client tidak ada di development (tanpa edge).
- Navigasi production berubah, sehingga READY-007 dan DEP-006 diamandemen.
- Baris sesi bertambah sampai fitur 16 membersihkannya, paling banyak 43.200 baris per alamat client per hari oleh batas edge; baris percobaan dibatasi pembersihan bertahap paling banyak 10 baris per percobaan masuk.
- `signOut` dan `revokeAuthSession` tidak mempunyai validasi response saat runtime (resep *Ekspor route 204 dengan galat*), sehingga body nya dijaga satu fungsi pembentuk jawaban dan AUTH-008.
- Guard `onRequest` menulis baris log request nya sendiri, sehingga ada dua tempat yang menulis baris request (plugin log dan guard) dengan satu fungsi bersama.
- Test production lama yang menjalankan backend tanpa `PUBLIC_ORIGIN` harus diubah (tabel *Test dan file lama yang berubah*), dan `test:database:real` mendapat batas `bun test` lebih panjang.

**Neutral**:

- Satu peran implisit; otorisasi berbasis peran ditambahkan saat dibutuhkan, beserta rotasi sesi saat hak berubah.
- Profil k6 spec 0011 tidak berubah; kapasitas Argon2id dibuktikan check `auth_capacity`.

## Follow-up

- [ ] Registrasi mandiri bila produk membutuhkannya, termasuk pemeriksaan password terhadap daftar password umum.
- [ ] Ubah profil dan ganti password oleh pengguna, dengan pencabutan sesi lain.
- [ ] Pemulihan akun dengan token sekali pakai berbatas waktu (hash di `auth`) dan infrastruktur email; mengganti reset paksa manual butir 3 hook backup.
- [ ] MFA (misalnya TOTP atau passkey) dan peran selain pengguna, beserta rotasi sesi saat hak berubah.
- [ ] Nonaktif dan hapus akun lewat perintah operator.
- [ ] Rehash password saat masuk bila parameter Argon2id dinaikkan (membutuhkan `UPDATE (password_hash)` untuk backend).
- [ ] Label perangkat kasar pada daftar sesi bila pengguna kesulitan membedakan sesi.
- [ ] Job pembersihan sesi dan sisa percobaan di fitur 16 dengan kontrak role worker di atas; sampai itu, baris sesi yang berakhir hanya dibatasi batas edge (paling banyak 43.200 per alamat client per hari).
- [ ] Journey k6 untuk masuk saat ada target beban.
- [ ] Enkripsi terautentikasi atau tanda tangan backup saat platform penyimpanan dipilih (butir 4 hook backup).
- [ ] Alert platform untuk event `auth` dan 429 edge saat platform log dipilih.

## Rationale

Alasan, pilihan yang dibandingkan, dan seluruh keputusan agent ada di [rationale.md](rationale.md).
