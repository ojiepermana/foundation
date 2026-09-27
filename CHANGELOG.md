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
