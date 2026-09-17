# Scope Foundation

Fondasi web lokal dengan auth, user, jobs, cache dan SMTP.

**Build approach:** Tracer Bullet, satu jalur nyata lintas database, antrean, email, API dan UI terlebih dahulu.
**Workflow:** Beta, auth/passkey GA. Review spec terpisah dilewati.

## At a glance

| # | Feature | Phase | Status |
|---|---|---|---|
| 1 | Foundation | Foundation | done |
| 2 | Data model | Foundation | done |
| 3 | User, auth dan passkey | Slice | in-progress |
| 4 | Jobs native Redis | Slice | done |
| 5 | Cache dan lock | Slice | done |
| 6 | Email SMTP dan outbox | Slice | done |
| 7 | UI aplikasi | Slice | done |

## Urutan irisan

1. Struktur, migrasi dan komponen dasar.
2. CLI register, outbox, Redis, SMTP, aktivasi, login dan dashboard.
3. Pemulihan akun, passkey dan admin user.
4. Pemulihan worker, cache/lock dan pengujian gangguan.
5. Bukti AC, review auth dan dokumentasi operasional.

### 1. Foundation · done
Membangun kontrak foundation sesuai spec yang disepakati.

**Done when:** FND-001, FND-002, FND-003, OPS-001 memiliki implementasi dan bukti yang lulus.

* [x] Design it (spec): [0001-foundation](../../specs/_root/0001-foundation/index.md)
* [x] Build it: implementasi dan integrasi
* [x] Verify it: pemeriksaan aplikasi nyata
* [x] Test it: tes otomatis terkait

### 2. Data model · done
Membangun kontrak data model sesuai spec yang disepakati.

**Done when:** FND-003, AUTH-001, MAIL-001 memiliki implementasi dan bukti yang lulus.

* [x] Design it (spec): [0002-data-model](../../specs/_root/0002-data-model.md)
* [x] Build it: implementasi dan integrasi
* [x] Verify it: pemeriksaan aplikasi nyata
* [x] Test it: tes otomatis terkait

### 3. User, auth dan passkey · in-progress

Mengganti password dengan tautan email yang dikonfirmasi pada frontend dan divalidasi backend. Passkey tetap tersedia; mode browser dipilih melalui ENV wajib.

**Done when:** AC-1 sampai AC-13 pada spec 0008 memiliki implementasi dan bukti yang lulus, termasuk kedua mode ENV, migrasi akun lama, serta gerbang GA auth dan perangkat passkey fisik.

* [x] Design it (spec): [0008-email-link-auth](../../specs/_root/0008-email-link-auth/index.md)
* [ ] Build it: /develop auth tautan email
  * [ ] CLI, email, token, kedua mode ENV, callback, sesi, dan migrasi tanpa password (AC-1, AC-2, AC-3, AC-4, AC-5, AC-9, AC-13).
  * [ ] Konfirmasi ulang, passkey, serta pemeriksaan role dan kepemilikan (AC-6, AC-7).
  * [ ] Pembatas, kegagalan, dan state UI yang dapat dipulihkan (AC-8, AC-10, AC-11).
  * [ ] Pembersihan token oleh worker (AC-12).
* [ ] Verify it: /check verify auth tautan email
* [ ] Test it: /test auth tautan email
* [ ] Review it (fresh model): /check review auth tautan email
* [ ] Document it: /document auth tautan email

Desain 0008 disetujui pada 2026-09-17; pemeriksaan spec tambahan dilewati. Bukti auth versi 0003 tetap menjadi riwayat, bukan bukti bahwa alur pengganti sudah dibangun atau lulus.

### 4. Jobs native Redis · done
Membangun kontrak jobs native redis sesuai spec yang disepakati.

**Done when:** JOB-001, JOB-002, JOB-003, MAIL-001 memiliki implementasi dan bukti yang lulus.

* [x] Design it (spec): [0004-jobs](../../specs/_root/0004-jobs/index.md)
* [x] Build it: implementasi dan integrasi
* [x] Verify it: pemeriksaan aplikasi nyata
* [x] Test it: tes otomatis terkait

### 5. Cache dan lock · done
Membangun kontrak cache dan lock sesuai spec yang disepakati.

**Done when:** CACHE-001, OPS-001 memiliki implementasi dan bukti yang lulus.

* [x] Design it (spec): [0005-cache](../../specs/_root/0005-cache.md)
* [x] Build it: implementasi dan integrasi
* [x] Verify it: pemeriksaan aplikasi nyata
* [x] Test it: tes otomatis terkait

### 6. Email SMTP dan outbox · done
Membangun kontrak email smtp dan outbox sesuai spec yang disepakati.

**Done when:** MAIL-001, OPS-001 memiliki implementasi dan bukti yang lulus.

* [x] Design it (spec): [0006-email](../../specs/_root/0006-email.md)
* [x] Build it: implementasi dan integrasi
* [x] Verify it: pemeriksaan aplikasi nyata
* [x] Test it: tes otomatis terkait

### 7. UI aplikasi · done
Membangun kontrak ui aplikasi sesuai spec yang disepakati.

**Done when:** UI-001, UI-002, USER-001 dan alur UI PASSKEY-001 memiliki bukti browser yang lulus. Penerimaan perangkat passkey fisik ditelusuri pada fitur auth.

* [x] Design it (spec): [0007-ui](../../specs/_root/0007-ui.md)
* [x] Build it: implementasi dan integrasi
* [x] Verify it: pemeriksaan aplikasi nyata
* [x] Test it: tes otomatis terkait

## Deferred
Docker, deployment, registrasi publik, tenant, OAuth, scheduler berulang, chain/batch, cache tags, delete akun dan perubahan email.

## Status
planned berarti belum mulai; in-progress berarti implementasi atau bukti masih berjalan; done hanya ketika gate yang disepakati memiliki bukti. Detail tugas berada di spec.

## Bukti dan tindak lanjut

[Matriks AC](../../verification/ac-matrix.md) mencatat 51 tes backend, 7 tes Angular, 1 alur browser layanan nyata dan 9 tes UI terisolasi yang lulus. [Review auth](../../reviews/2026-09-16-auth.md) berstatus Approve. Seluruh tugas pembangunan telah diimplementasikan; penerimaan GA auth tetap menunggu perangkat fisik.

Status done pada fitur lain mengacu pada implementasi dan lingkungan uji yang tercatat. Konfigurasi penggunaan lokal masih memerlukan SMTP sebenarnya dan persistence Redis (AOF layanan bersama belum aktif). Pengujian SMTP sink dan Redis AOF terisolasi tidak membuktikan konfigurasi layanan tersebut. Langkah penutup tersedia dalam [runbook](../../verification/operations.md).
