# Latihan restore topologi rujukan lokal 2026-10-06

Latihan restore pertama menurut *Runbook restore* di [aturan backup](../../rules/backup.md) dan [spec 0013](../../specs/0013-backup-pemulihan-data/index.md) AC-9, pada topologi rujukan `deploy/compose.yaml` dengan image yang dibangun lokal dari checkout kandidat. Semua waktu dalam UTC (waktu lokal UTC+7). Environment ini tidak menyimpan data nyata; latihan ini membuktikan runbook dan alat pada topologi rujukan, bukan kesiapan environment production.

## Identitas

- Environment dan topologi: topologi rujukan `deploy/compose.yaml` satu host Docker, lokal di macOS 27.0 (arm64, Apple Silicon) dengan Docker Desktop (Docker Engine 29.8.0, Docker Compose 5.5.1, mesin container 10 CPU dan 8.319.504.384 byte memory), Bun 1.4.2. Bukan environment yang menyimpan data nyata.
- Tanggal latihan: 2026-10-06, langkah 1 sampai 10 dari 00.00.36 sampai 00.02.38 UTC; project sumber disiapkan 2026-10-05 pukul 23.47.18 sampai 23.47.28 UTC.
- Peran pelaksana: agent Claude Code atas delegasi pemilik operasi, dalam pipeline pengiriman otomatis fitur 14.
- Commit (`git rev-parse HEAD` saat latihan): `ad1dbf24b6605ac2802712c0723fd500475e0159`, yaitu commit induk; seluruh perubahan fitur 14 masih belum masuk commit dan ikut dalam pohon input build di bawah.
- Pohon input build (`sourceTree`, dihitung pukul 23.45.25 sebelum build image dan lagi pukul 00.01.06 sebelum catatan ini ditulis, keduanya sama): `9fab8c8a630ef7bf2df04eeae38a5005efad01a77df21ac3d6bc2fb7bb924754`.
- Project sumber dan project target latihan: sumber `foundation-drill-source-20261006` (pengganti environment sumber, dibuat dengan langkah 2, 3, dan 6 [aturan deployment](../../rules/deployment.md) tanpa seed dan tanpa backend), target `foundation-drill-20261006`.
- ID image (`docker image inspect --format '{{.Id}}' <image>`). Image frontend, backend, dan runner dibangun dengan perintah bagian *Image* aturan deployment dari root checkout, ditambah `--label org.opencontainers.image.revision` (commit di atas) dan `--label foundation.source-tree` (pohon di atas). Image frontend tercatat sebagai bagian kandidat, tetapi edge tidak dijalankan pada latihan lokal.

| Image | Tag | Image ID |
| --- | --- | --- |
| frontend | `foundation-frontend:drill-20261006` | `sha256:801a1c369fe580ef25bf6713d812df33488f9d8cfb2fe3e7125e75c09d097b24` |
| backend | `foundation-backend:drill-20261006` | `sha256:0fd9423fedcdedc845c0f9e134c6e0f2f5c3821e76835791bc1b8e4de95048e9` |
| runner | `foundation-migrate:drill-20261006` | `sha256:b55d172b31a2c90cabd7338205d1dc98c5d164c03a9d6193a988e6c6f6b50c06` |
| PostgreSQL | `foundation-postgres:18-pinned` (PostgreSQL 18.6) | `sha256:4e3191d252746d823525b5aa9d8c23d899ba163f1934c4325ab64ae46bff7da7` |

## Backup yang dipulihkan

- Nama: `foundation-20261005T234726Z-manual`.
- Alasan: `manual` (dibuat operator untuk latihan, bukan oleh penjadwal), lewat `docker compose --env-file <env backup> -f deploy/backup.yaml --profile backup run --rm backup create manual` pada network data project sumber, lalu `check` mencetak `Latest backup: foundation-20261005T234726Z-manual (0 h old)`.
- `createdAt`: `2026-10-05T23:47:26Z`.
- Umur saat restore: 13 menit 17 detik saat langkah 4 mulai (00.00.43 UTC).
- Ukuran (byte): 4.622; manifest mencatat `tocEntries` 12, `durationMs` 59, `serverVersion` dan `pgDumpVersion` 18.6, `compression` `zstd`, dan `globals` `false`.
- Checksum cocok: ya. `shasum -a 256` atas dump di host sama dengan baris file checksum, dan restore melewati langkah 4 *Urutan restore* (baris checksum lalu `sha256sum --check --strict`) di container.
- Hasil pembandingan sha256 dump dengan catatan di luar folder backup: sama (`9d2e334d47e93be0903acaf8a94a59d60418fe5ba547f90cae689ddc2fbb8cbe`). Sumber catatan: file log pengganti penjadwal di luar folder backup, berisi baris `Backup created:` keluaran run `create` beserta waktunya. Penjadwal nyata belum ada di environment ini.
- Asal salinan: folder backup host sumber (folder 0700 di luar checkout dan di luar volume Docker), tanpa salinan di luar host.

## Langkah dan waktu

| Langkah runbook | Mulai | Selesai | Hasil |
| --- | --- | --- | --- |
| 1. Pilih backup dan bandingkan sha256 | 00.00.36 | 00.00.36 | Lulus dalam 75 ms. Backup lengkap terbaru dipilih, dan sha256 dump sama dengan catatan di luar folder backup. |
| 2. Env file target dan PostgreSQL target | 00.00.36 | 00.00.42 | Lulus dalam 5.810 ms. Empat password baru dari `openssl rand -hex 24`, env file target mode 0600 dengan image tag yang sama, dan `up -d --wait postgres` sehat. |
| 3. Provisioning target | 00.00.42 | 00.00.43 | Lulus dalam 992 ms dengan `-e FOUNDATION_BACKUP_PASSWORD`; report baris *Hasil verifikasi*. |
| 4. Restore | 00.00.43 | 00.00.43 | Lulus dalam 432 ms: `Restore completed: foundation-20261005T234726Z-manual.dump`, lewat service `restore` dengan `FOUNDATION_DATA_NETWORK=foundation-drill-20261006_data`. |
| 5. Provisioning ulang | 00.00.43 | 00.00.44 | Lulus dalam 930 ms; seluruh 11 baris report `verified`. |
| 6. Migration | 00.00.44 | 00.00.45 | Lulus dalam 908 ms: `Migrations: 0 applied, 1 skipped`. |
| 7. Fingerprint | 00.00.45 | 00.00.46 | Lulus dalam 952 ms dengan DSN `foundation_backup` target, tanpa `--digest`. |
| 8. Pencabutan seluruh sesi | 00.00.46 | 00.00.46 | Tidak berlaku sampai fitur 15. |
| 9. Backend dan readiness | 00.00.46 | 00.00.53 | Lulus dalam 6.406 ms: `up -d --wait backend`, lalu readiness `200 {"status":"ready"}` pada percobaan pertama. |
| 10. Pemeriksaan isolasi, catatan, dan penutup | 00.00.53 | 00.02.38 | Lulus. Pemeriksaan isolasi keluar 1 dalam 589 ms bersama kontrolnya; pohon input dihitung pukul 00.01.06; catatan ini ditulis; project target dan sumber dihapus (bagian *Pembersihan*). |

## Hasil verifikasi

- Provisioning target (langkah 3): `foundation_owner: created`, `foundation_migrator: created`, `foundation_backend: created`, `foundation_backup: created`, `foundation_migrator membership: created`, `foundation_backup membership: created`, `common: created`, `users: created`, `auth: created`, `common.schema_migrations: created`, dan `database privileges: repaired`. Provisioning ulang (langkah 5): kesebelas baris yang sama dengan `verified`, termasuk `database privileges: verified`.
- Migration: `Skipped: 0001-common-metadata-comment.sql` dan `Migrations: 0 applied, 1 skipped`; migration terakhir `0001-common-metadata-comment.sql`.
- Jumlah baris per tabel dan migration terakhir dari fingerprint target (langkah 7): satu tabel, tanpa sequence, `migrations.count` 1, dan `migrations.last` `0001-common-metadata-comment.sql`. Keluaran fingerprint tanpa `--digest` pada sumber, diambil sesudah backup tanpa penulisan di antaranya, sama byte dengan keluaran target.

| Schema | Tabel | Baris |
| --- | --- | --- |
| `common` | `schema_migrations` | 1 |

- Readiness (`GET /health/ready` dari dalam container backend): `200 {"status":"ready"}`.
- Password lama ditolak: password sumber `foundation_migrator`, `foundation_backend`, dan `foundation_backup` masing masing gagal autentikasi di target (`psql -w` keluar 2 dengan `password authentication failed`). Password sumber `foundation_admin` tidak dipakai di target, karena cluster target dibuat entrypoint dengan password admin baru.
- Pencabutan sesi: tidak berlaku sampai fitur 15.
- Pemeriksaan isolasi network data langkah 10: perintah runbook `--profile backup run --rm --entrypoint bash backup -c 'timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"'` pada `foundation-drill-20261006_data` (`internal: true`) keluar 1 dengan `Network is unreachable`. Kontrol dengan probe yang sama dari image PostgreSQL di network `bridge` bawaan Docker, tanpa folder backup, keluar 0, sehingga kegagalan pada network data berasal dari isolasi, bukan dari probe.
- Pemindaian secret atas keluaran setiap perintah latihan, log waktu, log pengganti penjadwal, manifest, dan file checksum: delapan password latihan (empat sumber, empat target) dan bentuk DSN tidak ditemukan.

## RPO dan RTO terukur

- RPO aktual: 13 menit 17 detik (umur backup saat restore mulai), di bawah 24 jam. Host sumber tidak hilang, jadi batas 25 jam tidak diuji.
- RTO terukur sampai edge target menerima trafik: tidak diukur, karena edge tidak dijalankan pada latihan lokal.
- RTO latihan sampai readiness 200 langkah 9: 16,8 detik (16.761 ms, dari awal langkah 1 pukul 00.00.36 sampai readiness 200 pukul 00.00.53), di bawah 4 jam. Angka ini hanya waktu eksekusi runbook oleh agent pada database dengan satu tabel dan satu baris; RTO environment didominasi respons manusia, ukuran data, dan langkah edge.

## Pembersihan

- Project latihan yang dihapus: nama project dipastikan lewat `docker compose ls` lebih dulu, lalu `docker compose -p foundation-drill-20261006 ... down --volumes` dan `docker compose -p foundation-drill-source-20261006 ... down --volumes`, keduanya keluar 0, pukul 00.02.28 sampai 00.02.29; folder, env file, dan image sementara dihapus sampai 00.02.38.
- Container, network, volume, folder, env file, dan image sementara: sesudah pembersihan tidak ada container, network, atau volume `foundation-drill-*`, dan tidak ada container `foundation-backup-*` dari run Compose `backup.yaml` (semuanya `run --rm`). Folder backup latihan, env file sumber, target, dan backup, log pengganti penjadwal, serta ketiga image `*:drill-20261006` dihapus. Image `foundation-postgres:18-pinned` dipertahankan karena sudah ada sebelum latihan.
- Credential latihan yang dibuang: delapan password latihan hanya disimpan di file mode 0600 di folder sementara di luar checkout, lalu dihapus bersama folder itu.

## Temuan dan tindak lanjut

- Tidak ada langkah yang gagal atau diulang. Penyimpangan dari runbook yang disengaja: env file disimpan di folder sementara di luar checkout, bukan sebagai `.env.deploy` dan `.env.backup` di root; variable TLS env file menunjuk path placeholder yang tidak ada, karena edge tidak dijalankan dan Compose tidak membaca file secret service yang tidak dibuat; image dibangun dengan dua label tambahan untuk pelacakan; dan langkah 1 memakai `shasum -a 256`, karena macOS tidak mempunyai `sha256sum`.
- Topologi rujukan belum mempunyai tabel domain, sehingga data yang dipulihkan hanya `common.schema_migrations` dengan satu baris. Pemulihan data yang lebih kaya (identity, Unicode, bytea, NULL, `jsonb`, dan lainnya) dibuktikan per push oleh BKP-004 di `test:database:real`, bukan oleh latihan ini.
- Docker Desktop macOS menampilkan folder bind mount dengan owner `0:0` dan mengizinkan UID container mana pun menulis, sehingga latihan ini memakai UID dan GID default 26 tanpa `install -o` dan tidak membuktikan syarat owner folder. Tindak lanjut (pemilik operasi): ulangi latihan pada host Linux sebelum penggunaan production pertama.
- Penjadwal, retensi log 35 hari, alert `check`, salinan di luar host, dan enkripsi at rest belum ada di environment ini dan tidak dibuktikan. Tindak lanjut (pemilik operasi, saat platform dipilih): lengkapi kewajiban baris *Penyimpanan*, *Enkripsi*, dan *Pemantauan* aturan backup, lalu catat latihan pada environment itu.
- RTO sampai edge menerima trafik belum terukur. Tindak lanjut (pemilik operasi): latihan pada environment dengan edge dan TLS nyata mengukurnya.
- Perbedaan dari production yang membatasi kesimpulan: satu host macOS arm64 dengan Docker Desktop, bukan Linux; checkout dengan perubahan yang belum masuk commit; tanpa data nyata; tanpa edge dan TLS.
