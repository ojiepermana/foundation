# Matriks penerimaan Foundation

Tanggal bukti: **16 September 2026**. Implementasi mencakup seluruh irisan dalam rencana. Penerimaan GA auth/passkey masih terbuka untuk perangkat fisik; hasil authenticator virtual tidak menggantikannya.

`Lulus` berarti kondisi pada baris tersebut sudah diuji. `Sebagian` berarti implementasi tersedia tetapi ada bukti wajib yang belum diperoleh. Tugas pembangunan menggunakan ID AC yang sama agar penelusuran tetap stabil.

## AC → tugas → pengujian → bukti → status

| AC | Kondisi awal, tindakan, hasil yang diharapkan | Tugas / implementasi | Pengujian dan bukti | Status |
|---|---|---|---|---|
| FND-001 | Dari root, instalasi frozen dan pemeriksaan struktur berhasil; hanya ada satu manifest aplikasi, lockfile, dan instalasi dependensi. Manifest milik dependensi/output tidak dihitung. | [Package root](../../package.json), [pemeriksa struktur](../../scripts/check-structure.ts) | `bun install --frozen-lockfile`, `bun run check:structure`; E-01 | Lulus |
| FND-002 | Ketika `bun run dev` dijalankan, Angular tersedia pada 8088, API pada 8888, worker hidup; `/api` dari browser diteruskan melalui origin Angular. | [Pengelola dev](../../scripts/dev.ts), [konfigurasi Angular](../../angular.json), [API](../../apps/api/main.ts) | HTTP 200 pada login 8088, liveness/ready 8888, ready lewat proxy 8088; E-06 | Lulus |
| FND-003 | Database kosong dimigrasikan; pengulangan tidak menggandakan schema; dua migrator diserialisasi; checksum berubah ditolak; migrasi rusak rollback. Build dan typecheck berhasil. | [Migrator](../../server/migrations.ts), [SQL](../../database/migrations), [konfigurasi](../../server/config.ts) | `operations.test.ts`, database E2E baru, build/typecheck; E-01–04 | Lulus |
| AUTH-001 | CLI menerima nama/email/role, menormalkan email, membuat user pending bersama digest token dan outbox terenkripsi secara atomik; duplikat gagal; resend mengganti token lama. | [CLI](../../scripts/user-register.ts), [AuthService](../../server/auth.ts), [outbox](../../server/mail/index.ts) | `auth.test.ts`: CLI, duplikat, resend; `mail.test.ts`: rollback; E-02, E-04 | Lulus |
| AUTH-002 | Token aktivasi valid membuat password dan mengaktifkan akun sekali saja; login valid membuat cookie session; salah password, token expired/replay, origin asing, dan CSRF salah ditolak. Reload memulihkan session. | [AuthService](../../server/auth.ts), [security](../../server/security.ts), [API](../../apps/api/app.ts), [UI auth](../../apps/web/src/app) | `auth.test.ts`: activation race/expiry/CSRF/session; `flow.spec.ts`: SMTP→aktivasi→login→reload; E-02, E-04 | Lulus |
| AUTH-003 | Logout mencabut session; forgot memberi respons generik; reset sekali pakai mencabut seluruh session/password lama; perubahan password merotasi session; limiter menolak percobaan berlebih dan gagal tertutup saat Redis mati. | [AuthService](../../server/auth.ts), [limiter](../../server/rate-limit.ts), [API](../../apps/api/app.ts) | `auth.test.ts`, `operations.test.ts`, reset browser; E-02, E-04 | Lulus |
| USER-001 | User biasa ditolak API/UI admin; admin mengedit nama/role/status; disable mencabut akses; dua admin tidak bisa bersamaan menghapus admin aktif terakhir; identitas admin lama ditolak setelah demosi. | [AuthService](../../server/auth.ts), [UI pengguna](../../apps/web/src/app) | `auth.test.ts`: role/disable/concurrency/stale identity; `ui.spec.ts` dan `flow.spec.ts`; E-02, E-04 | Lulus |
| PASSKEY-001 | Pemilik yang baru mengonfirmasi password dapat mendaftar, melihat, dan menghapus passkey. Challenge terikat session/user, sekali pakai; login memverifikasi WebAuthn dan akun. Login passkey tidak otomatis memberi konfirmasi password. Perangkat virtual **dan fisik** harus dibuktikan terpisah. | [AuthService](../../server/auth.ts), SimpleWebAuthn, UI profil/login | Invalid response, binding dan reauth API; CTAP2 virtual resident key+UV, daftar/login/replay/hapus melalui browser; E-02, E-04, E-05. Langkah fisik di [verify auth](../specs/_root/0003-user-auth/verify.md). | **Sebagian: virtual lulus, fisik pending** |
| JOB-001 | Dispatch langsung/delay, backoff, timeout, concurrency, failed list dan manual retry berjalan; ID sama tidak menduplikasi job dan konflik payload ditolak. | [Queue](../../server/queue), [CLI jobs](../../scripts/jobs.ts) | `queue.test.ts`: dispatch, due time, retry budget, timeout, concurrency; E-02 | Lulus |
| JOB-002 | Dua worker tidak merebut lease sehat. Worker yang mati dipulihkan melalui pending entries. Restart Redis dengan AOF mempertahankan ready/delayed/pending. Side effect memakai idempotency key. | [Queue](../../server/queue), [worker](../../apps/worker/main.ts) | Dua worker, child process SIGKILL, Redis terisolasi SIGKILL/restart AOF; `queue.test.ts`, `queue-durability.test.ts`; E-02 | Lulus pada Redis uji dengan AOF; konfigurasi layanan lokal masih terbuka |
| JOB-003 | Setelah lease/token kepemilikan berubah, worker lama tidak dapat heartbeat, complete, atau menjadwalkan retry; pemilik baru dapat menyelesaikan pekerjaan. | [Lua queue](../../server/queue/lua.ts) | `queue.test.ts`: superseded owner, expired lease, late resolution; E-02 | Lulus |
| CACHE-001 | TTL menghapus data; add hanya satu pemenang; increment atomik lintas proses; remember memakai nilai tersimpan; pemilik lock lama tidak bisa release/renew lock baru; clear mempertahankan queue/lock/namespace lain. | [Cache](../../server/cache/index.ts), [CLI cache](../../scripts/cache.ts) | `cache.test.ts` unit dan integrasi, termasuk proses Bun terpisah; E-02 | Lulus |
| MAIL-001 | Commit akun menghasilkan outbox; rollback tidak mengirim; Redis berisi referensi saja; SMTP menerima HTML/teks; kegagalan mempertahankan ciphertext untuk retry; sent tidak dikirim ulang; sender lama tidak menimpa lease baru. | [Mail](../../server/mail), [worker](../../apps/worker/main.ts) | `mail.test.ts` unit/integrasi, SMTP sink nyata, relay Redis, browser CLI→email; E-02, E-04 | Lulus pada SMTP lokal |
| UI-001 | Pengunjung tanpa session diarahkan ke login; login memakai LayoutFluid tengah; dashboard memakai LayoutWrapperDefault/navigation, sapaan dari session dan placeholder; profil serta admin terhubung API. | [Angular](../../apps/web/src/app), [panduan visual](../../design.md) | Build, Angular unit, UI terisolasi, live browser; [gambar dashboard](assets/dashboard.png); E-01, E-03, E-04 | Lulus |
| UI-002 | Form berlabel, validasi/status terlihat, keyboard Tab/Enter bekerja; mobile 375px tidak overflow; navigasi mobile terbuka; empty/error/retry dapat dioperasikan. | [Angular](../../apps/web/src/app), [registry UI](../../ui-registry.md) | 9 tes UI terisolasi, termasuk keyboard, mobile, empty/error/retry; E-04. Bukan audit menyeluruh semua pembaca layar. | Lulus untuk pemeriksaan tercatat |
| OPS-001 | Gangguan PostgreSQL/Redis menghasilkan respons aman; limiter gagal tertutup; SMTP dapat dipulihkan; langkah pemulihan dan batas durability tercatat tanpa mengubah layanan bersama. | [Health/API](../../apps/api/app.ts), [worker/mail](../../server/mail/index.ts), [runbook](operations.md) | `operations.test.ts`, `mail.test.ts`, `queue-durability.test.ts`; E-02 | Lulus untuk skenario teruji |

## Bukti yang direkam

### E-01 — toolchain dan build

- Runtime terpasang: Bun 1.4.2; Node 22.23.1 untuk tooling Angular.
- `bun install --frozen-lockfile`: exit 0, 457 instalasi / 591 paket diperiksa, lockfile tidak berubah.
- `bun run check:structure`: exit 0, struktur satu manifest dan instalasi root valid.
- `bun run typecheck:server`: exit 0.
- `bun run build`: exit 0; initial bundle 524.49 kB, estimasi transfer 118.16 kB. Angka build ini bukan pengukuran performa pengguna.
- PostgreSQL lokal 18.0 dan Redis lokal 7.4.8 berhasil dipakai tes integrasi.

### E-02 — backend dan layanan

```sh
TEST_REDIS_URL=redis://127.0.0.1:6379 bun test --timeout 30000 tests/unit tests/integration
```

Hasil akhir: **51 pass, 0 fail, 0 skip, 250 assertions**, 10 file, 9.57 detik. Log lokal: `.local/backend-final.log`. PostgreSQL memakai `TEST_DATABASE_URL`, Redis memakai namespace unik. Tes restart memakai proses Redis terisolasi dengan `appendfsync always`; layanan Redis bersama tidak diubah.

### E-03 — Angular

`bun run test:web`: **7 tes lulus**, 2 file. Tes mencakup session restoration, interceptor/CSRF, kehilangan session, error layanan, serta validasi form aktivasi.

### E-04 — browser

- `bun run test:e2e`: **9 tes lulus** pada pemeriksaan gabungan pertama: 1 alur layanan nyata dan 8 UI terisolasi, Chromium, 17.4 detik. Log `.local/browser-final.log`.
- Sesudah menambahkan pemeriksaan keyboard dan memperketat mobile dari 390px ke 375px: `bun run test:e2e --grep 'UI isolation'`: **9 tes UI lulus**. Hanya berkas tes yang berubah; aplikasi tidak berubah.
- Total skenario browser saat ini: **10**, semuanya memiliki hasil lulus; bukan klaim satu run berisi 10 tes.
- Alur nyata membuat database sementara, prefix Redis unik, SMTP sink lokal, API 8890, Angular 8090. CLI membuat admin/user; worker mengirim aktivasi; browser mengaktifkan, login, memulihkan session, mengubah profil, mendaftarkan/login/menghapus passkey, menonaktifkan user, memeriksa last admin, lalu reset password.
- WebAuthn memakai authenticator **virtual CTAP2** dengan resident key dan user verification. Tidak ada bukti perangkat fisik atau Safari.
- Seluruh akun/email untuk tes bersifat sementara; tidak ada pengiriman ke SMTP eksternal.

### E-05 — review auth GA

[Review kode oleh model terpisah](../reviews/2026-09-16-auth.md): **Approve**, tanpa temuan terbuka. Dua temuan awal diperbaiki: session passkey tidak dianggap password reauthentication, dan daftar admin memeriksa ulang role terkini. Review mencatat batas perangkat fisik.

### E-06 — smoke aplikasi lokal

`bun run dev` menjalankan API, worker, dan Angular. Pemeriksaan HTTP memberi 200 untuk:

- `http://localhost:8088/login`
- `http://localhost:8088/api/health/ready`
- `http://localhost:8888/api/health/live`
- `http://localhost:8888/api/health/ready`

Migrasi 0001 dan 0002 sudah diterapkan pada database lokal aplikasi/pengujian. Readiness memeriksa PostgreSQL/Redis; hasil hijau tidak menyatakan SMTP atau konfigurasi durability siap.

## Pekerjaan penerimaan yang masih terbuka

| ID tindak lanjut | Tindakan | Bukti penutup |
|---|---|---|
| PASSKEY-001-physical | Pemilik perangkat menjalankan checklist passkey fisik, termasuk pembatalan dialog, logout/login ulang dan penghapusan. | OS/browser/perangkat, tanggal, hasil setiap langkah; token/kredensial tidak dicatat. |
| LOCAL-SMTP | Isi SMTP lokal yang akan dipakai; `.env` saat ini menunjuk placeholder 127.0.0.1:1025. | Aktivasi akun yang memang diizinkan sampai inbox tujuan dan status outbox `sent`. Sink tes tidak membuktikan keterkiriman inbox nyata. |
| LOCAL-REDIS | Konfigurasikan persistence pada layanan Redis milik aplikasi dan pertahankan `noeviction`. Layanan bersama saat ini belum memakai AOF. | Kebijakan RPO, persistence aktif, restart terkontrol dan pemeriksaan job; jangan klaim hasil Redis uji sebagai konfigurasi layanan bersama. |

Belum dilakukan: deployment, pengukuran beban produksi, kompatibilitas Safari, audit pembaca layar menyeluruh. Fitur deferred tetap mengikuti scope; tidak menjadi janji implementasi versi ini.
