# Backup dan pemulihan data

Database `foundation` dibackup dengan `pg_dump` format custom dari image PostgreSQL 18 proyek, sebagai job Compose sekali jalan di `deploy/backup.yaml` dengan role baca saja `foundation_backup`, lalu dipulihkan hanya ke target baru yang terisolasi ([spec 0013](../specs/0013-backup-pemulihan-data/index.md)). Aturan ini berlaku bersama [aturan deployment](deployment.md), [aturan keamanan](security.md), [aturan database](database.md), [aturan infrastruktur](infrastructure.md), dan [aturan testing](testing.md).

Kode proyek tidak mengunggah backup ke mana pun, tidak mendorong image, dan tidak melakukan deploy. Salinan di luar host, enkripsi penyimpanan, dan penjadwal adalah tanggung jawab pemilik operasi dan platform; aturan ini menetapkan kewajibannya. Backup yang hanya terbentuk belum membuktikan pemulihan, jadi setiap environment yang menyimpan data nyata menjalankan latihan restore berkala.

## Keputusan operasi

| Hal | Keputusan |
| --- | --- |
| RPO (batas data yang boleh hilang) | Paling lama 24 jam. Backup `scheduled` setiap hari pukul 02.00 UTC, backup `pre-migration` sebelum setiap migration pada database yang sudah berisi data (paling sedikit satu baris di `common.schema_migrations`; deploy pertama tanpa baris itu tidak membutuhkannya), dan backup `manual` sebelum operasi data berisiko. Bila host hilang, RPO paling lama 25 jam, karena salinan di luar host boleh terlambat 1 jam. RPO lebih kecil dari 24 jam membutuhkan arsip WAL (catatan perubahan PostgreSQL) dan spec baru. |
| RTO (batas waktu pemulihan) | Paling lama 4 jam dari keputusan memulihkan sampai edge target baru menerima trafik, mengikuti *Runbook restore* di bawah. Diukur dan dicatat pada setiap latihan. Latihan lokal tanpa edge mencatat RTO latihan sampai readiness 200. |
| Retensi | 35 hari, dengan 7 backup lengkap terbaru selalu disimpan walaupun lebih tua. Penghapusan otomatis hanya berjalan sesudah backup baru berhasil (bagian *Retensi dan check*). Jaminan 7 backup berlaku di folder host. Salinan di luar host menyimpan paling sedikit 7 versi terbaru lewat aturan jumlah versi; bila platform hanya mendukung aturan umur 35 hari, wajib ada alert bila tidak ada objek baru selama 27 jam (ambang `check` ditambah 1 jam keterlambatan salinan), dan penghapusan lifecycle dihentikan selama alert itu aktif. |
| Cakupan | Seluruh database `foundation` tanpa filter schema: `common` (termasuk `common.schema_migrations`), `users`, `auth`, ACL schema `public`, dan schema yang ditambahkan fitur berikutnya. Tidak mencakup role, password role, pengaturan level database atau role, maupun database lain di cluster; semuanya dibuat ulang provisioning. |
| Akses | Hanya pemilik operasi, yaitu pemegang secret setingkat admin (`.env.deploy`), yang membaca, menyalin, dan memulihkan backup. Job terjadwal hanya memegang `.env.backup` (credential `foundation_backup` dan path folder). Role itu tidak dapat menulis, tetapi `.env.backup` setingkat admin untuk kerahasiaan: sesudah `SET ROLE pg_read_all_data`, role backup membaca seluruh data dan verifier password SCRAM semua role di `pg_authid`, termasuk superuser bootstrap. Karena itu setiap role memakai password acak `openssl rand -hex 24`, dan kebocoran `.env.backup` ditangani seperti kebocoran `.env.deploy`. Identitas penyimpanan di luar host: unggah hanya tulis, restore hanya baca, hapus hanya lewat lifecycle. CI dan pengembang tidak pernah menyentuh backup environment; test hanya memakai data fixture di folder sementara. |
| Penyimpanan | Folder host dengan path absolut (path relatif dianggap Compose sebagai nama volume), di luar checkout dan di luar volume Docker, misalnya `/var/backups/foundation/postgres`, dibuat `install -d -m 0700 -o <uid> -g <gid>` dengan UID dan GID container (default 26), sebaiknya di disk lain dari volume `pgsql_data`. File yang disalin kembali dari luar host di `chown <uid>:<gid>` lalu `chmod 0600`. Aturan nilai `.env.deploy` di [aturan deployment](deployment.md) (penggantian `$` oleh Compose dan persen encoding DSN) berlaku untuk `.env.backup`. Environment yang menyimpan data nyata wajib mempunyai salinan di luar host, di failure domain berbeda (host, disk, atau zona), dengan versioning atau object lock, paling lambat 1 jam sesudah backup dibuat. Salinan itu dibuat alat platform; kode proyek tidak mengunggah backup. |
| Enkripsi | Enkripsi at rest wajib pada setiap lokasi penyimpanan (disk terenkripsi atau enkripsi layanan penyimpanan), dan enkripsi transport wajib ke salinan di luar host. Enkripsi sisi client belum dipakai; keputusannya menjadi hook fitur 15 sebelum hash credential dan sesi tersimpan. Checksum SHA 256 hanya mendeteksi kerusakan, bukan keaslian: sebelum restore, operator membandingkan sha256 dump dengan catatan di luar folder backup (langkah 1 *Runbook restore*). |
| Pemantauan | `backup check` sesudah setiap backup terjadwal. Alert bila job backup atau `check` keluar bukan 0, atau bila job tidak berjalan. Ambang `check` 26 jam (RPO ditambah 2 jam toleransi jadwal). Penjadwal menyimpan log nya, termasuk baris `Backup created:`, paling sedikit 35 hari di luar folder backup sebagai catatan sha256 yang independen. |
| Latihan restore | Setiap environment yang menyimpan data nyata: paling lambat setiap 30 hari, sebelum penggunaan production pertama, dan sesudah perubahan `deploy/backup.yaml`, `deploy/backup/*.sh`, role provisioning, atau pin image PostgreSQL. Dicatat dengan `docs/testing/restore-drill-template.md` (bagian *Latihan restore*). |
| Bukti kandidat | Setiap push lewat BKP-003 sampai BKP-007 di `test:database:real` dan `.local/feature-14/restore.json` di bundle tier nyata (bagian *Bukti per push*). |

## Role `foundation_backup`

- Provisioning membuat role login `foundation_backup` hanya bila `FOUNDATION_BACKUP_PASSWORD` diberikan, dengan `NOINHERIT` dan tanpa superuser, `CREATEDB`, `CREATEROLE`, replikasi, maupun `BYPASSRLS`. Role itu mempunyai tepat satu membership, yaitu `pg_read_all_data` dengan `SET TRUE`, `INHERIT FALSE`, dan `ADMIN FALSE`, serta `CONNECT` saja pada database `foundation`. Tanpa variable itu role backup tidak dibuat dan report provisioning sama dengan sebelumnya. Variable yang ada tetapi kosong atau kurang dari 16 karakter selalu gagal `Missing or invalid FOUNDATION_BACKUP_PASSWORD`.
- Tanpa `SET ROLE`, role backup tidak dapat membaca tabel aplikasi. `pg_dump --role=pg_read_all_data` dan `database/fingerprint.ts` berpindah ke `pg_read_all_data` lebih dulu. Sesudah itu role backup membaca seluruh tabel, sequence, dan katalog, termasuk `pg_authid`, tetapi tetap tidak dapat menulis, membuat objek, atau mengambil hak `foundation_owner`.
- Provisioning memverifikasi role ini setiap kali role itu ada dan tidak pernah mengganti password nya; rotasi lewat *Prosedur insiden*. Atribut, membership, atau grant yang menyimpang gagal tanpa perubahan. `CREATE` atau `TEMPORARY` tambahan pada database dan `search_path` yang diubah diperbaiki otomatis dengan report `database privileges: repaired`. Rincian setiap kasus ada di tabel *Kasus provisioning role backup* spec 0013.
- `pg_read_all_data` tidak melewati row level security dan tidak mencakup large object. Fitur yang menyalakan row level security atau memakai large object wajib mengamandemen spec 0013 lebih dulu; tanpa itu backup gagal `row level security` dan fingerprint gagal `Fingerprint failed`. `BYPASSRLS` pada `foundation_backup` tidak berpengaruh, karena role efektifnya `pg_read_all_data`.
- Credential backup tidak pernah diberikan ke backend, worker, edge, atau runner migration. Role worker kelak tidak boleh menjadi anggota `pg_read_all_data`.

## Menyiapkan backup

Jalankan dari root checkout pada host sumber. Setiap langkah harus keluar 0 sebelum langkah berikutnya.

1. Provisioning dengan `-e FOUNDATION_BACKUP_PASSWORD` seperti langkah 3 [aturan deployment](deployment.md), dengan password baru dari `openssl rand -hex 24`. Pada database yang sudah diprovision, ulangi perintah itu dengan variable tambahan: role backup dibuat, role lain diverifikasi, dan report memuat `foundation_backup: created`, `foundation_backup membership: created`, dan `database privileges: repaired` karena `CONNECT` baru diberikan.
2. Buat folder backup dengan owner UID dan GID container (default 26, user `postgres` image):

   ```sh
   sudo install -d -m 0700 -o 26 -g 26 /var/backups/foundation/postgres
   ```

3. Salin `.env.backup.example` ke `.env.backup`, beri mode 0600, lalu isi `FOUNDATION_BACKUP_DATABASE_URL` dalam bentuk URI (`postgres://foundation_backup:<password>@postgres:5432/foundation`, password hanya di userinfo dan karakter cadangan di persen encoding), `FOUNDATION_BACKUP_DIR` (path absolut folder langkah 2), dan `FOUNDATION_DATA_NETWORK` (`foundation-deploy_data`, network data project sumber, hanya untuk job backup). `FOUNDATION_RESTORE_DATA_NETWORK` tidak pernah ditulis ke file ini. Variable opsional yang kosong memakai default: image `foundation-postgres:18-pinned`, serta UID dan GID 26. Bila folder dimiliki user lain, isi `FOUNDATION_BACKUP_UID` dan `FOUNDATION_BACKUP_GID` dengan UID dan GID pemilik folder itu. File asli diabaikan Git lewat pola `.env.*`.
4. Buat backup pertama, lalu periksa:

   ```sh
   docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup create manual
   docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup check
   ```

`create` mencetak tepat satu baris `Backup created: <nama>.dump (<ukuran> bytes, sha256 <heksadesimal>)` dan meninggalkan tiga file mode 0600: dump `<nama>.dump`, file checksum `<nama>.dump.sha256`, dan manifest `<nama>.json`. `<nama>` adalah `foundation-<YYYYMMDD>T<HHMMSS>Z-<alasan>` dalam UTC, dan alasan hanya `scheduled`, `pre-migration`, atau `manual`. Manifest adalah catatan operator dan penanda backup lengkap; restore tidak membaca isinya, karena manifest tidak dilindungi checksum. `check` mencetak `Latest backup: <nama> (<jam> h old)`.

Container backup dan restore berjalan dengan UID container, tanpa capability, dengan root filesystem read only, dan hanya di network data project yang `internal: true`, sehingga tidak mempunyai jalur ke internet. Hanya restore yang menerima DSN admin, dan hanya lewat `-e` dari shell. Job backup memeriksa role login dengan `SELECT session_user` sebelum `pg_dump`, dan DSN role selain `foundation_backup`, termasuk superuser, gagal `Backup failed: permission denied`.

Password DSN tidak pernah masuk argumen proses, yang terbaca setiap pengguna host lewat `/proc/<pid>/cmdline`. Kedua script memisahkan password dari DSN URI ke `PGPASSWORD` di environment alat PostgreSQL, yang hanya terbaca UID yang sama dan root, dan memberi `--dbname` URI tanpa password. Karena itu DSN wajib bentuk URI `postgres://` atau `postgresql://` dengan password di userinfo. Bentuk `host=... password=...`, password dengan spasi atau persen encoding yang tidak sah, dan parameter query `password` gagal `invalid connection string` sebelum alat apa pun berjalan.

## Jadwal dan pemantauan

Jalankan backup `scheduled` setiap hari pukul 02.00 UTC, lalu `check`, lewat penjadwal pilihan operator (systemd timer, cron, atau job terjadwal platform) dengan user yang dapat membaca `.env.backup` dan menjalankan Docker:

```sh
docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup create scheduled
docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup check
```

Contoh systemd. Service `oneshot` menjalankan `ExecStart` berurutan dan berhenti pada perintah pertama yang gagal, dan systemd tidak memulai service yang sama selagi run sebelumnya masih berjalan:

```ini
# /etc/systemd/system/foundation-backup.service
[Unit]
OnFailure=<unit alert Anda>

[Service]
Type=oneshot
WorkingDirectory=<root checkout>
ExecStart=/usr/bin/docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup create scheduled
ExecStart=/usr/bin/docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup check

# /etc/systemd/system/foundation-backup.timer
[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- Alert bila job atau `check` keluar bukan 0, dan bila job tidak berjalan (misalnya pemantau terpisah yang memeriksa waktu run sukses terakhir). Ambang `check` adalah 26 jam.
- Simpan log penjadwal, termasuk baris `Backup created:`, paling sedikit 35 hari di luar folder backup dan di luar identitas unggah, misalnya journal dengan retensi itu. Baris ini adalah catatan sha256 independen untuk langkah 1 *Runbook restore*.
- Jangan menjalankan run yang tumpang tindih. Nama memakai detik dan file sementara per nama, tetapi tidak ada lock.
- Salinan di luar host dibuat alat platform paling lambat 1 jam sesudah backup, menurut baris *Penyimpanan* dan *Retensi*.

## Backup sebelum migration

Sebelum setiap migration pada database yang sudah berisi data (paling sedikit satu baris di `common.schema_migrations`), buat backup `pre-migration` lalu periksa, sebelum langkah 6 [aturan deployment](deployment.md):

```sh
docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup create pre-migration
docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm backup check
```

Deploy pertama, sebelum migration pertama, belum mempunyai baris itu dan tidak membutuhkan backup ini. Buat backup `manual` dengan bentuk perintah yang sama sebelum operasi data berisiko lain.

## Retensi dan check

Retensi berjalan di dalam `create`, hanya sesudah backup baru lengkap, dengan waktu dari `date -u` container:

1. Hanya entri langsung di folder backup yang berupa file biasa yang dibaca. Subfolder, symlink, dan file yang namanya tidak cocok pola backup tidak pernah disentuh.
2. Backup lengkap adalah nama yang ketiga file nya ada sebagai file biasa. Tujuh backup lengkap terbaru (urutan nama, yaitu stempel waktu) selalu disimpan.
3. Backup lengkap lain yang umurnya lebih dari 35 hari dihapus, berurutan manifest, checksum, lalu dump, dengan satu baris `Backup removed: <nama>` per backup.
4. File sisa, yaitu set yang tidak lengkap dan file `.partial` dari run yang terputus, dihapus bila umurnya lebih dari 24 jam, dengan satu baris `Leftover removed: <file>` per file, sesudah semua baris `Backup removed`. Hanya `.partial` yang seluruh namanya ditulis `create` (`.<nama backup>.dump.partial`, `.dump.sha256.partial`, atau `.json.partial`) yang dihapus. Nama `.foundation-*.partial` lain tidak pernah disentuh atau dicetak, sehingga nama berisi baris baru tidak dapat menyisipkan baris `Backup created:` palsu ke log penjadwal.
5. Kegagalan penghapusan mana pun menghentikan retensi dengan `Retention failed` dan exit 1. Backup baru tetap lengkap.

Umur backup dihitung dari stempel nama, bukan dari waktu file, kecuali file `.partial` yang memakai waktu ubahnya. File yang namanya cocok pola backup tetapi stempelnya bukan tanggal yang sah membuat retensi gagal `Retention failed` dan `check` gagal `Backup failed: internal`. Hapus atau ganti nama file itu, lalu jalankan `create manual` dan `check` lagi.

`check` memeriksa folder (`Backup directory unavailable` atau `Backup directory must be mode 0700`), lalu backup lengkap terbaru (`No backup found` bila tidak ada). Checksum diperiksa lebih dulu dari umur (`Backup checksum mismatch: <nama>`, juga bila backup itu sekaligus terlalu tua). Backup lulus bila umurnya paling lama 26 jam (93.600 detik, inklusif) dengan `Latest backup: <nama> (<jam> h old)`, dan gagal dengan `Latest backup too old: <nama> (<jam> h old)`. `<jam>` dibulatkan ke bawah.

## Pesan dan kode keluar

Script hanya mencetak pesan kategori tetap. Keluaran mentah `pg_dump`, `pg_restore`, dan `psql` ditangkap ke file di `/tmp` container lalu hanya dipetakan ke kategori, karena libpq mencetak ulang potongan password pada connection string yang rusak. Kegagalan selalu keluar 1 dengan tepat satu baris di stderr, tidak meninggalkan file yang dibuat run itu, tidak menyentuh file yang sudah ada, dan tidak menjalankan retensi.

| Pesan | Arti |
| --- | --- |
| `Usage: foundation-backup.sh create <scheduled\|pre-migration\|manual> \| check`, `Usage: foundation-restore.sh <name>.dump` | Argumen salah. Service `restore` tanpa argumen mencetak pemakaian. |
| `Missing FOUNDATION_BACKUP_DATABASE_URL` | `.env.backup` tanpa DSN backup. |
| `Backup directory unavailable`, `Backup directory must be mode 0700` | Folder backup tidak ada, bukan folder, tidak dapat dibaca atau ditulis UID container, atau modenya bukan 0700. |
| `Backup already exists: <nama>` | Salah satu file untuk nama itu sudah ada; run berhenti sebelum membuat file apa pun. |
| `Backup failed: <kategori>`, `Restore failed: <kategori>` | Kategori dalam urutan: `invalid connection string`, `connection`, `row level security`, `lock timeout`, `permission denied`, `time limit`, `killed`, `archive invalid` dan `wrong database` (backup saja), `interrupted`, `internal`, lalu `pg_dump` atau `pg_restore` untuk sisanya. Arti dan langkahnya ada di *Prosedur insiden*. |
| `Retention failed` | Retensi gagal sesudah baris `Backup created`; backup baru tetap lengkap. |

- `docker stop` pada container backup atau restore yang sedang berjalan berakhir dengan exit 130, karena image PostgreSQL proyek memakai `STOPSIGNAL SIGINT`. TERM yang dikirim langsung ke proses memberi exit 143. Keduanya mencetak `Backup failed: interrupted` atau `Restore failed: interrupted` sesudah proses anak dihentikan dan file run dihapus.
- Exit 137 tanpa baris kategori berarti container dihentikan paksa, misalnya batas memori, atau `stop_grace_period` 30 detik habis. Sinyal yang tiba saat `sha256sum` memeriksa dump yang sangat besar baru ditangani sesudah `sha256sum` selesai, sehingga `docker stop` dapat berakhir dengan exit 137.

## Runbook restore

Restore selalu masuk ke project Compose baru yang terisolasi, tidak pernah ke database yang berisi data. Project target bernama misalnya `foundation-drill-20261006` untuk latihan, atau `foundation-deploy-20261006` untuk pemulihan. Jalankan dari root checkout kandidat yang image nya dipakai target. Setiap langkah harus keluar 0 sebelum langkah berikutnya, dan waktu mulai serta selesai setiap langkah dicatat.

1. Pilih backup lengkap: yang terbaru, atau yang terakhir sebelum kerusakan. Bandingkan sha256 dump dengan catatan yang disimpan di luar folder backup dan di luar identitas unggah, yaitu baris `Backup created:` di log penjadwal atau metadata versi objek yang terkunci. Contoh di host Linux:

   ```sh
   sha256sum /var/backups/foundation/postgres/<nama>.dump
   journalctl -u foundation-backup.service --since -36d | grep -F 'Backup created: <nama>.dump'
   ```

   Bila berbeda atau tidak ada catatan, archive tidak dipercaya dan backup lain dipilih, karena checksum di samping dump hanya mendeteksi kerusakan dan `pg_restore` berjalan sebagai superuser. Bila host sumber hilang, salin ketiga file dari penyimpanan di luar host ke folder backup host target (dibuat `install -d -m 0700 -o <uid> -g <gid>`), lalu `chown <uid>:<gid>` dan `chmod 0600` ketiganya. File milik UID lain tidak terbaca container dan tampil sebagai `Backup checksum mismatch`.
2. Buat empat password baru dengan `openssl rand -hex 24` untuk admin, migrator, backend, dan backup. Siapkan env file target dari salinan `.env.deploy` dengan password admin serta DSN migrator dan backend yang baru, dan image tag kandidat yang sama; simpan password backup baru di secret manager untuk langkah 3 dan 7. Lalu jalankan PostgreSQL target:

   ```sh
   docker compose -p <target> --env-file <env target> -f deploy/compose.yaml up -d --wait postgres
   ```

3. Provisioning target dengan password baru, termasuk `-e FOUNDATION_BACKUP_PASSWORD`, memakai perintah provisioning [aturan deployment](deployment.md) dengan `-p <target>`. `FOUNDATION_ADMIN_DATABASE_URL` di shell menunjuk `postgres://foundation_admin:<password admin baru>@postgres:5432/foundation`:

   ```sh
   docker compose -p <target> --env-file <env target> -f deploy/compose.yaml --profile migrate run --rm \
     -e FOUNDATION_ADMIN_DATABASE_URL -e FOUNDATION_MIGRATOR_PASSWORD -e FOUNDATION_BACKEND_PASSWORD -e FOUNDATION_BACKUP_PASSWORD \
     migrate database/provision.ts --apply
   ```

4. Restore dengan DSN admin target dan network data target di shell. Container restore hanya bergabung dengan network yang dinamai `FOUNDATION_RESTORE_DATA_NETWORK`, sehingga tidak dapat menjangkau database sumber. Variable itu tidak pernah ada di `.env.backup`; tanpa variable itu Compose berhenti dengan `network  declared as external, but could not be found` sebelum container dibuat:

   ```sh
   FOUNDATION_RESTORE_DATA_NETWORK=<target>_data docker compose --env-file .env.backup -f deploy/backup.yaml --profile restore run --rm -e FOUNDATION_ADMIN_DATABASE_URL restore <nama>.dump
   ```

   Hasilnya `Restore completed: <nama>.dump`. Restore menolak, tanpa mengubah target, nama yang tidak sah (`Invalid backup name`), DSN admin yang tidak ada (`Missing FOUNDATION_ADMIN_DATABASE_URL`), backup tidak lengkap (`Backup incomplete: <nama>`), checksum yang tidak cocok atau menamai file lain (`Backup checksum mismatch: <nama>`), archive yang tidak sah (`Backup archive invalid: <nama>`), target yang tidak terjangkau (`Restore target unavailable`), identitas selain `foundation_admin` di database `foundation` (`Invalid restore target`), major PostgreSQL yang berbeda (`Backup major version mismatch`), target yang belum diprovision (`Restore target not provisioned`), dan target yang tidak kosong (`Restore target not empty`). `pg_restore` berjalan dalam satu transaksi, sehingga kegagalan (`Restore failed: pg_restore`) mengembalikan target ke keadaan diprovision kosong.
5. Provisioning ulang dengan perintah langkah 3. Hasilnya harus `verified`, atau `repaired` hanya untuk privilege yang diperbaiki otomatis menurut matriks spec 0004 dan tabel *Kasus provisioning role backup* spec 0013. Kegagalan drift berarti archive membawa grant yang tidak dikenal, dan target tidak dipakai.
6. Migration:

   ```sh
   docker compose -p <target> --env-file <env target> -f deploy/compose.yaml --profile migrate run --rm migrate database/migrate.ts --apply
   ```

   Hasilnya `0 applied` bila backup berasal dari versi skema kandidat, atau migration tertunda diterapkan bila backup lebih lama. `Migration history drift` berarti backup berasal dari kandidat yang lebih baru atau menyimpang: hentikan, lalu pakai image kandidat yang cocok.
7. Fingerprint dengan DSN `foundation_backup` target (password baru langkah 3) di shell, `FOUNDATION_BACKUP_DATABASE_URL=postgres://foundation_backup:<password backup baru>@postgres:5432/foundation`:

   ```sh
   docker compose -p <target> --env-file <env target> -f deploy/compose.yaml --profile migrate run --rm -e FOUNDATION_BACKUP_DATABASE_URL migrate database/fingerprint.ts
   ```

   Catat jumlah baris per tabel dan migration terakhir dari satu baris JSON keluarannya. Mode `--digest` hanya untuk test, sehingga catatan tidak menyimpan digest data. Fingerprint yang menunggu lock lebih dari 30 detik (`lock_timeout`), misalnya karena migration masih berjalan, berakhir `Fingerprint failed`; ulangi sesudah lock itu lepas.
8. Pencabutan seluruh sesi: tidak berlaku sampai fitur 15 (*Hook fitur 15*).
9. Jalankan backend, lalu baca readiness seperti langkah 5 [aturan deployment](deployment.md) sampai `200 {"status":"ready"}`:

   ```sh
   docker compose -p <target> --env-file <env target> -f deploy/compose.yaml up -d --wait backend
   docker compose -p <target> --env-file <env target> -f deploy/compose.yaml exec -T backend \
     bun --no-env-file -e "fetch('http://127.0.0.1:8888/health/ready').then(async (r) => console.log(r.status, await r.text()))"
   ```

10. Penutup.
    - Latihan: jalankan pemeriksaan isolasi pada network data target yang `internal: true`. Perintah ini wajib keluar bukan 0:

      ```sh
      FOUNDATION_DATA_NETWORK=<target>_data docker compose --env-file .env.backup -f deploy/backup.yaml --profile backup run --rm --entrypoint bash backup -c 'timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443"'
      ```

      Hitung pohon input build sebelum menulis catatan (bagian *Latihan restore*), tulis catatan latihan dengan RTO latihan sampai readiness 200 langkah 9, karena edge tidak dijalankan pada latihan lokal, lalu hapus project latihan sesudah memastikan namanya lewat `docker compose ls`: `docker compose -p <target> --env-file <env target> -f deploy/compose.yaml down --volumes`.
    - Pemulihan: hentikan edge project lama (`docker compose --env-file .env.deploy -f deploy/compose.yaml stop edge`), jalankan `docker compose -p <target> --env-file <env target> -f deploy/compose.yaml up -d --wait edge`, lalu periksa `https://<host>/`. Biarkan project lama berhenti tanpa menghapus volume sampai insiden ditutup. Perbarui `.env.backup` (`FOUNDATION_DATA_NETWORK=<target>_data` dan DSN backup baru), lalu jalankan `create manual` sebagai titik awal baru. Env file target menjadi `.env.deploy` yang berlaku.

## Prosedur insiden

| Insiden | Langkah |
| --- | --- |
| Kehilangan atau kerusakan data | Hentikan penulisan (stop edge dan backend), pertahankan project lama untuk penyelidikan, lalu pulihkan backup baik terakhir lewat *Runbook restore* ke project baru. Credential database otomatis berganti karena provisioning memakai password baru. Cabut seluruh sesi (tidak berlaku sampai fitur 15), pindahkan trafik, lalu tulis postmortem lewat `/document postmortem`. |
| Credential bocor atau dicurigai | Rotasi password keempat role, yaitu `foundation_backend`, `foundation_migrator`, dan `foundation_backup` lewat `ALTER ROLE <role> PASSWORD` dengan koneksi admin, lalu `foundation_admin`, dengan password baru `openssl rand -hex 24` (bagian *Rotasi password role* [aturan deployment](deployment.md); `\password <role>` di psql mengirim password yang sudah di hash). `.env.backup` yang bocor diperlakukan sama dengan `.env.deploy` yang bocor, karena role backup dapat membaca seluruh data dan verifier password semua role di `pg_authid`. Perbarui `.env.deploy` dan `.env.backup`, buat ulang backend, ganti sertifikat dan key TLS bila host edge terdampak, rotasi identitas penyimpanan di luar host, dan cabut seluruh sesi (tidak berlaku sampai fitur 15). |
| Backup bocor | Anggap seluruh isi backup terbuka: lakukan langkah credential bocor, dan catat data yang terdampak. Sesudah fitur 15, terapkan keputusan reset password paksa untuk hash yang ikut bocor. |
| Backup gagal atau `check` gagal | Perbaiki penyebab menurut kategori pesan, jalankan `create manual`, lalu `check`. `connection` atau `invalid connection string` berarti DSN, password, atau network di `.env.backup` salah. `row level security` berarti sebuah migration menyalakan row level security tanpa amandemen spec 0013: batalkan perubahan itu atau amandemen model akses lebih dulu; `BYPASSRLS` pada `foundation_backup` tidak berpengaruh selama backup berjalan sebagai `pg_read_all_data`. `lock timeout` berarti lock lain menahan tabel lebih dari 30 detik. `permission denied` berarti DSN memakai role lain atau membership role backup berubah: periksa `.env.backup` dan jalankan provisioning. `wrong database` berarti DSN menunjuk database selain `foundation`. `time limit` berarti `pg_dump` melewati 3.600 detik, dan exit container 137 tanpa baris kategori berarti container dihentikan paksa, misalnya batas memori. `No backup found` atau `Latest backup too old` berarti job tidak berjalan atau gagal; `Backup checksum mismatch` berarti backup terbaru rusak atau terbaca dengan UID lain. |

## Hook fitur 15

Kontrak yang wajib diisi fitur 15 sebelum spec nya `Accepted`:

1. Perintah pencabutan seluruh sesi di `auth` yang aman diulang, berjalan sebagai job image runner tanpa backend, dengan role yang diputuskan spec fitur 15, dan dipakai langkah 8 *Runbook restore* serta *Prosedur insiden*.
2. Skenario baru di `tests/scenarios/backup.json` yang membuktikan sesi yang dibuat sebelum backup ditolak backend sesudah restore dan pencabutan.
3. Keputusan apakah tabel sesi ikut backup (rekomendasi: ikut, lalu dicabut saat restore), dan apakah hash password yang ikut bocor memicu reset paksa.
4. Keputusan enkripsi sisi client dan keaslian backup (tanda tangan, atau enkripsi terautentikasi yang diverifikasi sebelum `pg_restore`) sebagai prasyarat sebelum hash credential atau sesi tersimpan. Sampai itu, keaslian bergantung pada pembandingan sha256 langkah 1 *Runbook restore*, risiko yang diterima.
5. Bila fitur itu menyalakan row level security: `BYPASSRLS` pada `foundation_backup` tidak berpengaruh, karena dump dan fingerprint berjalan sesudah `SET ROLE pg_read_all_data` dan role efektif itu tidak mempunyai `BYPASSRLS`. Menyalakan RLS membutuhkan amandemen spec 0013 yang mengubah model akses, misalnya akses baca lewat `INHERIT` dengan `BYPASSRLS` pada role login, dengan argumen `pg_dump`, peralihan role fingerprint, dan matriks role backup diubah bersama.

Sampai kontrak ini terisi, langkah 8 runbook dan pencabutan sesi pada prosedur insiden tertulis `tidak berlaku sampai fitur 15`.

## Latihan restore

Latihan menjalankan *Runbook restore* ke project latihan, lalu menulis catatan dari template `docs/testing/restore-drill-template.md` ke `docs/testing/restore-drills/<YYYY-MM-DD>-<environment>.md`. Latihan wajib untuk setiap environment yang menyimpan data nyata: paling lambat setiap 30 hari, sebelum penggunaan production pertama, dan sesudah perubahan `deploy/backup.yaml`, `deploy/backup/*.sh`, role provisioning, atau pin image PostgreSQL. Laporan release merujuk catatan terbaru environment tujuan.

| Isi catatan | Sumber |
| --- | --- |
| Commit | `git rev-parse HEAD` saat latihan; commit induk bila perubahan belum di commit, dicatat apa adanya |
| Pohon input build | `bun -e "import { sourceTree } from './scripts/lib/gate.ts'; console.log(await sourceTree(process.cwd()))"` di root checkout sebelum catatan ditulis, sehingga catatan itu sendiri tidak ikut terhitung |
| ID keempat image | `docker image inspect --format '{{.Id}}' <image>` untuk image frontend, backend, runner, dan PostgreSQL yang dipakai project latihan |
| Backup | Nama, alasan, `createdAt`, ukuran, checksum cocok, dan hasil pembandingan sha256 dengan catatan di luar folder backup beserta sumber catatan itu |
| Hasil | Jumlah baris per tabel dan migration terakhir dari fingerprint tanpa `--digest`, hasil provisioning, migration, dan readiness, password lama yang ditolak, dan hasil pemeriksaan isolasi `/dev/tcp` langkah 10 |
| RPO dan RTO | Umur backup saat restore sebagai RPO aktual, total waktu langkah 1 sampai 9 sebagai RTO terukur, dibandingkan dengan 24 jam dan 4 jam |

Catatan tidak memuat password, DSN, nama orang, atau nilai data; hanya jumlah baris. Docker Desktop macOS menampilkan folder bind mount di container dengan owner `0:0` dan mengizinkan UID container mana pun menulis ke folder 0700 milik pengguna host (probe 2026-10-06), sehingga latihan di sana tidak membuktikan syarat owner UID dan GID. Syarat itu berlaku dan diperiksa pada host Linux.

## Bukti per push

`bun run test:database:real` menjalankan `tests/integration/database/backup.test.ts` (BKP-003 sampai BKP-007) pada dua cluster PostgreSQL 18 milik run: backup lewat service Compose `backup`, restore lewat service `restore` ke target yang diprovision dengan password baru, provisioning ulang, runner migration, `database/fingerprint.ts --digest`, readiness `createApp('production')`, setiap penolakan restore, kegagalan backup dengan komponen nyata, retensi, dan `check`. Hasilnya `.local/feature-14/restore.json` yang wajib berstatus `passed` dan ikut bundle tier nyata. BKP-001 di `test:deployment:plan` memeriksa bentuk statis `deploy/backup.yaml`, kedua script, dan string wajib dokumen ini; BKP-002 memeriksa provisioning role backup; BKP-008 memeriksa bahwa `serve` tidak meneruskan credential backup. Registry nya `tests/scenarios/backup.json`.

Bukti itu memakai data fixture pada container lokal, bukan bukti RTO environment, ukuran data nyata, jadwal backup, salinan di luar host, atau enkripsi penyimpanan. Hal itu dibuktikan lewat latihan restore dan platform.

## Batas

- RPO di bawah 24 jam memerlukan arsip WAL dan spec baru.
- Backup logis bergantung pada major PostgreSQL yang sama. Upgrade major memerlukan prosedur terpisah, dan restore menolak major yang berbeda.
- `pg_restore --single-transaction` menahan lock setiap objek; database dengan ribuan objek dapat membutuhkan `max_locks_per_transaction` lebih besar.
- Restore menjalankan isi archive sebagai superuser bootstrap. Sampai hook fitur 15 butir 4, keaslian archive hanya dijaga pembandingan sha256 dengan catatan terpisah.
- Data yang dihapus pengguna masih ada di backup sampai 35 hari. Catat hal itu untuk kebutuhan hukum produk saat fitur pengguna menyimpan data pribadi.
- Pada topologi satu host, akses Docker setara root dan dapat membaca environment container lain, sehingga pemisahan `.env.backup` dari `.env.deploy` nyata terutama saat job berjalan dengan identitasnya sendiri di platform.
- Password DSN ada di environment container dan alat PostgreSQL, yang terbaca UID yang sama dan root, tetapi tidak di argumen proses. User, host, dan database DSN tetap terlihat di argumen proses `psql`, `pg_dump`, dan `pg_restore`.

## Tanggung jawab agent dan verifikasi

Agent yang mengubah `deploy/backup.yaml`, `deploy/backup/*.sh`, `database/fingerprint.ts`, role `foundation_backup` di `database/provision.ts`, atau suite backup membaca aturan ini dan spec 0013, lalu menjalankan `bun run test:deployment:plan` dan `bun run test:database:real`. Nilai sasaran, retensi, ambang, atau batas waktu hanya berubah lewat pembaruan spec 0013 dengan alasan tertulis. Perubahan pada file itu, role provisioning, atau pin image PostgreSQL mewajibkan latihan restore baru pada setiap environment yang menyimpan data nyata.

Pembersihan manual sesudah `backup.test.ts` terhenti tanpa pembersihan, misalnya karena SIGKILL: daftar container dengan `docker ps -a --filter name=foundation-backup-` dan network dengan `docker network ls --filter name=foundation-backup-`, tinjau, lalu hapus dengan nama eksplisit (`docker rm -f foundation-backup-src-<hex>`, lalu `docker network rm foundation-backup-src-<hex>`). Folder `foundation-backup-test-*` milik run yang sama di `TMPDIR` dapat dihapus sesudahnya.
