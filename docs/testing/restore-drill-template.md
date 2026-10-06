# Template latihan restore

Salin ke `docs/testing/restore-drills/<YYYY-MM-DD>-<environment>.md` untuk setiap latihan restore, lalu ganti judulnya menjadi `# Latihan restore <environment> <YYYY-MM-DD>`. Isi dari hasil latihan yang benar benar dijalankan menurut *Runbook restore* di [aturan backup](../rules/backup.md) dan [spec 0013](../specs/0013-backup-pemulihan-data/index.md). Jangan mengisi hasil lulus tanpa bukti. Template ini bukan catatan latihan yang sudah dilakukan.

Latihan wajib untuk setiap environment yang menyimpan data nyata: paling lambat setiap 30 hari, sebelum penggunaan production pertama, dan sesudah perubahan `deploy/backup.yaml`, `deploy/backup/*.sh`, role provisioning, atau pin image PostgreSQL. Laporan release merujuk catatan terbaru environment tujuan di bagian *Backup dan pemulihan* [template laporan release](release-report-template.md).

Catatan tidak memuat password, DSN, nama orang, atau nilai data. Tabel ditulis hanya sebagai jumlah baris, dari fingerprint tanpa `--digest`. Pelaksana ditulis sebagai peran, misalnya pemilik operasi. Waktu ditulis dalam UTC.

## Identitas

- Environment dan topologi (misalnya `deploy/compose.yaml` satu host):
- Tanggal latihan:
- Peran pelaksana:
- Commit (`git rev-parse HEAD` saat latihan; commit induk bila perubahan belum di commit, dicatat apa adanya):
- Pohon input build (`bun -e "import { sourceTree } from './scripts/lib/gate.ts'; console.log(await sourceTree(process.cwd()))"` sebelum catatan ditulis):
- Project sumber dan project target latihan:
- ID image (`docker image inspect --format '{{.Id}}' <image>`):

| Image | Tag | Image ID |
| --- | --- | --- |
| frontend | | |
| backend | | |
| runner | | |
| PostgreSQL | | |

## Backup yang dipulihkan

- Nama:
- Alasan (`scheduled`, `pre-migration`, atau `manual`):
- `createdAt`:
- Umur saat restore:
- Ukuran (byte):
- Checksum cocok (`sha256sum --check --strict`, atau hasil `restore` yang melewati langkah 4 *Urutan restore*):
- Hasil pembandingan sha256 dump dengan catatan di luar folder backup, beserta sumber catatan itu (baris `Backup created:` di log penjadwal, atau metadata versi objek yang terkunci):
- Asal salinan (folder backup host sumber, atau salinan di luar host yang disalin kembali dengan `chown` dan `chmod 0600`):

## Langkah dan waktu

| Langkah runbook | Mulai | Selesai | Hasil |
| --- | --- | --- | --- |
| 1. Pilih backup dan bandingkan sha256 | | | |
| 2. Env file target dan PostgreSQL target | | | |
| 3. Provisioning target | | | |
| 4. Restore | | | |
| 5. Provisioning ulang | | | |
| 6. Migration | | | |
| 7. Fingerprint | | | |
| 8. Pencabutan seluruh sesi | | | |
| 9. Backend dan readiness | | | |
| 10. Pemeriksaan isolasi, catatan, dan penutup | | | |

## Hasil verifikasi

- Provisioning target dan provisioning ulang (baris report):
- Migration (`Migrations: <n> applied, <n> skipped`, migration terakhir):
- Jumlah baris per tabel (schema, tabel, jumlah baris) dan migration terakhir dari fingerprint:

| Schema | Tabel | Baris |
| --- | --- | --- |
| | | |

- Readiness (`GET /health/ready`):
- Password lama ditolak (role yang password sumbernya gagal autentikasi di target):
- Pencabutan sesi langkah 8 (baris `Sessions revoked: <n>` dari `revoke-sessions --all --apply`, lalu run kedua `Sessions revoked: 0`):
- Pemeriksaan isolasi network data langkah 10 (`/dev/tcp`, exit yang diharapkan bukan 0):

## RPO dan RTO terukur

- RPO aktual (umur backup saat restore) dibandingkan dengan 24 jam (25 jam bila host hilang):
- RTO terukur (total waktu dari awal langkah 1 sampai edge target menerima trafik) dibandingkan dengan 4 jam:
- Latihan lokal tanpa edge menulis RTO latihan sampai readiness 200 langkah 9 dan menyebut batas itu:

## Pembersihan

- Project latihan yang dihapus (`docker compose -p <target> ... down --volumes` sesudah nama project dipastikan):
- Container, network, volume, folder, env file, dan image sementara yang dihapus atau dipertahankan:
- Credential latihan yang dibuang:

## Temuan dan tindak lanjut

- Langkah yang gagal, diulang, atau menyimpang dari runbook, beserta alasannya:
- Perbedaan dari environment production yang membatasi kesimpulan:
- Tindak lanjut dan penanggung jawab (peran):
