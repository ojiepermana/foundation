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
Membangun kontrak user, auth dan passkey sesuai spec yang disepakati.

**Done when:** AUTH-001, AUTH-002, AUTH-003, USER-001, PASSKEY-001 memiliki implementasi dan bukti yang lulus.

* [x] Design it (spec): [0003-user-auth](../../specs/_root/0003-user-auth/index.md)
* [x] Build it: implementasi dan integrasi
* [ ] Verify it: alur layanan dan passkey virtual lulus; perangkat passkey fisik belum diuji
* [x] Test it: tes otomatis terkait
* [x] Review it: review kode auth/passkey oleh model terpisah
* [x] Document it: catat hasil dan batas keamanan

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
