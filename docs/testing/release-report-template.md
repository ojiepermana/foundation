# Template laporan kesiapan release

Salin ke `docs/testing/releases/<identitas-release>.md` untuk kandidat release yang diperiksa. Isi berdasarkan hasil eksekusi, mengikuti [aturan testing](../rules/testing.md). Jangan mengisi hasil lulus tanpa bukti. Template ini bukan laporan pengujian yang sudah dilakukan.

Sumber utama bukti adalah `report.md` dan `report.json` yang ditulis `bun run test:report` untuk run CI kandidat (artifact `gate-report`), bersama bundle bukti ketiga tier (artifact `application-evidence`, `real-evidence`, dan `security-evidence`). Salin identitas kandidat, status pengikatan, tabel skenario, identitas PostgreSQL, ringkasan pemindai dari `security.json`, dan tanda kandidat release dari `report.md` run itu; generator tidak menulis ke `docs/`. Gunakan hanya run yang `report.md` nya menyatakan `Kandidat release: ya`, yaitu gate `passed`, ketiga tier bersih, dan push ke `refs/heads/main` dari satu run serta attempt CI.

Bukti kapasitas k6 (spec 0011) berasal dari `.local/feature-12/report.md` dan `.local/feature-12/report.json` yang ditulis `bun run test:report:capacity` pada run workflow `capacity.yml` untuk commit yang sama (artifact `capacity-evidence`, berisi juga bundle `.local/feature-11/evidence/capacity/`). Gunakan hanya laporan kapasitas yang menyatakan `Kandidat release: ya`, yaitu status `passed`, tier bersih, dan run `workflow_dispatch` pada `refs/heads/main`. Smoke k6 per push ada di bagian *Performance k6* pada `report.md` per push.

Status kesiapan (spec 0012) dihitung `bun run test:report:release` pada checkout bersih commit kandidat, sesudah keempat artifact (`application-evidence`, `real-evidence`, `security-evidence`, dan `capacity-evidence`) diunduh ke folder bundle menurut prosedur di [aturan deployment](../rules/deployment.md). Salin status, alasan, identitas run per push dan run kapasitas, serta tabel image dari `.local/feature-13/release.md`, dan simpan `.local/feature-13/release.json` sebagai bukti. `grantsDeployment` selalu `false`: status `ready` berarti bukti wajib lengkap dan lulus, tidak memberi izin deploy, dan identitas run berasal dari manifest yang ditulis run itu sendiri tanpa diverifikasi ke GitHub. Keputusan deploy dicatat terpisah oleh pemilik release.

Bukti backup dan pemulihan (spec 0013) berasal dari dua sumber: `.local/feature-14/restore.json` di bundle tier nyata run per push yang sama (artifact `real-evidence`), yang membuktikan backup kandidat dapat dipulihkan dengan data dan riwayat migration yang konsisten pada container lokal, dan catatan latihan restore terbaru environment tujuan di `docs/testing/restore-drills/`, yang ditulis manual dari [template latihan restore](restore-drill-template.md) menurut [aturan backup](../rules/backup.md). `test:report:release` tidak menghitung catatan latihan, jadi salin dan nilai keduanya di bagian *Backup dan pemulihan*.

## Identitas kandidat

- Release:
- Commit atau identitas build:
- SHA 256 pohon sumber dan status pengikatan (dari `report.md`):
- Run CI, attempt, dan waktu pemeriksaan:
- Tanda kandidat release dan alasannya (dari `report.md`):
- Tautan artifact `gate-report` dan bundle bukti ketiga tier:
- Penanggung jawab:
- Cakupan perubahan dan rujukan specs:
- Status kesiapan (`ready`, `blocked`, atau `incomplete`) dan alasannya dari `.local/feature-13/release.md`, dengan `grantsDeployment` `false`:
- Keputusan deploy pemilik release, dicatat terpisah dari status kesiapan:

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
- Bukti backup/restore atau respons insiden bila termasuk cakupan (rincian di bagian *Backup dan pemulihan*):

## Backup dan pemulihan

- `.local/feature-14/restore.json` dari bundle tier nyata run kandidat: `status`, `failures`, `recordedAt`, `serverVersion`, ukuran dan `tocEntries` backup, `restore.durationMs` terhadap batas 300.000 ms, `restore.migrations`, `restore.readinessStatus`, `restore.oldPasswordsRejected`, `fingerprint.equal`, status kedua belas guard, `retention`, dan `secretScan` (jumlah sumber, jumlah nilai, temuan). Salin juga kalimat `boundary` apa adanya:
- Hasil BKP-001 sampai BKP-008 dari tabel skenario `report.md`:
- Catatan latihan restore terbaru environment tujuan (`docs/testing/restore-drills/<YYYY-MM-DD>-<environment>.md`): tanggal dan umur catatan terhadap batas 30 hari, commit dan ID image latihan dibandingkan dengan kandidat, RPO aktual terhadap 24 jam, RTO terukur terhadap 4 jam (atau RTO latihan sampai readiness 200 bila edge tidak dijalankan), hasil pemeriksaan isolasi, dan temuan yang belum selesai:
- Perubahan `deploy/backup.yaml`, `deploy/backup/*.sh`, role provisioning, atau pin image PostgreSQL sejak latihan itu, yang mewajibkan latihan baru sebelum release:
- Kewajiban operasi environment tujuan yang belum terbukti oleh kode: penjadwal dan alert backup serta `check`, salinan di luar host dengan versioning atau object lock, enkripsi at rest, dan log `Backup created:` yang disimpan 35 hari:
- Batas bukti: `restore.json` memakai data fixture pada container lokal, bukan bukti RTO environment, ukuran data nyata, jadwal backup, salinan di luar host, atau enkripsi penyimpanan:

Catatan latihan yang lebih tua dari 30 hari, latihan yang belum dijalankan sesudah perubahan alat backup, atau `restore.json` yang bukan `passed` dicatat sebagai bukti yang belum lengkap, tidak ditulis lulus.

## Hasil per skenario

| ID | Kriteria dan rujukan specs | Test dan profil | Wajib untuk release | Status | Hasil aktual dan tautan bukti |
| --- | --- | --- | --- | --- | --- |

Status skenario menggunakan `passed`, `failed`, `skipped`, `not_run`, `missing_test`, atau `not_applicable`. Jelaskan alasan untuk skenario yang tidak dijalankan atau tidak berlaku. Tabel skenario di `report.md` memakai kolom yang sama dan dapat disalin apa adanya; `not_applicable` tidak dihasilkan generator dan hanya ditulis di sini dengan alasan.

## Hasil performance

| Skenario dan profil | Model beban, durasi, dan beban aktual | Target dari specs | Hasil aktual | Status dan bukti |
| --- | --- | --- | --- | --- |

Catat latency, throughput, tingkat kegagalan, iterasi yang tidak berhasil dimulai, waktu penyelesaian job, dan resource yang relevan. Salin profil smoke dari bagian *Performance k6* `report.md` per push, dan profil load, stress, spike, outage, serta soak dari bagian yang sama pada `.local/feature-12/report.md`, termasuk environment (mesin container) dan batas bukti setiap profil. Jika performance tidak termasuk cakupan release, jelaskan alasannya.

## Masalah dan batas bukti

- Skenario wajib yang gagal atau belum mempunyai bukti:
- Test tidak stabil dan riwayat retry:
- Perbedaan environment yang membatasi kesimpulan:
- Perubahan kandidat setelah pengujian dan pemeriksaan ulangnya:
- Tindak lanjut dan penanggung jawab:

## Penilaian kesiapan

Jelaskan status kesiapan dengan merujuk bukti di atas. Kesiapan belum lengkap jika ada skenario wajib tanpa bukti valid. Kegagalan wajib menghalangi status `ready`. Status yang ditulis di sini sama dengan `status` di `.local/feature-13/release.json`; jangan menaikkannya dengan tangan.

Jika ada pengecualian yang diputuskan, catat ID skenario, alasan, dampak, penanggung jawab, dan keputusan pengguna atau pemilik release. Jangan mengubah status test menjadi lulus untuk menyamarkan pengecualian.
