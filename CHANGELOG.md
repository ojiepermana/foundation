# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Kerangka Angular dan backend Elysia yang dapat dibuild melalui satu manifest root, dengan versi runtime serta dependency terkunci (spec 0001).
- Route status development lokal dan proxy frontend, dengan diagnostic serta dokumentasi development tidak tersedia pada komposisi production.
- Ekspor OpenAPI tanpa listener/database, pemeriksaan kontrak, generator SDK standalone, serta pemeriksaan reproduksibilitas dan drift artefak.
- Skenario APP-001 sampai APP-004, gate build/test, dan bukti 78 test lulus dengan review independen Approve. [Laporan bukti fitur 4](docs/testing/0001-application-structure.md) mencatat kandidat, JUnit, riwayat perbaikan, dan batas verifikasi.
- Infrastruktur PostgreSQL 18 development dari image proyek berbasis Oracle Linux 10 dan paket PGDG, dengan volume persisten, autentikasi SCRAM, dan credential administrator terpisah dari runtime aplikasi (spec 0002).
- Suite INFRA-001 sampai INFRA-006 untuk build terkunci, startup, koneksi, persistensi, kegagalan inisialisasi, dan batas secret. [Laporan bukti fitur 3](docs/testing/0002-postgresql-development-infrastructure.md) mencatat hasil 16 test lulus serta batas review dan CI.
- Provisioning PostgreSQL 18 yang membuat role owner, migrator, dan backend terpisah, tiga schema awal, serta metadata migration dengan privilege runtime minimum (spec 0004). [Laporan bukti fitur 5](docs/testing/0003-database-access.md) mencatat verifikasi runtime dan batas review.
- Perintah `db:migrate --apply` dan `db:seed --apply` yang terpisah dari startup aplikasi, dengan baseline metadata, checksum, transaksi, lock, dan penolakan file SQL yang tidak valid (spec 0005).
- Skenario MIG-001 sampai MIG-005 pada PostgreSQL 18 terisolasi, termasuk pengulangan, rollback, persaingan runner, dan batas akses role. [Laporan bukti fitur 6](docs/testing/0004-migration-seed.md) mencatat hasil dan batas verifikasinya.

### Changed

- Proses backend dan worker dari `serve` tidak menerima credential administrator atau migrator dari environment development.
