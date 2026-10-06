# Verifikasi: akses pengguna dan lifecycle sesi · spec 0014 · diperbarui 2026-10-06

_Langkah diturunkan dari acceptance criteria spec 0014 dan tabel Value sourcing. `/check verify` menjalankannya; `/test` mengunci langkah yang tahan lama. Bagian ini mencakup milestone 1 (langkah 1 build plan, benang tipis): sembilan migration dan grant, `REQUIRED_MIGRATION`, `libs/server/auth/credentials.ts`, fungsi transaksi pemilik di `database/runner.ts`, `database/accounts.ts create` dengan root script `db:accounts`, plugin auth dengan guard `onRequest` langkah 1 dan 2 serta `Cache-Control: no-store`, `POST` dan `GET /api/auth/session` di kedua komposisi, cookie per mode, `PUBLIC_ORIGIN`, `requestIdFor` dan `writeRequestLine`, kontrak dan SDK, `core/session/`, adapter `AuthApi`, halaman `/masuk` dan `/akun` (profil saja), item navigasi `Akun`, serta akun uji dan satu test browser di `test:readiness:real` dan `test:tooling:real`. Milestone berikutnya menambahkan bagiannya sendiri: rotasi, batas 10 sesi, lock per akun, perpanjangan, keluar, daftar, dan pencabutan (milestone 2); origin, Content-Type, CSRF, batas percobaan, slot verifikasi, dan log `auth` (milestone 3). Catatan dalam tanda kurung dengan tanggal adalah hasil yang diamati saat build, bukan tanda bahwa langkah sudah diverifikasi. Jalankan langkah Docker tanpa suite lain yang sedang berjalan._

## Perintah: migration dan grant (AC-1, dasar AC-2)

- [x] Pada cluster PostgreSQL 18 baru dari `foundation-postgres:18-pinned`, jalankan `database/provision.ts --apply`, lalu `bun --no-env-file database/migrate.ts --apply` dengan `FOUNDATION_MIGRATOR_DATABASE_URL` → exit 0, baris `Applied:` untuk `0001` sampai `0010` berurutan, dan baris akhir `Migrations: 10 applied, 0 skipped`; run kedua → `Migrations: 0 applied, 10 skipped` (2026-10-06 saat build: sesuai) → AC-1
- [x] Provisioning ulang sesudah migration → exit 0 dan setiap baris berakhiran `verified`, termasuk `database privileges: verified` (2026-10-06 saat build: sesuai) → AC-1
- [x] Query admin `pg_constraint`, `pg_index`, dan `information_schema.columns` untuk schema `users` dan `auth` → kolom, tipe, nullability, default (`gen_random_uuid()`, `transaction_timestamp()`), constraint (`users_email_key`, `users_email_check`, `users_display_name_check`, `password_credentials_user_id_fkey` dengan `ON DELETE CASCADE`, `password_credentials_hash_check`, `sessions_user_id_fkey`, `sessions_token_hash_key`, `sessions_token_hash_check`, `sessions_revoked_reason_check`, `sessions_revocation_check`, `sessions_expiry_check`, `sign_in_attempts_key_hash_check`, `sign_in_attempts_count_check`), dan index parsial `sessions_user_active_idx (user_id, last_seen_at DESC) WHERE revoked_at IS NULL` persis seperti tabel *Model data* (2026-10-06 saat build: sesuai) → AC-1
- [x] Keempat tabel milik `foundation_owner`, `relrowsecurity` false, tanpa trigger bukan internal, dan tanpa schema baru → AC-1
- [x] ACL tabel dan kolom: `users.users` hanya `SELECT (id, email, display_name)`; `auth.password_credentials` hanya `SELECT (user_id, password_hash)`; `auth.sessions` hanya `SELECT` delapan kolom baris 0009, `INSERT (user_id, token_hash, idle_expires_at, expires_at)`, dan `UPDATE (last_seen_at, idle_expires_at, revoked_at, revoked_reason)`; `auth.sign_in_attempts` `SELECT`, `INSERT`, `DELETE`, dan `UPDATE (attempt_count, window_started_at)`; tanpa grant option dan tanpa entri `PUBLIC` (2026-10-06 saat build: sesuai lewat `relacl` dan `attacl`) → AC-1, AC-2
- [x] Sebagai `foundation_backend`: `INSERT` ke `users.users`, `SELECT created_at FROM users.users`, `DELETE FROM auth.sessions`, dan `SELECT revoked_reason FROM auth.sessions` gagal `permission denied` (2026-10-06 saat build: empat contoh sesuai; matriks lengkap AUTH-002 menyusul di milestone 2) → AC-2
- [x] `REQUIRED_MIGRATION` di `apps/backend/src/features/health/health.queries.ts` sama dengan `0010-auth-grant-backend-sign-in-attempts.sql`, nama file migration terakhir; `bun run test:deployment:plan` lulus pemeriksaan DEP-001 untuk itu → AC-1
- [x] `bun run test:database:migration` → MIG-001 menghitung sepuluh migration repository (`Migrations: 10 applied, 0 skipped`, lalu `0 applied, 10 skipped`) dan doctor menerima database itu → AC-1

## Perintah: perintah operator `create` (AC-3)

- [x] `bun --no-env-file database/accounts.ts create --email ' Ana@Example.test ' --display-name 'Ana Uji' --apply` dengan `FOUNDATION_MIGRATOR_DATABASE_URL` dan `FOUNDATION_ACCOUNT_PASSWORD` minimal 15 karakter → exit 0, stdout tepat satu baris `Account created: <uuid>`, stderr kosong, dan keluaran tidak memuat password, hash, email, atau DSN (2026-10-06 saat build: sesuai) → AC-3
- [x] Query admin → satu baris `users.users` dengan email `ana@example.test` (ternormalisasi), nama `Ana Uji` apa adanya, dan `auth.password_credentials.password_hash` berawalan `$argon2id$v=19$m=19456,t=2,p=1$` yang diverifikasi `Bun.password.verify` atas bentuk NFKC password → AC-3
- [x] Ulangi `create` untuk email yang sama dengan nama dan password lain → exit 1, stderr tepat `Account exists`, stdout kosong, dan nama serta hash tidak berubah (2026-10-06 saat build: sesuai) → AC-3
- [x] *Prioritas galat*, setiap kasus exit 1 dengan satu baris stderr dan stdout kosong: tanpa argumen, tanpa `--apply`, `--apply` tidak terakhir, atau nilai flag kosong → `Use create, set-password, or revoke-sessions with --apply`; email tidak sah dengan nama dan password yang juga salah → `Invalid email`; nama berawalan spasi dengan password salah → `Invalid display name`; password kurang dari 15 code point, tidak ada, atau memuat karakter kontrol → `Missing or invalid FOUNDATION_ACCOUNT_PASSWORD`; semuanya sebelum koneksi dibuka (2026-10-06 saat build: sesuai) → AC-3
- [x] `create` sebelum migration diterapkan → exit 1 `Migrations pending` lewat fungsi transaksi pemilik yang sama dengan seed (2026-10-06 saat build: sesuai) → AC-3
- [x] Tanpa `FOUNDATION_MIGRATOR_DATABASE_URL` → exit 1 `Missing FOUNDATION_MIGRATOR_DATABASE_URL`; DSN `foundation_backend` → exit 1 `Invalid database target or migrator`; tanpa DSN atau pesan database mentah di keluaran → AC-3
- [x] Baca `database/runner.ts` → identitas, lock `(638727, 5)` dan `(638727, 6)`, `SET LOCAL ROLE foundation_owner`, pemeriksaan metadata, dan syarat semua migration terapan hanya ada di satu tempat (`ownerTransaction` dan `withOwnerTransaction`) yang dipakai migrate, seed, dan `database/accounts.ts`; `bun run test:database:migration` tetap lulus MIG-002 sampai MIG-005 → AC-3
- [x] `package.json` memuat root script `db:accounts` → `bun database/accounts.ts` → AC-3

## Perintah: masuk dan identitas di kedua komposisi (AC-4, dasar AC-7)

- [x] `createApp('development', { database })` dan `createApp('production', { database, publicOrigin: 'https://foundation.test' })` dengan pool `foundation_backend` dan akun langkah AC-3: `POST /api/auth/session` dengan `Content-Type: application/json` dan email serta password benar → 200, `Cache-Control: no-store`, dan tepat satu `Set-Cookie`: development `foundation_session=<43 karakter>; Path=/; HttpOnly; SameSite=Strict`, production `__Host-foundation_session=<43 karakter>; Path=/; Secure; HttpOnly; SameSite=Strict`, tanpa `Domain`, `Expires`, atau `Max-Age` (2026-10-06 saat build: sesuai di kedua mode) → AC-4
- [x] Body 200 tepat key `user`, `session`, `csrfToken`; `csrfToken` 43 karakter `[A-Za-z0-9_-]` dan berbeda dari token cookie; body tidak memuat token cookie → AC-4
- [x] Query admin baris sesi baru → `token_hash` sama dengan SHA 256 heksadesimal token cookie (bukan token), `expires_at - created_at` 12 jam, `idle_expires_at - created_at` 30 menit, `revoked_at` null (2026-10-06 saat build: sesuai) → AC-4
- [x] Email tidak terdaftar dan password salah → keduanya 401 tepat `{"error":"Invalid credentials"}` tanpa `Set-Cookie`; email yang tidak lolos aturan *Email* sesudah normalisasi → 400 `{"error":"Invalid request"}` → AC-4, AC-5
- [x] `GET /api/auth/session` dengan cookie dari langkah masuk → 200 dengan `session.id` dan `csrfToken` sama dengan jawaban masuk; tanpa cookie → 401 `{"error":"Unauthorized"}` tanpa `Set-Cookie`; nama cookie sesi dua kali, token tidak dikenal, atau nama cookie mode lain → 401, dan bila nama cookie sesi dikirim ada `Set-Cookie` penghapus dengan atribut yang sama ditambah `Max-Age=0` (2026-10-06 saat build: sesuai) → AC-7
- [x] Tanpa pool: `POST` dan `GET /api/auth/session` → 503 `{"error":"Service unavailable"}` dengan `Cache-Control: no-store`; JSON rusak dan password bertipe salah → 400 tepat `{"error":"Invalid request"}` tanpa nilai yang dikirim (2026-10-06 saat build: sesuai) → AC-4, AC-11
- [x] Guard `onRequest`: `HEAD /api/auth/session`, `PUT /api/auth/session`, dan `GET /api/auth/session/` → 404 `{"error":"Not found"}` dengan `Content-Type: application/json` dan `Cache-Control: no-store`; query string atau header `content-length` bukan 0 pada GET → 400 `{"error":"Invalid request"}`; pada komposisi dengan sink log setiap jawaban guard menulis tepat satu baris request (2026-10-06 saat build: sesuai) → AC-4
- [x] Baca `apps/backend/src/features/auth/` → lookup akun, verifikasi (`Bun.password.verify`, atau opsi `auth.verify` di test), lalu transaksi sesi berjalan berurutan, setiap transaksi memakai `SET LOCAL statement_timeout = '2s'`, dan tidak ada koneksi atau transaksi terbuka selama verifikasi; email tidak terdaftar memakai hash tiruan per instance yang di memo → AC-4

## Perintah: konfigurasi `PUBLIC_ORIGIN` dan deployment

- [x] `readConfiguration` dengan `NODE_ENV=production` tanpa `PUBLIC_ORIGIN`, dengan `http://foundation.test`, `https://foundation.test/app`, atau `https://foundation.test/` → melempar `Invalid PUBLIC_ORIGIN configuration`; dengan `https://foundation.test` → `publicOrigin` sama; development tanpa nilai → `undefined` (2026-10-06 saat build lewat `application.test.ts`) → AC-9
- [x] `bun --no-env-file apps/backend/src/index.ts` dengan `NODE_ENV=production` tanpa `PUBLIC_ORIGIN` → exit 1 dengan satu baris JSON `startup_failed` di stderr → AC-9
- [x] `deploy/compose.yaml` memberi backend `PUBLIC_ORIGIN: ${FOUNDATION_PUBLIC_ORIGIN:?}` dan `.env.deploy.example` memuat baris wajib `FOUNDATION_PUBLIC_ORIGIN=`; `bun run test:deployment:plan` lulus DEP-001 → AC-13

## Perintah: kontrak dan SDK (AC-11)

- [x] `bun run api:sync` → `OpenAPI project checks passed`, lalu generator menulis `fn/auth/sign-in.ts`, `fn/auth/get-auth-session.ts`, `models/auth-session.ts`, `models/auth-error.ts`, `models/sign-in-request.ts`, dan `services/auth.service.ts`; `bun run api:check` → `OpenAPI and SDK match stored artifacts across two runs` (2026-10-06 saat build: sesuai) → AC-11
- [x] `openapi.json`: `POST /api/auth/session` `operationId` `signIn`, tag `auth`, `security: []`, `requestBody` hanya `application/json` dengan `$ref` `SignInRequest`, status 200 `AuthSession` serta 400, 401, 403, 415, 429, 500, 503 `AuthError`; `GET /api/auth/session` `getAuthSession`, `security: [{ sessionCookie: [] }]`, status 200 `AuthSession` serta 400, 401, 500, 503 `AuthError`; tanpa parameter cookie; `components.securitySchemes.sessionCookie` `apiKey` di `cookie` bernama `__Host-foundation_session`; tag dokumen `auth`, `development`, `health` → AC-11
- [x] Komponen `AuthSession`, `SignInRequest`, dan `AuthError` `additionalProperties: false` di setiap tingkat, semua properti wajib, tanpa nullable dan tanpa contoh nilai credential; `AuthError.error` string `enum` tepat sembilan teks tabel *Model kontrak* tanpa `default` → AC-11
- [x] `bun run check:frontend:bundle` lulus: `@sdk` hanya diimpor `app.config.ts` dan `features/auth/auth-api.ts` serta `features/readiness/readiness-api.ts` → AC-11
- [x] Baca `features/auth/auth-api.ts` → `@Service()`, memakai `AuthService` hasil generate tanpa `HttpClient` atau string URL, method mengembalikan `Observable` dingin tanpa error; body 200 diperiksa per field lalu dibangun ulang (generator mengetik `user` dan `session` bersarang sebagai `Record<string, unknown>`); pemetaan status `signIn` dan `session()` sesuai tabel *Pemetaan adapter* (502 dan 504 serta status 0 menjadi `network`) → AC-11

## UI / manual (AC-12)

- [x] Buka `/masuk` → judul `Masuk`, form `novalidate` dengan label `Email` (`type="email"`, `autocomplete="username"`) dan `Password` (`type="password"`, `autocomplete="current-password"`), tombol `Masuk`, satu wilayah `role="alert"` dan satu `role="status"` yang selalu ada di DOM, dan tanpa request ke `/api/` saat dibuka → AC-12
- [x] Tekan `Masuk` dengan isian kosong → alert `Isi email dan password.` tanpa request → AC-12
- [x] Masuk dengan password salah lewat backend nyata → alert `Email atau password salah.`, email tetap, password kosong, tombol aktif lagi → AC-12
- [x] Masuk dengan akun benar → pindah ke `/akun`, status `Memuat akun.` selama `getAuthSession`, lalu bagian `Profil` dengan nama dan email akun; request `/api/` tepat `POST /api/auth/session` lalu `GET /api/auth/session`; `localStorage` dan `sessionStorage` kosong dan `document.cookie` tidak memuat cookie sesi (2026-10-06 saat build lewat AUTH-012 di `test:readiness:real`) → AC-12, AC-10
- [x] Buka `/akun` tanpa sesi → pindah ke `/masuk` dengan `replaceUrl` dan status `Sesi Anda berakhir. Masuk lagi untuk melanjutkan.`; notice dikosongkan sehingga membuka `/masuk` lagi tidak mengulang teks itu → AC-12
- [x] Hentikan backend lalu buka `/akun` → alert `Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.` dengan tombol `Coba lagi` yang mengulang panggilan → AC-12
- [x] Navigasi development berurutan `Beranda`, `Akun`, `Kesiapan`; build production `Beranda`, `Akun`; tautan `Akun` menuju `/akun`; navigasi dan shell tidak memanggil API, dan nama serta email wrapper terisi sesudah `/akun` membaca identitas → AC-12
- [x] Membuka `/` dan `/kesiapan` tetap tanpa request ke `/api/auth/` (UI-002, READY-006, READY-007) → AC-12
- [x] Kedua halaman pada 1280×812 dan 375×812 tanpa overflow horizontal dan dapat dioperasikan dengan keyboard (pemeriksaan lengkap setiap baris *State halaman* menyusul di milestone 4) → AC-12

## Perintah: Value sourcing (milestone 1)

- [x] Email ternormalisasi: masuk dengan ` ANA@example.test` (spasi dan huruf besar) berhasil untuk akun `ana@example.test`; `ána@example.test` ditolak 400 karena huruf di luar A sampai Z tidak diubah → AC-4
- [x] Akun dan hash password: ubah `password_hash` lewat admin ke hash Argon2id password lain → masuk dengan password lama 401, dengan password baru 200 → AC-4
- [x] Hash pembanding untuk email tidak terdaftar: dengan opsi `auth.verify` pencatat, satu masuk email tidak terdaftar memanggil verifier tepat sekali dengan hash berawalan `$argon2id$v=19$m=19456,t=2,p=1$`, dan dua masuk berikutnya memakai hash yang sama → AC-5
- [x] Token, `token_hash`, token CSRF: token cookie 43 karakter base64url; `token_hash` SHA 256 heksadesimal byte UTF 8 token; `csrfToken` sama dengan HMAC SHA 256 base64url berkunci token atas `foundation-csrf-v1` → AC-4
- [x] `expires_at`, `idle_expires_at`, `created_at`, `last_seen_at`, `id`: dibanding `now()` database, bukan jam proses; geser jam host tidak mengubah selisih 12 jam dan 30 menit → AC-4
- [x] Nama dan atribut cookie: dengan `NODE_ENV` dan variable lain apa pun, komposisi production selalu `__Host-foundation_session` dengan `Secure`, development selalu `foundation_session` tanpa `Secure` → AC-4
- [x] Origin yang diizinkan: `index.ts` meneruskan `PUBLIC_ORIGIN` sebagai opsi `publicOrigin` `createApp` (pemakaian di guard menyusul milestone 3) → AC-9
- [x] GET sesi `user`, `session`, `csrfToken`: dari join sesi aktif dengan `users.users` via `token_hash`; sesi yang `revoked_at` diisi admin atau `idle_expires_at` digeser ke masa lalu → 401 → AC-7
- [x] Log `requestId`: baris request jawaban guard dan baris request biasa satu request memakai id `requestIdFor` yang sama → AC-10
- [x] Frontend token CSRF dan identitas: setelah masuk, `SessionState` berisi user dan token CSRF hanya di memori; muat ulang halaman mengosongkannya sampai `/akun` membaca `getAuthSession` lagi → AC-12
- [x] Frontend pesan sesudah pindah ke `/masuk`: notice `expired` diisi sebelum navigasi dan dibaca lalu dikosongkan `/masuk`, tidak lewat query, state router, atau storage → AC-12
- [x] Teks: setiap teks yang tampil pada langkah UI di atas sama persis dengan tabel *Teks halaman* → AC-12

## Acceptance criteria coverage (milestone 1)

- AC-1: langkah migration dan grant, `REQUIRED_MIGRATION`, MIG-001.
- AC-2: dasar grant dan empat contoh penolakan; matriks lengkap AUTH-002 di milestone 2.
- AC-3: `create` lengkap dengan prioritas galat dan fungsi transaksi pemilik bersama; `set-password`, `revoke-sessions`, dan image runner di milestone 2 dan 4.
- AC-4: masuk di kedua mode, cookie, hash, masa berlaku; rotasi, batas 10, lock per akun, baca ulang hash, dan penghapusan baris percobaan di milestone 2.
- AC-7: dasar resolusi sesi dan 401 dengan penghapusan cookie; perpanjangan di milestone 2.
- AC-9: `PUBLIC_ORIGIN` di konfigurasi; guard origin dan CSRF di milestone 3.
- AC-11: dua dari lima operasi, model, security scheme, `api:sync` dan `api:check`; operasi lain, `REQUIRED_OPERATIONS`, dan test adapter di milestone 2 dan 3.
- AC-12: `/masuk`, `/akun` profil, navigasi `Akun`, AUTH-012 sampai nama tampil; semua baris *State halaman* dan kedua viewport di milestone 4.
- AC-13: wiring `PUBLIC_ORIGIN` di Compose dan `.env.deploy.example`; check deployment auth di milestone 4.

## Milestone 2: lifecycle sesi

_Bagian ini mencakup milestone 2 (langkah 2 build plan): `DELETE /api/auth/session`, `GET /api/auth/sessions`, dan `DELETE /api/auth/sessions/{sessionId}` dengan resep *Ekspor route 204 dengan galat* dan pola `sessionId`, statement *Perpanjangan sesi*, rotasi saat masuk, batas 10 sesi dengan lock per akun dan pembacaan ulang hash, penghapusan baris percobaan, `set-password` dan `revoke-sessions` dengan lock per akun, bagian `Sesi aktif` dan tombol `Keluar`, serta suite `tests/integration/database/auth.test.ts` (AUTH-001 sampai AUTH-004, AUTH-007, AUTH-008) dengan GATE-009. Pemeriksaan token CSRF langkah 9 (403) ikut dibangun di sini bersama kedua route `DELETE`; guard origin, aturan Content-Type, batas percobaan, slot verifikasi, dan log `auth` tetap milik milestone 3._

## Perintah: suite database (AC-1, AC-2, AC-3, AC-4, AC-7, AC-8)

- [x] `bun --no-env-file test ./tests/integration/database/auth.test.ts` → 18 test lulus pada satu cluster `foundation-postgres:18-pinned` milik suite itu, dan container `foundation-auth-db-<8 heksadesimal>` serta folder `foundation-auth-test-*` hilang sesudahnya (2026-10-06 saat build: 18 lulus, 349 asersi) → AC-1, AC-2, AC-3, AC-4, AC-7, AC-8
- [x] `bun run test:database:real` → suite `auth.test.ts` ikut berjalan di folder `tests/integration/database` bersama suite lama, lalu pemindaian artefak tetap tanpa temuan (2026-10-06 saat build: 107 test lulus di 6 file, `Database artifact scan passed: 17 random values absent from 22 files.`, `Restore evidence passed.`) → AC-1, AC-2, AC-3, AC-4, AC-7, AC-8
- [x] `bun run test:gate` → GATE-009 mencantumkan `tests/integration/database/auth.test.ts` di daftar file yang memanggil Docker dan di `REAL_SUITES`, dan SIGTERM saat `docker run` suite itu menunggu menjalankan `rm -f foundation-auth-db-<8 heksadesimal>` pada kedua putaran lalu menghapus foldernya (2026-10-06 saat build: `signal-cleanup.test.ts` 11 lulus) → AC-1

## Perintah: model data dan privilege (AC-1, AC-2)

- [x] AUTH-001: kolom, tipe, nullability, default, constraint selain `NOT NULL`, FK `ON DELETE CASCADE`, dan index ketujuh objek index sama persis dengan keluaran `pg_get_constraintdef` dan `pg_indexes` yang tercatat di test; keempat tabel `relkind` `r`, milik `foundation_owner`, tanpa RLS, policy, atau trigger; schema hanya `auth`, `common`, `public`, `users`; `REQUIRED_MIGRATION` sama dengan file migration terakhir; rerun `Migrations: 0 applied, 10 skipped`; provisioning ulang dengan role backup setiap baris `: verified` → AC-1
- [x] AUTH-002: `aclexplode` atas `relacl` dan `attacl` keempat tabel memberi tepat grant tabel `SELECT`, `INSERT`, `DELETE` pada `auth.sign_in_attempts` dan grant kolom baris 0007 sampai 0010 untuk `foundation_backend`, semuanya tanpa grant option, tanpa entri `PUBLIC`, dan tanpa `REFERENCES`, `TRIGGER`, `TRUNCATE`, atau `MAINTAIN` → AC-2
- [x] AUTH-002: sebagai `foundation_backend`, setiap baris "diizinkan" *Matriks grant backend* berhasil, dan 25 baris "ditolak" (termasuk `SELECT ... FOR UPDATE` pada `users.users`, `INSERT` sesi dengan `id` atau `created_at` eksplisit, `UPDATE key_hash`, DDL di `users` dan `auth`, serta `SET ROLE foundation_owner`) gagal `permission denied` → AC-2
- [x] AUTH-002: `foundation_backup` gagal `permission denied` membaca keempat tabel, lalu berhasil sesudah `SET LOCAL ROLE pg_read_all_data`; role selain `pg_*` tepat `foundation_admin`, `foundation_backend`, `foundation_backup`, `foundation_migrator`, `foundation_owner` → AC-2

## Perintah: perintah operator lengkap (AC-3)

- [x] Setiap bentuk argumen di luar tabel (tanpa perintah, perintah lain, flag lain, flag berulang, urutan lain, nilai flag kosong, `--apply` hilang, tidak terakhir, atau berulang, `--email` bersama `--all`) → exit 1, stderr tepat `Use create, set-password, or revoke-sessions with --apply`, stdout kosong, juga dengan DSN yang tidak dapat dijangkau → AC-3
- [x] *Prioritas galat* dengan DSN yang tidak dapat dijangkau: email salah mengalahkan nama dan password salah (`Invalid email`), nama berawalan atau berakhiran spasi, memuat `U+0007` atau `U+0085`, atau 101 code point (`Invalid display name`), lalu password tidak ada, 14 code point, 14 code point sesudah NFKC dari 28 mentah, memuat karakter kontrol, atau 129 code point (`Missing or invalid FOUNDATION_ACCOUNT_PASSWORD`) untuk `create` dan `set-password` → AC-3
- [x] `revoke-sessions` mengabaikan `FOUNDATION_ACCOUNT_PASSWORD` yang salah; DSN tidak terjangkau → `Account command failed`; DSN `foundation_backend` → `Invalid database target or migrator` mendahului `Account not found`; akun tidak ada → `Account not found` untuk `set-password` dan `revoke-sessions --email` → AC-3
- [x] `create` dengan email berspasi dan huruf besar menyimpan email ternormalisasi, nama 100 code point di luar BMP apa adanya, dan hash Argon2id `m=19456,t=2,p=1` dari bentuk NFKC password (password 16 code point lebar penuh: hash cocok dengan bentuk NFKC, tidak dengan bentuk mentah, dan masuk dengan bentuk mentah berhasil karena backend menormalisasi); `create` kedua → `Account exists` tanpa perubahan nama dan hash → AC-3
- [x] `set-password --email <email> --apply` → stdout tepat `Password changed: <uuid>; sessions revoked: 2` untuk dua sesi aktif (sesi yang `idle_expires_at` nya lewat tidak dihitung dan tidak diubah), `updated_at` lebih baru, `created_at` tetap, hash baru cocok, kedua sesi `credential_change` dan tokennya 401, password lama 401, password baru 200; run kedua `sessions revoked: 1` hanya untuk sesi baru → AC-3
- [x] Balapan: masuk yang ditahan sesudah verifikasi password lama (opsi `auth.verify` yang menunggu sinyal test), lalu `set-password` selesai, lalu masuk dilepas → 401 `{"error":"Invalid credentials"}` tanpa `Set-Cookie`, dan akun tanpa baris sesi sama sekali → AC-3, AC-4
- [x] `revoke-sessions --email` → `Sessions revoked: 2` dengan alasan `operator` hanya untuk akun itu, run kedua `Sessions revoked: 0`; `revoke-sessions --all --apply` → `Sessions revoked: <jumlah sesi aktif>`, token akun lain 401, run kedua `Sessions revoked: 0`, dan tidak ada sesi aktif tersisa → AC-3
- [x] Keluaran setiap perintah di atas tidak memuat password, hash `$argon2id$`, email, DSN, atau password role → AC-3
- [x] Baca `database/accounts.ts` dan `libs/server/auth/account-lock.ts` → `set-password` dan `revoke-sessions --email` mengambil `pg_advisory_xact_lock(hashtextextended(user_id::text, 638727))` lewat fungsi yang sama dengan transaksi masuk backend, sesudah lock `(638727, 5)` dan `(638727, 6)` transaksi pemilik; `set-password` memakai `INSERT ... ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = transaction_timestamp()`; `revoke-sessions --all` tanpa lock per akun → AC-3

## Perintah: masuk, rotasi, dan batas sesi (AC-4)

- [x] AUTH-004 di kedua komposisi: 200 dengan `Cache-Control: no-store`, tepat satu `Set-Cookie` mode itu, body `user`, `session`, `csrfToken` dengan `csrfToken` HMAC token, dan baris sesi dengan `token_hash` SHA 256 token, `expires_at - created_at` 12 jam, `idle_expires_at - created_at` 30 menit, `last_seen_at = created_at`; token mentah tidak ada di `auth.sessions` → AC-4
- [x] Rotasi: masuk dengan cookie sesi valid milik akun yang sama atau akun lain mencabut sesi itu dengan `replaced` sebelum sesi baru, token lama 401, token baru berbeda; cookie sesi yang sudah berakhir atau tidak dikenal tidak mencabut apa pun dan masuk tetap 200 → AC-4
- [x] Batas 10: dengan sembilan sesi yang `last_seen_at` nya digeser admin berurutan, sesi ke 10 tidak mencabut apa pun, sesi ke 11 mencabut sesi paling lama tidak aktif dengan `session_limit`; dua masuk bersamaan → keduanya 200, kedua sesi baru aktif, dua sesi paling lama tidak aktif dicabut, dan tepat 10 sesi aktif → AC-4
- [x] Baris percobaan: baris kunci `sha256('sign-in:' + email)` dihapus masuk yang berhasil, baris kunci lain tetap; hash yang diganti admin di antara verifikasi dan transaksi → 401 `Invalid credentials` tanpa `Set-Cookie`, tanpa baris sesi, dan baris percobaan tetap (rollback) → AC-4
- [x] Pool satu koneksi: saat verifier test menahan masuk, `SELECT 1` pada pool yang sama langsung dijawab dan `pg_stat_activity` tidak mempunyai koneksi `foundation_backend` `idle in transaction`; sesudah dilepas masuk 200 → AC-4

## Perintah: validasi dan perpanjangan sesi (AC-7)

- [x] AUTH-007 di kedua komposisi: cookie valid di antara cookie lain → 200; tanpa cookie → 401 `{"error":"Unauthorized"}` tanpa `Set-Cookie`; token 42 atau 44 karakter dan nama cookie sesi dua kali → 401 dengan `Set-Cookie` penghapus mode itu → AC-7
- [x] Sesi yang dicabut admin, yang `idle_expires_at` nya lewat, dan yang `expires_at` nya lewat → `GET /api/auth/session` dan `GET /api/auth/sessions` 401 dengan cookie dihapus, baris sesi tidak berubah sama sekali, dan statement perpanjangan atasnya mengubah 0 baris → AC-7
- [x] Dalam 60 detik sesudah masuk, GET tidak mengubah baris; sesudah `last_seen_at` digeser 61 detik lewat SQL admin, satu GET mengubah `last_seen_at` dan `idle_expires_at` bersama (`idle_expires_at - last_seen_at` 30 menit, `last_seen_at` dari `now()` database) dan body menampilkan nilai baru; GET dan daftar berikutnya tidak mengubah apa pun; `created_at`, `expires_at`, `token_hash`, dan `revoked_at` tetap → AC-7
- [x] Mendekati masa absolut (`expires_at` satu menit lagi): perpanjangan membuat `idle_expires_at` sama dengan `expires_at`, dan `expires_at` tidak bergeser → AC-7

## Perintah: keluar, daftar, dan pencabutan (AC-8)

- [x] AUTH-008 di kedua komposisi: `DELETE /api/auth/session` dengan token CSRF benar → 204 tanpa body dan tanpa `Content-Type`, `Cache-Control: no-store`, `Set-Cookie` penghapus mode itu, baris `sign_out`; token yang sama lalu 401; keluar kedua 204 tanpa perubahan `revoked_at`; token CSRF berbentuk benar milik sesi lain → 403 `Forbidden` tanpa `Set-Cookie` dan sesi tetap aktif → AC-8, AC-9
- [x] Tanpa sesi tetapi dengan `x-csrf-token` berbentuk benar: `DELETE /api/auth/session` → 204 dengan cookie dihapus dan jumlah sesi dicabut tidak berubah; `DELETE /api/auth/sessions/{id}` → 401 `Unauthorized` tanpa perubahan → AC-8
- [x] `GET /api/auth/sessions` → hanya sesi aktif pemanggil, urut `last_seen_at` lalu `created_at` menurun, `current` benar tepat pada sesi pemanggil, setiap item tepat `id`, `createdAt`, `lastSeenAt`, `current` dengan waktu sama dengan kolom database; sesi yang dicabut dan sesi akun lain tidak muncul; dengan 10 sesi aktif daftar berisi 10 dengan satu `current` → AC-8
- [x] `DELETE /api/auth/sessions/{id}` atas sesi lain milik pemanggil → 204 tanpa `Set-Cookie`, baris `revoked`, tokennya 401; atas sesi pemanggil sendiri → 204 dengan cookie dihapus; atas sesi akun lain, sesi yang sudah berakhir, dan id `00000000-0000-4000-8000-000000000000` → 404 `{"error":"Not found"}` dan sesi akun lain tidak berubah serta tetap 200; token CSRF yang salah → 403 dan target tetap → AC-8, AC-9
- [x] Kedua route `DELETE`: `x-csrf-token` tidak ada, kosong, terlalu pendek, 44 karakter, atau memuat `!` → 400 `{"error":"Invalid request"}` dengan `Cache-Control: no-store`, ada atau tidak ada cookie; `sessionId` bentuk `urn:uuid:`, huruf besar, berkurung kurawal, atau tanpa tanda hubung → 400 dan sesi tidak berubah → AC-8
- [x] `openapi.json` sesudah `bun run api:sync`: `DELETE /api/auth/session` `signOut` dan `DELETE /api/auth/sessions/{sessionId}` `revokeAuthSession` dengan `security` `sessionCookie`, 204 tanpa `content`, setiap status galat (`signOut` 400, 403, 500, 503; `revokeAuthSession` 400, 401, 403, 404, 500, 503) `$ref` `AuthError`, parameter header `x-csrf-token` wajib berpola `^[A-Za-z0-9_-]{43}$`, dan parameter path `sessionId` `format: uuid` berpola huruf kecil; `GET /api/auth/sessions` `listAuthSessions` 200 `AuthSessionList` serta 400, 401, 500, 503; `bun run api:check` lulus → AC-8, AC-11

## UI / manual (AC-12, milestone 2)

- [x] Masuk lalu `/akun` → request `/api/` tepat `POST /api/auth/session`, `GET /api/auth/session`, `GET /api/auth/sessions`; bagian `Profil` lalu `Sesi aktif` dengan setiap sesi menampilkan `Dibuat` dan `Terakhir aktif` sebagai `<time>` yang atribut `datetime` nya sama dengan nilai API dan teksnya tidak kosong; sesi pemanggil bertanda `Sesi ini` tanpa tombol, sesi lain bertombol `Akhiri sesi`; tombol `Keluar` di bawahnya → AC-12
- [x] Masuk dengan akun yang sama di browser kedua, kembali ke `/akun` lewat navigasi tanpa muat ulang, tekan `Akhiri sesi` pada sesi browser kedua → `DELETE /api/auth/sessions/<id>` 204, status `Sesi diakhiri.`, daftar dimuat ulang lewat `GET /api/auth/sessions` dengan satu item lebih sedikit; browser kedua membuka `/akun` → pindah ke `/masuk` dengan `Sesi Anda berakhir. Masuk lagi untuk melanjutkan.` (2026-10-06 saat build lewat AUTH-012 kedua di `test:readiness:real` dan `test:tooling:real`) → AC-12, AC-8
- [x] Tekan `Keluar` → `DELETE /api/auth/session` 204, pindah ke `/masuk` dengan status `Anda sudah keluar.` tanpa muat ulang; klik `Akun` di navigasi → pindah ke `/masuk` dengan teks sesi berakhir; `document.cookie` tidak memuat cookie sesi → AC-12
- [x] Selama `Akhiri sesi` atau `Keluar` berjalan, hanya tombol itu yang `aria-disabled="true"` dan klik kedua tidak mengirim request kedua; tanpa dialog konfirmasi → AC-12
- [x] Pencabutan `not-found` (sesi sudah dicabut di tempat lain) → alert `Sesi sudah berakhir.` lalu daftar dimuat ulang; `failed` → alert `Sesi tidak dapat diakhiri. Coba lagi.` dan daftar tetap; `forbidden`, `unavailable`, `network` → teks state yang sama di alert dan daftar tetap; `unauthenticated` → `/masuk` dengan teks sesi berakhir → AC-12
- [x] Keluar `forbidden`, `unavailable`, `network`, atau `failed` (misalnya backend dihentikan) → teks state di alert, state sesi tetap, tombol `Keluar` aktif lagi → AC-12
- [x] `GET /api/auth/sessions` yang gagal `unavailable`, `network`, atau `failed` saat memuat atau sesudah pencabutan → teks state di alert dan tombol `Coba lagi` yang mengulang kedua panggilan → AC-12
- [x] Ikon keluar di footer wrapper layout tidak memanggil API (shell tidak memanggil API); keluar hanya lewat tombol `Keluar` di `/akun` → AC-12
- [x] `/akun` dengan dua sesi atau lebih pada 1280×812 dan 375×812 tanpa overflow horizontal; tombol `Akhiri sesi` dan `Keluar` dapat dicapai dengan Tab dan dijalankan dengan Enter, dan setiap `Akhiri sesi` mempunyai deskripsi waktu sesinya (`aria-describedby`) → AC-12

## Perintah: Value sourcing (milestone 2)

- [x] Urutan sesi bersamaan per akun dan password yang berubah: dua masuk bersamaan dan masuk yang berpacu dengan `set-password` (langkah AC-3 dan AC-4 di atas) membuktikan lock per akun, pembacaan ulang hash, dan batas 10 dalam satu transaksi masuk → AC-4
- [x] Sesi yang diganti: hanya cookie request yang valid dicabut `replaced`, pada transaksi masuk yang sama (rollback hash berubah juga membatalkan rotasi) → AC-4
- [x] Perpanjangan sesi: geser `last_seen_at` lewat SQL admin, bukan jam proses; `idle_expires_at` selalu `least(now() + 30 menit, expires_at)` dari jam database → AC-7
- [x] Daftar sesi `current`: dari id sesi pemanggil hasil resolusi cookie, bukan dari body, path, atau header lain → AC-8
- [x] Pencabutan pemilik: `user_id` filter pencabutan berasal dari sesi pemanggil yang tervalidasi; id sesi akun lain menghasilkan 404 yang sama dengan id tidak ada → AC-8
- [x] Operator jumlah sesi dicabut: angka di keluaran `set-password` dan `revoke-sessions` sama dengan jumlah baris `UPDATE` (dihitung ulang lewat query admin) → AC-3
- [x] Frontend waktu sesi: atribut `datetime` sama dengan `createdAt` dan `lastSeenAt` API, teks dari `Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' })` pada zona waktu browser; ubah zona waktu browser → teks berubah, atribut tetap → AC-12
- [x] Frontend token CSRF: `Akhiri sesi` dan `Keluar` mengirim `x-csrf-token` dari `SessionState` yang diisi body `AuthSession`, tidak dari storage atau cookie → AC-12

## Acceptance criteria coverage (milestone 2)

- AC-1: AUTH-001 di `auth.test.ts`, suite terdaftar di GATE-009.
- AC-2: AUTH-002 matriks lengkap, `PUBLIC`, dan `foundation_backup`.
- AC-3: AUTH-003 untuk setiap baris tabel *Perintah operator*, prioritas galat, balapan dengan masuk; job di image runner menyusul milestone 4.
- AC-4: AUTH-004 rotasi, batas 10, lock per akun, baca ulang hash, baris percobaan, dan pool tanpa koneksi tertahan.
- AC-7: AUTH-007 idle, absolut, dicabut, cookie rusak dan ganda, perpanjangan paling sering 60 detik.
- AC-8: AUTH-008 keluar, daftar, pencabutan sendiri, lintas pengguna 404, token dikirim ulang, header dan pola `sessionId`.
- AC-9 (sebagian, ditarik maju): pemeriksaan token CSRF 403 pada kedua route `DELETE`; origin, `Sec-Fetch-Site`, Content-Type, dan event log menyusul milestone 3.
- AC-11 (sebagian): tiga operasi baru di `openapi.json` dan SDK; `REQUIRED_OPERATIONS` dan test adapter menyusul milestone 3.
- AC-12: bagian `Sesi aktif`, `Akhiri sesi`, dan `Keluar` dengan langkah AUTH-012 kedua di `auth.real.e2e.spec.ts`; setiap baris *State halaman* dan kedua viewport menyusul milestone 4.

## Milestone 3: pertahanan

_Bagian ini mencakup milestone 3 (langkah 3 build plan): guard `onRequest` lengkap di `apps/backend/src/features/auth/auth.guard.ts` (langkah 3 aturan origin dan `Sec-Fetch-Site`, langkah 4 aturan *Content-Type*, satu baris log request untuk setiap jawabannya), pemeriksaan format email dan password sebelum slot, hash tiruan ber memo di luar slot, slot verifikasi `auth.slots.ts` dan opsi `auth` `createApp`, reservasi dan pembersihan percobaan, log event `auth` di `auth.log.ts` lewat `writeLogLine` bersama, tiga entri `REQUIRED_OPERATIONS` dengan mutasinya, `tests/integration/backend/auth.test.ts`, test adapter `auth-api.integration.spec.ts`, serta AUTH-005, AUTH-006, AUTH-009, AUTH-010, dan AUTH-011 bagian yang bukan deployment. Batas edge, check deployment, sidik token uji, dan registry `tests/scenarios/auth.json` tetap milik milestone 4 dan 5._

## Perintah: suite tanpa database dan suite database (AC-5, AC-6, AC-9, AC-10, AC-11)

- [x] `bun --no-env-file test ./tests/integration/backend/auth.test.ts` → 13 test lulus tanpa Docker dan tanpa `DATABASE_URL` (2026-10-06 saat build: 13 lulus, 659 asersi) → AC-5, AC-6, AC-9
- [x] `bun --no-env-file test ./tests/integration/database/auth.test.ts` → 32 test lulus pada satu cluster `foundation-postgres:18-pinned` milik suite itu, termasuk 14 test baru AUTH-005, AUTH-006, AUTH-009, dan AUTH-010, lalu container `foundation-auth-db-<8 heksadesimal>` hilang (2026-10-06 saat build: 32 lulus, 690 asersi) → AC-5, AC-6, AC-9, AC-10
- [x] `bun run test:integration` → `openapi-contract.test.ts` memuat tiga test AUTH-011, `logging.test.ts` memuat test DEP-007 baris `auth`, dan suite `tests/integration/backend/auth.test.ts` ikut berjalan; semuanya lulus (2026-10-06 saat build lewat `bun run test:ci`: 686 test lulus di 11 file) → AC-9, AC-10, AC-11
- [x] `bun run test:frontend` → `apps/frontend/src/app/features/auth/auth-api.integration.spec.ts` lulus bersama harness backend nyata yang mencetak `SDK contract backend listening on 127.0.0.1:<port>` dan `SDK contract backend stopped` (2026-10-06 saat build: 78 test adapter lulus dari 160 test frontend) → AC-11
- [x] `bun run test:database:real` → suite database auth ikut berjalan bersama suite lama, pemindaian artefak tanpa temuan (2026-10-06 saat build lewat `bun run test:ci:real`: 121 test lulus di 6 file, median AUTH-005 24,3 ms dan 24,5 ms, `Database artifact scan passed: 17 random values absent from 22 files.`, `Restore evidence passed.`) → AC-5, AC-6, AC-9, AC-10

## Perintah: origin, Sec-Fetch-Site, dan CSRF (AC-9)

- [x] `createApp('development')` tanpa pool: `POST /api/auth/session`, `DELETE /api/auth/session`, dan `DELETE /api/auth/sessions/<uuid>` tanpa `Origin`, dengan `http://evil.test`, `null`, origin yang diizinkan ditambah garis miring akhir, huruf besar, port lain, atau dua kali, serta dengan `Sec-Fetch-Site` `cross-site`, `same-site`, `none`, `Same-Origin`, atau kosong → 403 body tepat `{"error":"Forbidden"}`, `Content-Type: application/json`, `Cache-Control: no-store`, tanpa `Set-Cookie`, dan verifier test tidak pernah dipanggil (2026-10-06 saat build: sesuai) → AC-9
- [x] Kontrol: `Origin: http://127.0.0.1:8889` tanpa `Sec-Fetch-Site` dan `Origin: http://localhost:8889` dengan `Sec-Fetch-Site: same-origin` lolos guard dan menjawab 503 tanpa pool → AC-9
- [x] `createApp('production')` tanpa opsi `publicOrigin` → setiap request yang mengubah data 403, juga dengan origin `https://foundation.test`; dengan `publicOrigin: 'https://foundation.test'` hanya origin itu yang lolos, origin development dan `http://foundation.test` 403; development dengan `publicOrigin` hanya mengizinkan nilai itu → AC-9
- [x] Route GET tidak memeriksa origin: `GET /api/auth/session` dan `GET /api/auth/sessions` dengan `Origin: http://evil.test` tanpa pool → 503 → AC-9
- [x] Form HTML lintas situs `application/x-www-form-urlencoded` dengan `Origin: http://evil.test` → 403; form yang sama dari origin yang diizinkan → 415 → AC-9
- [x] Origin salah dengan JSON rusak → 403; media type salah dengan body rusak (`multipart/form-data` tanpa boundary, dengan boundary dan body rusak, `text/plain`, `Application/JSON`) → 415; verifier tidak dipanggil → AC-5, AC-9
- [x] Pada database nyata di kedua komposisi: origin palsu, `Sec-Fetch-Site: cross-site`, atau `Origin: null` dengan body masuk yang sah, dengan cookie dan token CSRF benar pada kedua route `DELETE` → 403, isi `auth.sessions` dan `auth.sign_in_attempts` tidak berubah sama sekali, verifier tidak dipanggil, dan sesi tetap 200 → AC-9
- [x] Token CSRF yang salah dengan sesi valid pada `DELETE /api/auth/session` dan `DELETE /api/auth/sessions/{id}` → 403 dengan event `request_rejected` `csrf` (milestone 2 sudah membuktikan 403 dan sesi tetap) → AC-9, AC-10
- [x] `NODE_ENV=production` `bun --no-env-file apps/backend/src/index.ts` tanpa `PUBLIC_ORIGIN`, dengan nilai kosong, `http:`, garis miring akhir, path, userinfo, atau teks bebas → exit 1, stdout kosong, satu baris JSON `startup_failed` di stderr tanpa nilai itu; kontrol dengan `https://foundation.test` mulai mendengarkan → AC-9

## Perintah: Content-Type dan validasi masuk (AC-5)

- [x] Diterima (lolos ke langkah 6): `application/json`, `application/json; charset=utf-8`, `application/json;charset=utf-8`, `application/json; charset=UTF-8`, `application/json ;  CharSet=Utf-8`, dan nilai yang diapit spasi → AC-5
- [x] Ditolak 415 `{"error":"Unsupported media type"}`: header tidak ada, `Application/JSON`, `application/JSON`, `text/plain`, `text/json`, `application/jsonp`, `application/json-patch+json`, `application/problem+json`, `charset=latin1`, `charset="utf-8"`, `charset = utf-8`, parameter kedua, `application/json;` tanpa parameter, parameter lain, dua media type, `multipart/form-data`, `application/x-www-form-urlencoded`, tab di sekitar `;`, dan `charſet` (huruf ſ U+017F) → AC-5
- [x] JSON rusak, body kosong, array JSON, password bertipe angka, email bertipe array, tanpa password, password kosong, password di atas 256 satuan UTF 16, email 2 karakter, dan email di atas 254 karakter → 400 body tepat `{"error":"Invalid request"}` dengan `Cache-Control: no-store`, tanpa nilai yang dikirim → AC-5
- [x] Email yang tidak lolos aturan *Email* sesudah normalisasi (tanpa `@`, dua `@`, tanpa bagian lokal, spasi di dalam, `änä@...`, bagian lokal 65 karakter) dan password di luar aturan masuk (tidak well formed, 129 code point, 130 code point sesudah NFKC dari 65 `U+FB00`) → 400 tanpa baris percobaan baru dan tanpa panggilan verifier (2026-10-06 saat build: sesuai) → AC-5
- [x] Properti body yang tidak dikenal (`userId`, `id`, `role`, `displayName`) dibuang: masuk tetap 200 untuk akun email itu dan body tetap tepat `user`, `session`, `csrfToken` → AC-5
- [x] Database tidak terjangkau (pool ke port tertutup) → masuk 503 `{"error":"Service unavailable"}` tanpa `Set-Cookie`, tanpa panggilan verifier, tanpa pesan database, dan tanpa sesi baru; GET sesi 503 → AC-5
- [x] Tanpa pool, kelima route di kedua komposisi → 503 sesudah guard dan schema, verifier tidak dipanggil → AC-5

## Perintah: tanpa enumerasi akun (AC-5)

- [x] Di kedua komposisi, email terdaftar dengan password salah dan email tidak terdaftar → status 401, body `{"error":"Invalid credentials"}`, nama dan nilai header sama kecuali `Date` dan `X-Request-Id`, tanpa `Set-Cookie` → AC-5
- [x] Verifier pencatat: tiap jalur tepat satu verifikasi, jalur email terdaftar dengan hash akun dan jalur tidak terdaftar dengan hash tiruan, keduanya berawalan `$argon2id$v=19$m=19456,t=2,p=1$`; tiap jalur tepat satu baris percobaan `attempt_count` 1 di bawah kunci `sha256('sign-in:' + email)` → AC-5
- [x] Median durasi 20 percobaan tiap jalur (baris percobaan dihapus admin di antara percobaan, satu pemanasan per jalur) berbeda paling banyak 1,5 kali (2026-10-06 saat build: 24,1 ms dan 24,0 ms, rasio 1,01) → AC-5

## Perintah: batas percobaan dan slot verifikasi (AC-6)

- [x] Sepuluh percobaan salah per kunci (separuhnya dengan email berspasi dan huruf besar, yang menjadi kunci yang sama) → 401; percobaan ke 11 dengan password benar dan untuk email tidak terdaftar → 429 `{"error":"Too many requests"}` dengan `no-store`, tanpa verifikasi, tanpa `Set-Cookie`, tanpa sesi baru; hitungan berhenti di 11 → AC-6
- [x] Geser `window_started_at` 15 menit ke belakang lewat admin → percobaan berikutnya dihitung lagi dari 1; masuk benar sesudahnya 200 dan baris kunci itu hilang → AC-6
- [x] 25 percobaan bersamaan pada satu kunci (verifier cepat, slot besar) → tepat 10 jawaban 401 dengan 10 verifikasi dan 15 jawaban 429; `attempt_count` 11 → AC-6
- [x] Pembersihan: dengan 14 baris kunci lain yang jendelanya berakhir dan 2 yang belum, percobaan email tidak terdaftar menghapus tepat 10 baris berakhir, percobaan email terdaftar menghapus 4 sisanya, baris dalam jendela tetap; percobaan yang dijawab 429 tidak menghapus apa pun; jendela berakhir milik kunci sendiri dibuka lagi oleh reservasinya, tidak dihapus pembersihannya → AC-6
- [x] Slot bawaan (`VERIFY_SLOTS` tepat `{ running: 4, queue: 12, waitMs: 2000 }`): 17 masuk bersamaan dengan verifier yang ditahan → 4 verifikasi berjalan, 12 menunggu, masuk ke 17 langsung 503 `Service unavailable` dengan event `sign_in` `busy` berisi `accountKey` emailnya; sesudah verifier dilepas ke 16 sisanya diverifikasi → AC-6, AC-10
- [x] Slot `{ running: 1, queue: 1, waitMs: 300 }`: antrean penuh langsung 503, masuk yang menunggu lebih dari 300 ms 503; verifier yang melempar galat → 500 `{"error":"Internal server error"}` dengan `no-store` tanpa pesan galat, dan slot kembali sehingga masuk berikutnya diverifikasi → AC-6
- [x] Unit slot di `tests/integration/backend/auth.test.ts`: pelepasan yang dipanggil dua kali tidak menggandakan slot, slot yang dilepas diberikan ke permintaan tertua yang menunggu, dan antrean 0 menolak langsung → AC-6

## Perintah: log event `auth` dan kebocoran credential (AC-9, AC-10)

- [x] Komposisi production dengan sink pada database nyata, setiap request dengan `X-Request-Id` sendiri: masuk berhasil → `sign_in` `succeeded` dengan `userId`, `sessionId`, dan `accountKey` 16 karakter pertama `sha256('sign-in:' + email)`; password salah → `sign_in` `failed`; kunci di batas → `sign_in` `limited`; token CSRF salah → `request_rejected` `csrf`; pencabutan → `session_revoke` `succeeded` dengan `sessionId` sesi yang dicabut; id tidak ada → `session_revoke` `not_found` dengan `sessionId` `null`; origin palsu → `request_rejected` `origin`; keluar → `sign_out` `succeeded` → AC-10
- [x] Setiap baris `auth` mempunyai key tepat `time`, `level`, `event`, `requestId`, `action`, `outcome`, `userId`, `sessionId`, `accountKey` dalam urutan itu, `level` `info`, dan `requestId` sama dengan baris request request itu; setiap request tepat satu baris request → AC-10
- [x] Request di luar tabel *Log keamanan* (keluar tanpa sesi, GET 401, pencabutan tanpa sesi 401, masuk 400) hanya menulis baris request, tanpa baris `auth` → AC-10
- [x] Seluruh baris sink tidak memuat email, password, token sesi, token CSRF, `token_hash`, nama cookie, `$argon2id`, kata `password`, `email`, atau `cookie`; tidak ada baris `error` → AC-10
- [x] Jawaban guard (404 untuk `HEAD`, garis miring akhir, `PUT`, path tidak dikenal, `DELETE /api/auth/sessions/`; 400 untuk query atau body pada GET dan DELETE; 403; 415) membawa body `AuthError`, `Content-Type: application/json`, `Cache-Control: no-store`, dan tepat satu baris request; hanya 403 yang menambah satu baris `request_rejected` `origin` dengan `requestId` yang sama; `X-Request-Id` yang bukan 32 heksadesimal memberi satu id baru yang sama di kedua baris → AC-9, AC-10
- [x] DEP-007 di `logging.test.ts`: baris `auth` lalu baris request dengan `requestId` sama untuk 403 guard, satu baris request untuk 404 guard dengan query, dan satu baris `error` untuk 503 lifecycle biasa → AC-10
- [x] Tanpa sink, guard tidak menulis apa pun ke console → AC-10
- [x] Response alur penuh (masuk, GET sesi, daftar, password salah, body salah, CSRF salah, pencabutan, keluar, GET sesudah keluar) tidak memuat password, hash password, `$argon2id$`, token sesi, `token_hash`, atau token sesi lain; token CSRF hanya di body masuk dan GET sesi; token sesi hanya di `Set-Cookie` masuk → AC-10
- [x] 401 pada GET sesi, daftar sesi, dan masuk salah di kedua komposisi membawa `Cache-Control: no-store` → AC-9

## Perintah: kontrak OpenAPI dan adapter (AC-11)

- [x] `openapi.json`: kelima operasi auth dengan `operationId`, tag `auth`, `security`, dan status tepat tabel *API surface* (`signIn` 200, 400, 401, 403, 415, 429, 500, 503; `getAuthSession` dan `listAuthSessions` 200, 400, 401, 500, 503; `signOut` 204, 400, 403, 500, 503; `revokeAuthSession` 204, 400, 401, 403, 404, 500, 503), 204 hanya `description`, setiap status galat `$ref` `AuthError`, security scheme `sessionCookie` tepat tabel *Model kontrak*, tanpa parameter `in: cookie`, tanpa `example` atau `examples`; ekspor development langsung sama dengan file tersimpan → AC-11, AC-10
- [x] `REQUIRED_OPERATIONS` berisi tujuh entri: empat lama lalu `post /api/auth/session signIn` (`security: []`, `AuthSession`), `get /api/auth/session getAuthSession` dan `get /api/auth/sessions listAuthSessions` (`[{ sessionCookie: [] }]`, `AuthSession` dan `AuthSessionList`), semuanya frozen → AC-11
- [x] 26 mutasi kontrak tersimpan yang masing masing hanya melanggar entri auth (operasi dihapus, `operationId` atau tag lain, `security` lain, 200 ke model lain, `AuthSession` dengan `additionalProperties` true atau hilang, `csrfToken` keluar dari `required` atau hilang, properti `token`, `password`, `passwordHash`, atau `tokenHash` di tingkat mana pun, `user` berupa `$ref`, `AuthSessionList` dengan properti tambahan atau item berbeda) → `rule: required-operation` (2026-10-06 saat build: sesuai) → AC-11
- [x] `tests/fixtures/openapi/valid.json` dan `subset-full.json` memuat ketiga operasi wajib auth, model `AuthError`, `AuthSession`, `AuthSessionList`, `SignInRequest`, scheme `sessionCookie`, dan tag `auth` yang sama dengan kontrak tersimpan; `bun --no-env-file scripts/validate-openapi.ts <fixture>` → `OpenAPI project checks passed` → AC-11
- [x] `bun run api:sync` → `OpenAPI exported without listener`, `OpenAPI project checks passed`, SDK digenerate ulang dan identik byte; `bun run api:check` → `OpenAPI and SDK match stored artifacts across two runs` (2026-10-06 saat build: sesuai) → AC-11
- [x] Adapter dengan `HttpTestingController`: `signIn` satu `POST /api/auth/session` dengan body JSON `{ email, password }`, `Content-Type` dan `Accept` `application/json`, tanpa `Authorization`, tanpa `x-csrf-token`, `withCredentials` false; `session()` dan `sessions()` satu GET tanpa query dan body; `signOut` dan `revoke` satu DELETE dengan `x-csrf-token` tanpa body → AC-11
- [x] Setiap baris *Pemetaan adapter*: `signIn` 200 sah `signed-in`, 401 `invalid`, 429 `limited`, 403 `forbidden`, 503 `unavailable`, status 0 serta 502 dan 504 `network`, selain itu `failed` (termasuk 200 yang bentuknya salah dan 413); `session()` dan `sessions()` 401 `unauthenticated`; `signOut` 204 `signed-out` dan 200 `failed`; `revoke` 204 `revoked`, 401 `unauthenticated`, 404 `not-found`; setiap Observable selesai tanpa galat, body 200 dibangun ulang tanpa field tambahan, galat yang bukan `HttpErrorResponse` menjadi `failed` → AC-11
- [x] Harness backend nyata spec 0009 tanpa perubahan environment: `session()` dan `sessions()` → `unavailable` (503 tanpa database, route GET tanpa pemeriksaan origin); port tertutup → `network` → AC-11

## Perintah: Value sourcing (milestone 3)

- [x] Email ternormalisasi: kunci percobaan dihitung dari email sesudah `trim` dan huruf A sampai Z kecil, sehingga ` ANA@...` dan `ana@...` berbagi satu baris percobaan; email yang gagal aturan sesudah normalisasi 400 tanpa baris → AC-5, AC-6
- [x] Hash pembanding untuk email tidak terdaftar: hash tiruan dibuat sekali per instance plugin di luar slot verifikasi dan dipakai ulang; pada test slot bawaan ke 17 masuk menunggu promise yang sama sebelum mengambil slot → AC-5
- [x] Hitungan percobaan: satu transaksi pendek `INSERT ... ON CONFLICT (key_hash) DO UPDATE ... RETURNING attempt_count` sebelum verifikasi; jendela dibuka lagi bila `window_started_at <= now() - interval '15 minutes'`; jam database, bukan jam proses → AC-6
- [x] Pembersihan percobaan: satu statement terpisah sesudah reservasi pada kedua jalur, paling banyak 10 baris kunci lain yang jendelanya berakhir, tanpa kunci sendiri → AC-6
- [x] Verifikasi password: opsi `auth.verify` hanya dari test, selain itu `Bun.password.verify`, tepat sekali per percobaan yang lolos reservasi, tanpa koneksi atau transaksi terbuka (AUTH-004 pool satu koneksi tetap lulus) → AC-5, AC-6
- [x] Origin yang diizinkan: `PUBLIC_ORIGIN` lewat opsi `publicOrigin`, atau `http://127.0.0.1:8889` dan `http://localhost:8889` di development tanpa opsi, dan tidak ada di production tanpa opsi; alur browser `test:readiness:real` dan `test:tooling:real` lewat proxy development tetap masuk, keluar, dan mencabut sesi (2026-10-06 saat build: kedua test AUTH-012 lulus di kedua orkestrasi) → AC-9
- [x] Batas slot verifikasi: opsi `auth.slots` hanya dari test, selain itu `VERIFY_SLOTS` di `auth.policy.ts`; `index.ts` tidak pernah memberi opsi `auth` → AC-6
- [x] Log `requestId`: baris `auth` memakai `requestIdFor(request)` dan ditulis sebelum `writeRequestLine` pada jawaban guard, sehingga kedua baris satu request selalu sama → AC-10
- [x] Log `userId`, `sessionId`, `accountKey`, sink: kolom sesi hasil resolusi, 16 karakter pertama kunci percobaan, dan sink `AppOptions.log` yang sama dengan log request; tanpa sink tidak ada baris → AC-10

## Acceptance criteria coverage (milestone 3)

- AC-5: jawaban identik dan header sama, satu verifikasi dan satu percobaan per jalur, median durasi, aturan format sebelum slot, schema dan JSON rusak 400, properti tidak dikenal dibuang, 415 dan 403 dengan prioritas guard, 503 tanpa pool dan database tak terjangkau.
- AC-6: batas 10 per kunci termasuk request bersamaan, jendela berakhir, pembersihan bertahap, slot bawaan dan slot test; batas edge per client menyusul milestone 4 (`auth_edge_rate_limit`, `auth_capacity`).
- AC-9: origin dan `Sec-Fetch-Site` di guard untuk ketiga route, production tanpa `publicOrigin`, form lintas situs, urutan guard sebelum parse, satu baris log per jawaban guard, CSRF dengan event, `index.ts` gagal start tanpa `PUBLIC_ORIGIN`; check `auth_origin_csrf` lewat edge menyusul milestone 4.
- AC-10: log event `auth` dan isi log tanpa nilai rahasia, response tanpa credential, `openapi.json` tanpa contoh; storage browser sudah dibuktikan AUTH-012 milestone 1, sidik token uji pada pemindaian artefak menyusul milestone 4 dan 5.
- AC-11: kelima operasi dengan status tepat, `REQUIRED_OPERATIONS` dengan mutasi per entri, fixture checker, `api:sync` dan `api:check`, adapter lewat `HttpTestingController` dan harness backend nyata.

## Milestone 4: browser dan deployment

_Bagian ini mencakup milestone 4 (langkah 4 dan 5 build plan): setiap baris *State halaman* dan *Teks halaman* di browser lewat `tests/e2e/auth/sign-in.e2e.spec.ts` (`test:e2e`, tanpa database) dan `tests/e2e/auth/auth.real.e2e.spec.ts` (`test:readiness:real` dan `test:tooling:real`), *Sidik token uji* lewat `tests/orchestration/token-fingerprints.ts` dan `tests/e2e/auth/session-tokens.ts` di ketiga orkestrasi browser, image runner dengan `libs/server/auth/`, edge `limit_req`, check `auth_account_job`, `auth_session_cookie`, `auth_origin_csrf`, `auth_capacity`, dan `auth_edge_rate_limit`, varian `auth` `parseBackendLogLine`, `tests/e2e/deployment/auth.deployment.e2e.spec.ts` (AUTH-013), serta DEP-001 dan DEP-008 yang mengikutinya. Sidik token di `test:database:real`, registry `tests/scenarios/auth.json`, dan string wajib dokumen tetap milik milestone 5. Jalankan langkah Docker tanpa suite lain yang sedang berjalan, karena `auth_capacity` mengukur waktu._

## UI / manual: setiap baris State halaman (AC-12)

- [x] `bun run test:e2e` → ketiga test AUTH-012 di `sign-in.e2e.spec.ts` lulus terhadap backend tanpa database (2026-10-06 saat build: 3 lulus) → AC-12
- [x] `/masuk` tanpa database: judul `Masuk`, form `novalidate`, `Email` dengan `type="email"` dan `autocomplete="username"`, `Password` dengan `type="password"` dan `autocomplete="current-password"`, satu wilayah `role="alert"` dan satu `role="status"` yang kosong, dan tanpa request `/api/` saat dibuka → AC-12
- [x] Isian kosong, hanya email, atau email berisi spasi saja → alert `Isi email dan password.` tanpa request → AC-12
- [x] Keyboard: ketik email, Tab ke password, Tab ke tombol dan Shift+Tab kembali, Enter mengirim; selama request ditahan tombol `aria-disabled="true"`, Enter kedua dan klik kedua tidak mengirim request kedua (tepat satu `POST /api/auth/session`) → AC-12
- [x] Backend tanpa database → 503 dengan `Cache-Control: no-store` dan alert `Layanan belum tersedia. Coba lagi beberapa saat lagi.`; email tetap, password kosong, tombol aktif lagi → AC-12
- [x] Request masuk yang sama dikirim dengan `Origin: http://evil.test` → 403 dari guard backend dan alert `Permintaan ditolak. Muat ulang halaman, lalu coba lagi.`; dengan `Content-Type: text/plain` → 415 dan alert `Permintaan gagal. Coba lagi beberapa saat lagi.`; koneksi ditolak sebelum backend → alert `Backend tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.` → AC-12
- [x] `/akun` tanpa database: selama `GET /api/auth/session` ditahan, status `Memuat akun.` tanpa bagian `Profil` dan `Sesi aktif`; lalu alert `Layanan belum tersedia...` dengan tombol `Coba lagi`, URL tetap `/akun`, dan tanpa `GET /api/auth/sessions` → AC-12
- [x] `Coba lagi` dengan Enter mengulang panggilan; query string pada GET (400 dari guard) → alert `Permintaan gagal...`; koneksi ditolak → alert `Backend tidak dapat dihubungi...`; selalu dengan `Coba lagi` → AC-12
- [x] `/masuk` dan `/akun` pada 375×812 dan 1280×812 tanpa overflow horizontal → AC-12
- [x] `bun run test:readiness:real` → keempat test AUTH-012 di `auth.real.e2e.spec.ts` lulus bersama READY-009 (2026-10-06 saat build: 5 lulus, `Readiness artifact scan passed: 8 random values and 16 token fingerprints absent from 7 outputs and 14 files.`) → AC-10, AC-12
- [x] Database nyata: password salah untuk akun → 401 dan alert `Email atau password salah.`; sepuluh percobaan untuk email yang bukan akun → 401, percobaan ke 11 → 429 dan alert `Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.`; masuk lewat keyboard (Tab, Enter) membuka `/akun` → AC-6, AC-12
- [x] Akses lintas pengguna dari halaman A lewat API dengan token CSRF A yang tidak pernah keluar dari halaman: `DELETE /api/auth/sessions/<sesi pengguna C>` → 404 `{"error":"Not found"}`, sesi C tidak ada di daftar A, dan `/akun` C tetap menampilkan profil dengan sesi yang sama → AC-8, AC-12
- [x] `Akhiri sesi` dengan jawaban `forbidden` (token CSRF lain, 403 nyata, lewat Enter), `failed` (token CSRF berbentuk salah, 400 nyata), `network` (koneksi ditolak), dan `unavailable` (503 di batas page.route) → alert `Permintaan ditolak...`, `Sesi tidak dapat diakhiri. Coba lagi.`, `Backend tidak dapat dihubungi...`, `Layanan belum tersedia...`; daftar tetap; selama request berjalan hanya tombol itu yang `aria-disabled` dan tekan kedua tidak mengirim request → AC-12
- [x] `Keluar` dengan jawaban `forbidden`, `failed`, `network`, dan `unavailable` → teks state di alert, tetap di `/akun`, daftar tetap, `Keluar` aktif lagi → AC-12
- [x] `not-found`: browser B keluar, lalu A menekan `Akhiri sesi` pada sesi B yang masih tampil → 404, alert `Sesi sudah berakhir.`, `GET /api/auth/sessions` dimuat ulang tanpa sesi itu → AC-12
- [x] `unauthenticated`: B masuk lagi dan mengakhiri sesi A, lalu A menekan `Akhiri sesi` pada sesi baru B → 401, A pindah ke `/masuk` dengan status `Sesi Anda berakhir. Masuk lagi untuk melanjutkan.`, dan sesi baru B tetap aktif → AC-12
- [x] Sesudah masuk dan sesudah setiap aksi, `localStorage`, `sessionStorage`, dan IndexedDB tanpa nilai auth dan `document.cookie` tanpa cookie sesi; sesudah keluar, browser tidak lagi memegang cookie `foundation_session` → AC-10
- [x] `bun run test:tooling:real` → test AUTH-012 yang sama lulus di bawah `serve`, dengan pemindaian artefak `.local/feature-2/` memuat sidik token → AC-10, AC-12

## Perintah: sidik token uji (AC-10)

- [x] `test:readiness:real` dan `test:tooling:real`: orkestrasi membuat folder `foundation-readiness-tokens-*` atau `foundation-tooling-tokens-*` (0700) dengan file `fingerprints` kosong 0600 di luar `.local/`, memberi `FOUNDATION_TEST_TOKEN_KEY` dan `FOUNDATION_TEST_TOKEN_FINGERPRINTS` ke Playwright, dan menghapus folder itu sesudah pemindaian, juga sesudah SIGINT atau SIGTERM → AC-10
- [x] Setiap test browser yang masuk membaca cookie sesi lewat `context.cookies()` dan menambah sidik HMAC token serta token CSRF turunannya; file `fingerprints` hanya berisi baris 64 heksadesimal, tidak pernah token → AC-10
- [ ] `artifact-scan.json` memuat `tokenFingerprints` lebih dari 0 dan `tokenScanControl: true`; himpunan kosong sesudah alur browser yang lulus atau kontrol positif yang gagal menggagalkan langkah → AC-10
- [x] Kontrol positif: token acak yang sengaja ditulis ke file sementara di folder sidik terdeteksi tepat satu kali oleh fungsi pemindai yang sama; DEP-001 juga membuktikan fungsi itu (deret 43 karakter yang dibatasi karakter lain atau tepi file, deret lebih panjang tidak dihitung, kunci lain tidak cocok) → AC-10
- [ ] Mutasi: tulis token sesi yang diperoleh test ke stdout Playwright (misalnya `console.log`) → pemindaian menemukan `playwright output token` dan langkah gagal → AC-10

## Perintah: image runner, edge, dan Compose (AC-3, AC-6, AC-13)

- [x] `database/Dockerfile` menyalin `libs/server/auth/` ke `/app/libs/server/auth/` dan `database/Dockerfile.dockerignore` memuat `!libs/server/auth/`; `bun run test:deployment:plan` lulus DEP-001 (2026-10-06 saat build: `static.test.ts` 34 lulus) → AC-3, AC-13
- [x] `apps/frontend/edge/nginx.conf`: `map "$request_method:$foundation_path" $foundation_sign_in_client` dengan `"POST:/api/auth/session"` ke `$binary_remote_addr`, `limit_req_zone $foundation_sign_in_client zone=sign_in:10m rate=30r/m`, `limit_req_status 429`, di location `/api/` `limit_req zone=sign_in burst=10 nodelay` dan `error_page 429 @api_too_many_requests`, dan named location yang menjawab `{"error":"Too many requests"}` dengan header API dan `Cache-Control: no-store` → AC-6, AC-13
- [x] `deploy/compose.yaml` memberi backend `PUBLIC_ORIGIN: ${FOUNDATION_PUBLIC_ORIGIN:?}` dan `.env.deploy.example` memuat `FOUNDATION_PUBLIC_ORIGIN=` (dari milestone 1) → AC-13
- [x] `bun --no-env-file test ./tests/integration/deployment/signal.test.ts` → DEP-008 lulus dengan job akun yang dijawab pengganti `docker`, dan folder `foundation-deploy-*` di `TMPDIR` hilang sesudah sinyal (2026-10-06 saat build: 22 lulus) → AC-13

## Perintah: check deployment auth (AC-6, AC-9, AC-10, AC-12, AC-13)

- [x] `bun run test:deployment:real` → `result.json` `passed` dengan check `DEPLOYMENT_CHECKS` dalam urutan: `auth_account_job` sesudah `readiness_after_migration`, lalu `auth_session_cookie`, `auth_origin_csrf`, `auth_capacity`, `auth_edge_rate_limit` sesudah `browser_flow` dan sebelum `backend_shutdown_restart` (2026-10-06 saat build: `deployment: 41 check passed, 0 failed, 0 not_run`; `auth_capacity` 8 dari 8 kali 200 dengan terlama 614 ms; `auth_edge_rate_limit` 6 jawaban 401 dan 24 jawaban 429; `artifact_scan` 45 nilai run dan 4 sidik token tanpa temuan, `tokenScanControl: true`) → AC-13
- [x] `auth_account_job`: dua akun uji lewat `--profile migrate run --rm -T -e FOUNDATION_ACCOUNT_PASSWORD migrate database/accounts.ts create ... --apply` mencetak `Account created: <uuid>`, create ulang keluar 1 dengan `Account exists`, dan keluaran tanpa email maupun password → AC-3, AC-13
- [x] `browser_flow`: DEP-006 dan AUTH-013 berjalan di satu invocation Playwright; AUTH-013 masuk lewat edge, cookie `__Host-foundation_session` dengan `secure`, `httpOnly`, `sameSite` `Strict`, `path` `/`, host only, tanpa masa berlaku; `/akun` menampilkan akun pertama; navigasi Beranda dan Akun; `Keluar` menghapus cookie; tanpa pelanggaran CSP; detail mencatat jumlah POST masuk → AC-12, AC-13
- [x] `auth_session_cookie`: satu masuk lewat edge dengan `Origin` `FOUNDATION_PUBLIC_ORIGIN` → 200 dengan `no-store`, Header API, dan tepat satu `Set-Cookie` `__Host-foundation_session=<43>; Path=/; Secure; HttpOnly; SameSite=Strict` tanpa `Domain`, `Expires`, atau `Max-Age`; cookie itu membaca sesi yang sama lewat edge → AC-4, AC-13
- [x] `auth_origin_csrf`: lewat edge, masuk tanpa `Origin`, dengan origin asing, dengan `Sec-Fetch-Site: cross-site`, form urlencoded lintas situs, keluar dengan token CSRF salah, dan pencabutan tanpa `Origin` → 403 `{"error":"Forbidden"}` dari backend (`upstreamStatus` 403) dengan baris `auth` `request_rejected` `origin` atau `csrf` ber `requestId` sama; sesi tetap 200; keluar dengan token CSRF benar → 204 dengan cookie penghapus `Max-Age=0`, lalu token 401 → AC-9, AC-13
- [x] Anggaran: `browser_flow`, `auth_session_cookie`, dan `auth_origin_csrf` bersama sama paling banyak 10 `POST /api/auth/session` lewat edge dan tidak satu pun 429; detail ketiganya mencatat jumlahnya → AC-6, AC-13
- [x] `auth_capacity`: 8 masuk bersamaan dari dalam container backend dengan akun kedua → setiap jawaban 200 atau 503, paling sedikit 4 kali 200, 200 terlama paling lama 2.000 ms, `GET /health/ready` bersamaan 200, backend tanpa restart dan tanpa `OOMKilled` → AC-6, AC-13
- [x] `auth_edge_rate_limit`: 30 `POST /api/auth/session` lewat edge (paling banyak 5 bersamaan, email `batas-<run>-<n>@example.test` yang bukan akun) → setiap jawaban 401 `Invalid credentials` dari backend atau 429 `{"error":"Too many requests"}` dari edge dengan Header API dan `no-store`, paling sedikit satu 429, setiap 429 tanpa `upstreamStatus` dan tanpa baris request backend; jumlah 401 dan 429 di detail → AC-6, AC-13
- [x] `log_structure` menerima baris `auth` (key tepat, info hanya di stdout); `log_correlation` menemukan baris edge, baris request backend, dan baris `auth` `sign_in` `succeeded` masuk lewat edge dengan `requestId` sama dengan `X-Request-Id` jawabannya; `log_no_data` tanpa password akun uji, email akun uji, atau token yang dikenal sidiknya → AC-10, AC-13
- [x] `artifact_scan`: `artifact-scan.json` memuat `tokenFingerprints` lebih dari 0 dan `tokenScanControl: true`; sidik dari Playwright dan dari check orkestrasi sendiri dicocokkan ke `images.json`, JUnit, `test-results`, keluaran container dan perintah, `artifact-scan.json`, dan `result.json`; folder `foundation-deploy-tokens-*` hilang sesudahnya → AC-10, AC-13
- [x] `bun run test:gate` → DEP-004 di `release.test.ts` membaca baris check bertanda `0014/AC-n` di bagian *Deployment* `report.md`, sehingga daftar check laporan sama dengan `DEPLOYMENT_CHECKS` → AC-13
- [x] DEP-001: `parseBackendLogLine` menerima varian `auth` untuk setiap baris *Log keamanan* dan menolak key kurang atau lebih, kosakata lain, dan id yang tidak sesuai tabel; `sessionCookieProblems`, `signInBudgetProblems`, `edgeRateLimitProblems`, dan `capacityProblems` menolak setiap mutasi di test → AC-6, AC-10, AC-13

## Perintah: Value sourcing (milestone 4)

- [x] Frontend pesan sesudah pindah ke `/masuk`: `notice` `expired` dan `signed-out` tampil sekali di status `/masuk`, dibaca lalu dikosongkan, tidak lewat query, state router, atau storage → AC-12
- [x] Frontend teks: setiap teks di langkah UI di atas sama persis dengan tabel *Teks halaman* → AC-12
- [x] Frontend waktu sesi: atribut `datetime` sama dengan nilai API dan teks `<time>` tidak kosong pada locale `id-ID` dan zona `Asia/Jakarta` → AC-12
- [x] Origin yang diizinkan di production: backend container menerima `Origin` `https://localhost:<port>` dari `FOUNDATION_PUBLIC_ORIGIN` run itu dan menolak yang lain (`auth_origin_csrf`, `auth_capacity`) → AC-9, AC-13
- [x] Nama dan atribut cookie production lewat edge: `__Host-foundation_session` dengan `Secure`, dari mode `createApp`, bukan environment (`auth_session_cookie`, AUTH-013) → AC-4, AC-13
- [x] Batas edge: kunci `$binary_remote_addr` hanya untuk `POST /api/auth/session`; alamat client run sama sehingga satu bucket dipakai bersama, dan path atau method lain tidak pernah 429 dari edge → AC-6
- [x] Log `requestId`: baris edge, baris request backend, dan baris `auth` satu masuk lewat edge memakai id yang sama dengan header `X-Request-Id` jawaban → AC-10
- [x] Test sidik token: `FOUNDATION_TEST_TOKEN_KEY` dan `FOUNDATION_TEST_TOKEN_FINGERPRINTS` hanya dari orkestrasi; spec yang dijalankan tanpa keduanya gagal dengan pesan tetap, tidak dilewati → AC-10

## Acceptance criteria coverage (milestone 4)

- AC-6: limit edge per alamat client (`auth_edge_rate_limit`, konfigurasi edge DEP-001), kapasitas Argon2id di batas container backend (`auth_capacity`), state `limited` di browser.
- AC-9: origin, `Sec-Fetch-Site`, form lintas situs, dan CSRF ditolak lewat edge (`auth_origin_csrf`); `forbidden` di browser dari guard nyata.
- AC-10: *Sidik token uji* di `test:readiness:real`, `test:tooling:real`, dan `test:deployment:real` dengan kontrol positif; storage browser kosong sesudah setiap aksi; `log_no_data` dengan password, email, dan token; `test:database:real` menyusul milestone 5.
- AC-12: setiap baris *State halaman* lewat `sign-in.e2e.spec.ts` dan `auth.real.e2e.spec.ts`, kedua viewport, keyboard, kirim ganda, akses lintas pengguna lewat API dari halaman, dan alur production AUTH-013.
- AC-13: image runner dengan `libs/server/auth/`, job akun, edge `limit_req`, check deployment auth dalam urutan dan anggaran tabel *Perubahan deployment*, varian log `auth`, dan korelasi masuk lewat edge.

## Milestone 5: hook backup dan penutupan bukti

_Bagian ini mencakup milestone 5 (langkah 6 dan 7 build plan): akun dan sesi di sumber backup, asersi BKP-003 yang baru, BKP-009 sebagai test terakhir `backup.test.ts` dengan field `sessions` di `restore.json`, batas `bun test` 900.000 ms dan *Sidik token uji* di `tests/orchestration/database-real.ts`, `docs/rules/backup.md` (langkah 8, prosedur insiden, keputusan hook) dengan BKP-001, registry `tests/scenarios/auth.json` dan BKP-009 di `tests/scenarios/backup.json`, string wajib setiap dokumen tabel *Dokumen yang diperbarui* dengan AUTH-014, `serve` yang menghapus `FOUNDATION_ACCOUNT_PASSWORD`, test lama yang berubah (GATE-002, GATE-009, BKP-001, TOOL-003), dan gate lokal. Catatan amandemen bertanggal pada spec lain belum ditulis, karena itu konten spec milik `/architect`._

## Perintah: hook backup BKP-009 (AC-14)

- [x] `bun run test:database:real` → `tests/integration/database/backup.test.ts` lulus seluruhnya dan BKP-009 adalah testcase terakhir file itu di JUnit `.local/feature-5/database.xml` (2026-10-06 saat build: 122 test lulus di 6 file dalam 165 detik) → AC-14
- [x] `beforeAll` backup: migration repository dulu, lalu `bun --no-env-file database/accounts.ts create --email restore-<hex>@foundation.test --display-name 'Akun Uji Restore' --apply` dengan DSN migrator sumber dan password berlabel `backup-account`, lalu satu masuk lewat `createApp('production', { database: <pool backend sumber>, publicOrigin: 'https://foundation.test' })`, baru migration fixture `0011-users-restore-fixture.sql` dan seed → AC-14
- [x] BKP-003: tabel sumber `auth.password_credentials:1`, `auth.sessions:1`, `auth.sign_in_attempts:0`, `common.schema_migrations:11`, `users.restore_fixture:3`, `users.users:1`, `migrations.count` 11, dan `migrations.last` berakhiran `-users-restore-fixture.sql`; teks dump tidak memuat password akun, token sesi, atau token CSRF (pemindaian `secretScan`) → AC-10, AC-14
- [x] BKP-009 pada target sesudah restore: `GET /api/auth/session` dengan cookie `__Host-foundation_session` dari sumber → 200 dengan `session.id` dan email yang sama dan token CSRF yang sama; `database/accounts.ts revoke-sessions --all --apply` lewat command line repository menolak target itu dengan `Migration history drift` tanpa perubahan (target memuat migration fixture), lalu perintah yang sama lewat `accountCommand` dengan root fixture mencetak `Sessions revoked: 1`; GET yang sama → 401 `{"error":"Unauthorized"}` dengan `Set-Cookie` penghapus; run kedua → `Sessions revoked: 0` dan exit 0 → AC-3, AC-14
- [x] Query admin target sesudah BKP-009 → baris sesi itu mempunyai `revoked_reason` `operator` dan `revoked_at` terisi → AC-14
- [x] `.local/feature-14/restore.json` → `status` `passed`, `failures` kosong, dan `sessions` tepat `{ "beforeRevokeStatus": 200, "afterRevokeStatus": 401, "revoked": 1, "rerunRevoked": 0 }`; `secretScan.findings` kosong (2026-10-06 saat build: sesuai, `valuesChecked` 42) → AC-14
- [ ] Batas waktu bernama: BKP-009 yang dimulai lebih dari 25 menit sesudah masuk di sumber gagal dengan pesan `BKP-009 started <n> minutes after the source sign in, past the 25 minute limit inside the 30 minute idle time`, bukan dengan 401 → AC-14
- [ ] Mutasi: `revoke-sessions --all` yang tidak mencabut apa pun (`AND false` pada statement pencabutan semua akun) → BKP-009 gagal dengan `Expected: 1, Received: 0` (2026-10-06 saat build: sesuai, sumber dikembalikan sesudahnya) → AC-14
- [x] Baca `database/accounts.ts`: `accountCommand(args, env, root?)` meneruskan `root` ke `withOwnerTransaction` hanya bila diberikan; baris `import.meta.main` tidak pernah memberikannya, sehingga perintah operator selalu memeriksa migration repository → AC-3

## Perintah: dokumen backup dan BKP-001 (AC-14)

- [x] `docs/rules/backup.md` langkah 8 *Runbook restore* diawali tepat `8. Cabut seluruh sesi sebelum backend berjalan (*Hook fitur 15*):` dan diikuti blok perintah `docker compose -p <target> ... --profile migrate run --rm migrate database/accounts.ts revoke-sessions --all --apply` serta keluaran `Sessions revoked:`, sebelum backend langkah 9 → AC-14
- [x] *Prosedur insiden*: baris kehilangan data memuat `Cabut seluruh sesi lewat langkah 8 *Runbook restore*`; baris credential bocor memuat `cabut seluruh sesi dengan backend berhenti` dengan perintah stop backend, `revoke-sessions --all --apply`, lalu backend dibuat ulang; baris backup bocor memuat `SELECT email FROM users.users ORDER BY email` dan `set-password` → AC-14
- [x] *Hook fitur 15* tetap lima butir bernomor, butir 1 sampai 5 mencatat keputusan tabel *Keputusan hook backup* (termasuk butir 3, 4, dan 5), dan paragraf penutupnya tepat `Kontrak ini terisi oleh spec 0014 (tabel *Keputusan hook backup*).`; `grep -c 'tidak berlaku sampai fitur 15' docs/rules/backup.md` → 0 → AC-14
- [x] `bun --no-env-file test ./tests/integration/deployment/backup-static.test.ts` → BKP-001 lulus, termasuk registry BKP-001 sampai BKP-009 dan setiap mutasi langkah 8, insiden, penutup hook, dan string lama (2026-10-06 saat build: 16 lulus) → AC-14, AC-15
- [x] `tests/scenarios/backup.json` memuat BKP-009 (`bun:test`, `tests/integration/database/backup.test.ts`, `test:database:real`) dengan kriteria `AC-8` spec 0013, sumber registry itu; BKP-001 mengambil file dan script dari baris BKP-009 spec 0014 → AC-14

## Perintah: sidik token uji di test:database:real (AC-10)

- [x] `bun run test:database:real` → `.local/feature-5/artifact-scan.json` memuat `tokenFingerprints` lebih dari 0, `tokenScanControl: true`, dan `findings` kosong; keluaran `Database artifact scan passed: <n> random values and <m> token fingerprints absent from <k> files.` (2026-10-06 saat build: 274 nilai, 128 sidik, 22 file) → AC-10
- [x] Orkestrasi membuat folder `foundation-database-tokens-*` (0700) dengan file `fingerprints` 0600 di folder sementara sistem, memberi `FOUNDATION_TEST_TOKEN_KEY` dan `FOUNDATION_TEST_TOKEN_FINGERPRINTS` ke `bun test`, memindai keluaran `bun test`, JUnit, `restore.json`, bundle frontend, dan `artifact-scan.json` nya sendiri, dan menghapus folder itu pada setiap jalur keluar → AC-10
- [ ] Setiap masuk 200 di `tests/integration/database/auth.test.ts` dan di `beforeAll` backup menambah sidik token sesi dan token CSRF lewat `recordTokenFingerprintsWhenConfigured`; suite yang dijalankan sendiri tanpa variable itu tidak menulis apa pun, dan himpunan kosong sesudah orkestrasi menggagalkan langkah dengan `Token fingerprints missing after the database suites` → AC-10
- [ ] Password akun suite database berasal dari seed run dengan label `account-<n>` (paling banyak 256) dan `backup-account`; `database-real.ts` menambah semuanya ke daftar pindai, dan password ke 257 menggagalkan suite dengan pesan tetap → AC-10
- [x] `bun --no-env-file test ./tests/integration/gate/signal-cleanup.test.ts` → GATE-009 lulus dengan `timeoutMs` 900.000, grace 75.000, dan pesan `Database integration tests exceeded 900 seconds` → AC-15

## Perintah: registry, dokumen, dan serve (AC-15)

- [x] `bun run test:scenarios` → `Scenario registries passed (108 unique IDs, 157 checks).` dengan `tests/scenarios/auth.json` (`source` spec 0014) memuat AUTH-001 sampai AUTH-014 dengan file, script, dan kriteria tabel *Critical test scenarios*; AUTH-012 dan AUTH-013 `critical` dengan check Playwright pada script tier → AC-15
- [x] `bun --no-env-file test ./tests/integration/gate/registry.test.ts` → GATE-002 lulus dengan alur kritis `APP-002`, `AUTH-012`, `AUTH-013`, `DEP-006`, `READY-006`, `READY-009`, `UI-001` → AC-15
- [x] `bun run test:deployment:plan` → AUTH-014 di `tests/integration/deployment/auth-static.test.ts` lulus: tabel di test sama dengan tabel *Dokumen yang diperbarui* spec selain `docs/rules/backup.md`, setiap string ada secara harfiah, dan menghapus satu string mana pun dari dokumennya dilaporkan dengan dokumen dan string itu (2026-10-06 saat build: 74 test lulus di 4 file; mutasi `bun run db:accounts` di README menggagalkan kedua test AUTH-014) → AC-15
- [x] Baca dokumen: `docs/rules/security.md`, `docs/rules/database.md`, `docs/rules/deployment.md`, `docs/rules/openapi-sdk.md`, `docs/rules/development-commands.md`, `docs/rules/testing.md`, `README.md`, dan `.env.example` menjelaskan alur yang dibangun dengan bahasa proyek, tanpa nilai rahasia; `docs/rules/deployment.md` tidak lagi menyatakan tidak ada rate limit → AC-15
- [x] `bun --no-env-file test ./tests/integration/tooling/development.test.ts` → TOOL-003 lulus dengan `FOUNDATION_ACCOUNT_PASSWORD` tidak ada di environment backend, frontend, maupun worker yang dipilih `serve` → AC-10, AC-15
- [x] `bun run test:readiness:real` dan `bun run test:tooling:real` → test AUTH-010 baru di `auth.real.e2e.spec.ts` lulus: akun kedua masuk, reload, dan keluar; cookie `foundation_session` `httpOnly`, `sameSite` `Strict`, `path` `/`, tanpa `secure`, cookie sesi browser; storage dan `document.cookie` tanpa nilai auth; tidak ada body API yang memuat token atau password; token CSRF hanya di body `POST` dan `GET /api/auth/session` 200 → AC-10
- [x] `bun run test:ci`, `bun run test:ci:real`, `bun run test:ci:security`, lalu `bun run test:report` → ketiga tier `passed` dan laporan memuat AUTH-001 sampai AUTH-014 serta BKP-009 dengan status `passed` → AC-15

## UI / manual: kursor email di /masuk (AC-12, perbaikan milestone 5)

- [x] Di `/masuk` pada Chromium, ketik dua spasi lalu `a` di field Email, tunggu sebentar, lalu ketik sisa email → field berisi email utuh dalam urutan yang diketik, bukan sisa email di depan huruf pertama (2026-10-06 saat build: sebelum perbaikan `na@example.test  a`, sesudah perbaikan `ana@example.test`) → AC-12
- [x] `bun run test:e2e` → test AUTH-012 `/masuk without a database` lulus dengan langkah keyboard yang mengetik spasi luar, menunggu dua frame, lalu mengetik sisanya; template email tidak lagi memakai binding `[value]` (halaman tidak pernah menulis email) → AC-12

## Perintah: Value sourcing (milestone 5)

- [ ] Test sidik token: `FOUNDATION_TEST_TOKEN_KEY` dan `FOUNDATION_TEST_TOKEN_FINGERPRINTS` dari `database-real.ts` untuk suite `bun:test`; kunci berbeda setiap run, dan sidik dari run lain tidak cocok → AC-10
- [x] Semua waktu: masa idle sesi yang dipulihkan dihitung dari `now()` target; BKP-009 diterima karena `idle_expires_at` dari backup masih di depan jam database target → AC-7, AC-14
- [x] Operator: jumlah sesi dicabut di `restore.json` (`revoked`) sama dengan angka baris `Sessions revoked: <n>`, yaitu jumlah baris `UPDATE` → AC-3, AC-14

## Acceptance criteria coverage (milestone 5)

- AC-10: pemindaian `test:database:real` kini mencakup password akun suite database dan sidik token dengan kontrol positif, sehingga keempat orkestrasi memakai *Sidik token uji*; AUTH-010 browser di `auth.real.e2e.spec.ts`; `serve` tidak meneruskan `FOUNDATION_ACCOUNT_PASSWORD`.
- AC-14: BKP-009 dengan field `sessions`, langkah 8, prosedur insiden, dan keputusan hook di `docs/rules/backup.md`, BKP-001 yang baru, dan BKP-009 di `tests/scenarios/backup.json`.
- AC-15: `tests/scenarios/auth.json`, AUTH-014, string wajib dokumen, test lama yang berubah (GATE-002, GATE-009, BKP-001, TOOL-003), dan gate lokal; catatan amandemen bertanggal spec 0003, 0004, 0006, 0007, 0008, 0009, 0012, dan 0013 menunggu `/architect`.
