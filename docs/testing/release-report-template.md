# Template laporan kesiapan release

Salin ke `docs/testing/releases/<identitas-release>.md` untuk kandidat release yang diperiksa. Isi berdasarkan hasil eksekusi, mengikuti [aturan testing](../rules/testing.md). Jangan mengisi hasil lulus tanpa bukti. Template ini bukan laporan pengujian yang sudah dilakukan.

Sumber utama bukti adalah `report.md` dan `report.json` yang ditulis `bun run test:report` untuk run CI kandidat (artifact `gate-report`), bersama bundle bukti ketiga tier (artifact `application-evidence`, `real-evidence`, dan `security-evidence`). Salin identitas kandidat, status pengikatan, tabel skenario, identitas PostgreSQL, ringkasan pemindai dari `security.json`, dan tanda kandidat release dari `report.md` run itu; generator tidak menulis ke `docs/`. Gunakan hanya run yang `report.md` nya menyatakan `Kandidat release: ya`, yaitu gate `passed`, ketiga tier bersih, dan push ke `refs/heads/main` dari satu run serta attempt CI.

## Identitas kandidat

- Release:
- Commit atau identitas build:
- SHA 256 pohon sumber dan status pengikatan (dari `report.md`):
- Run CI, attempt, dan waktu pemeriksaan:
- Tanda kandidat release dan alasannya (dari `report.md`):
- Tautan artifact `gate-report` dan bundle bukti ketiga tier:
- Penanggung jawab:
- Cakupan perubahan dan rujukan specs:
- Status kesiapan (`ready`, `blocked`, atau `incomplete`):

## Environment dan data

| Aspek | Konfigurasi aktual dan perbedaan dari production |
| --- | --- |
| Runtime dan versi dependency penting | |
| PostgreSQL dan migration yang diterapkan | |
| Build serta konfigurasi aplikasi | |
| Jumlah container dan batas CPU/memory | |
| Pool database dan konfigurasi worker | |
| Volume serta kondisi data awal | |
| Browser dan ukuran layar | |
| Mock atau layanan eksternal yang diganti | |

## Kontrak OpenAPI dan SDK

- Identitas atau checksum `openapi.json` untuk kandidat ini:
- Versi plugin OpenAPI Elysia dan generator `@ojiepermana/angular`:
- Run dan hasil ekspor, validasi, serta regenerasi SDK:
- Hasil `api:check`, termasuk reproduksibilitas dan pemeriksaan artefak baru/dihapus:
- Hasil build Angular dengan SDK kandidat:
- ID skenario test kontrak SDK/backend dan tautan bukti:
- Perubahan kontrak atau keterbatasan generator yang belum terselesaikan:

SDK wajib berasal dari OpenAPI kandidat yang sama. Jelaskan hasil identik setelah regenerasi bila kontrak tidak berubah; hasil identik bukan bukti bahwa regenerasi telah dijalankan.

## Keamanan dan schema database

- Schema per domain dan role runtime/migration kandidat:
- Bukti penolakan akses pengguna/role yang tidak berhak:
- Bukti validasi input, sesi/CSRF, limit, serta batas worker/upload yang relevan:
- Hasil pemeriksaan secret/dependency/workflow dari `security.json` (versi dan digest pemindai, cakupan, jumlah temuan per kebijakan, pengecualian yang berlaku atau tidak terpakai) dan temuan yang belum diselesaikan:
- Batas pengujian keamanan dan keputusan risiko yang dinyatakan:
- Bukti backup/restore atau respons insiden bila termasuk cakupan:

## Hasil per skenario

| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |
| --- | --- | --- | --- | --- | --- |

Status skenario menggunakan `passed`, `failed`, `skipped`, `not_run`, `missing_test`, atau `not_applicable`. Jelaskan alasan untuk skenario yang tidak dijalankan atau tidak berlaku. Tabel skenario di `report.md` memakai kolom yang sama dan dapat disalin apa adanya; `not_applicable` tidak dihasilkan generator dan hanya ditulis di sini dengan alasan.

## Hasil performance

| Skenario dan profil | Model beban, durasi, dan beban aktual | Target dari specs | Hasil aktual | Status dan bukti |
| --- | --- | --- | --- | --- |

Catat latency, throughput, tingkat kegagalan, iterasi yang tidak berhasil dimulai, waktu penyelesaian job, dan resource yang relevan. Jika performance tidak termasuk cakupan release, jelaskan alasannya.

## Masalah dan batas bukti

- Skenario wajib yang gagal atau belum mempunyai bukti:
- Test tidak stabil dan riwayat retry:
- Perbedaan environment yang membatasi kesimpulan:
- Perubahan kandidat setelah pengujian dan pemeriksaan ulangnya:
- Tindak lanjut dan penanggung jawab:

## Penilaian kesiapan

Jelaskan status kesiapan dengan merujuk bukti di atas. Kesiapan belum lengkap jika ada skenario wajib tanpa bukti valid. Kegagalan wajib menghalangi status `ready`.

Jika ada pengecualian yang diputuskan, catat ID skenario, alasan, dampak, penanggung jawab, dan keputusan pengguna atau pemilik release. Jangan mengubah status test menjadi lulus untuk menyamarkan pengecualian.
