# Rationale: Backup dan pemulihan data

## Context

> Catatan premis: pemilik belum memilih platform, penyedia penyimpanan, maupun penjadwal, dan tugas ini melarang mengunggah backup ke layanan mana pun. Karena itu fitur ini tidak dapat membuktikan salinan di luar host, enkripsi penyimpanan, atau jadwal pada environment nyata. Yang dapat dibuktikan adalah alat backup dan restore, kontrak operasi (sasaran, retensi, akses, langkah), dan pemulihan yang konsisten pada container lokal, ditambah satu latihan pada topologi rujukan spec 0012. Bagian yang bergantung pada platform ditulis sebagai kewajiban operasi dan tindak lanjut, bukan diklaim terbukti. Topik ini memuat beberapa keputusan (sasaran, metode, credential, penyimpanan, bukti), tetapi semuanya terikat pada satu alur backup lalu restore yang dibuktikan bersama, sehingga ditulis dalam satu spec seperti spec 0010 sampai 0012, bukan umbrella.

Fitur 14 pada scope meminta data dapat dikembalikan ketika terjadi kegagalan atau insiden, dengan catatan bahwa backup yang terbentuk saja belum membuktikan pemulihan. Selesai ketika: sasaran kehilangan data dan waktu pemulihan, retensi, akses, serta penyimpanan diputuskan; restore ke target terisolasi membuktikan data dan migration konsisten; secret disaring; prosedur insiden mencakup rotasi credential serta pencabutan sesi ketika auth tersedia; bukti restore dicatat pada kandidat dan environment terkait. Datanya adalah schema yang benar benar dipakai, awalnya `common` serta domain yang sudah dibangun, dan metadata backup baru memerlukan keputusan schema sebelum implementasi.

Keadaan saat ini (dibaca dari kode dan probe pada 2026-10-06):

- Hanya `common.schema_migrations` yang berisi data (satu baris dari migration `0001-common-metadata-comment.sql`); schema `users` dan `auth` kosong (spec 0004, 0005).
- Role `foundation_owner` (NOLOGIN, pemilik semua objek), `foundation_migrator` (masuk owner lewat `SET ROLE`), dan `foundation_backend` (baca metadata saja) dibuat `database/provision.ts` dalam satu transaksi dengan advisory lock. Semua role `NOREPLICATION` dan `NOBYPASSRLS`. Provisioning memeriksa daftar grantee yang dikenal pada ACL database, schema, dan metadata, dan gagal bila ada grantee lain.
- Runner `database/runner.ts` memverifikasi identitas migrator, bentuk role, metadata, privilege, dan riwayat (`name` dan `checksum` setiap baris harus sama dengan file berurutan), lalu menerapkan migration tertunda. Fungsi `runDatabaseCommand(kind, sql, root)` menerima root lain.
- Image `foundation-postgres:18-pinned` (spec 0002) memuat `pg_dump`, `pg_restore`, `pg_dumpall`, `psql`, dan `pg_basebackup` 18.6 yang dibangun dengan zstd, serta `sha256sum`, `date`, `stat`, dan `timeout` GNU. Cluster memakai `scram-sha-256` untuk semua koneksi dan data checksums aktif.
- Topologi rujukan `deploy/compose.yaml` (spec 0012) menaruh PostgreSQL di network `data` yang `internal: true` dengan volume `pgsql_data`; `.env.deploy` memuat password admin bersama DSN runtime (risiko yang diterima spec 0012). Tabel *Topologi* spec 0012 menetapkan tepat empat service dan dikunci DEP-001 serta DEP-005.
- Suite `tests/integration/database/` dijalankan `test:database:real` di tier nyata per push, dengan password turunan seed yang dipindai orkestrasi dan pembersihan sinyal lewat `tests/orchestration/signal-cleanup.ts` yang diperiksa GATE-009.

Kekuatan yang membatasi keputusan: aturan keamanan meminta "backup yang dapat dipulihkan dan langkah pencabutan secret atau sesi ketika insiden terjadi", credential dan privilege minimum per tugas, secret terpisah per layanan, dan tidak ada credential pada artefak atau log. Aturan database meminta role terpisah dan tidak ada schema baru tanpa keputusan. Aturan testing meminta bukti dengan komponen nyata dan status yang jujur. Scope melarang mengasumsikan angka yang belum diputuskan. Tanpa keputusan ini, tidak ada cara tertulis untuk mengembalikan data, dan hilangnya volume `pgsql_data` berarti hilangnya seluruh data.

## Options considered

### Opsi 1: Backup logis `pg_dump` dari image PostgreSQL proyek, restore ke target baru yang diprovision ulang

Job Compose sekali jalan memakai image `foundation-postgres:18-pinned` yang sama dengan server, menjalankan `pg_dump` format custom dengan kompresi zstd sebagai role baca saja di network data, lalu menulis dump, checksum, dan manifest ke folder host. Restore masuk ke cluster baru yang lebih dulu diprovision dengan password baru, memakai `pg_restore` dalam satu transaksi, lalu diverifikasi provisioning, runner migration, fingerprint, dan readiness. (basis: aturan keamanan tentang backup yang dapat dipulihkan dan privilege minimum, spec 0002 image yang dipin, spec 0004 dan 0005 provisioning dan runner)

**Pros**:
- Tanpa alat, image, atau dependency baru; versi `pg_dump` selalu sama dengan server.
- Restore dapat dibuktikan per push dengan container lokal dan memakai verifikasi yang sudah teruji.
- Backup tidak memuat role dan password, sehingga restore sesudah insiden tidak membawa credential lama.

**Cons**:
- RPO sebesar interval backup (24 jam); tidak ada pemulihan ke titik waktu tertentu.
- Restore database besar lebih lambat dari restore fisik, dan satu transaksi menahan lock setiap objek.
- Menambah satu role login dan satu credential untuk dirawat.

### Opsi 2: Backup fisik dan arsip WAL berkelanjutan (PITR)

Base backup dengan `pg_basebackup` atau alat seperti pgBackRest atau WAL-G, ditambah arsip WAL terus menerus, sehingga data dapat dipulihkan ke detik tertentu. (basis: pemulihan ke titik waktu tertentu sebagai praktik standar PostgreSQL, spec 0004 tentang atribut `NOREPLICATION`)

**Pros**:
- RPO dalam hitungan menit dan pemulihan ke titik waktu tertentu.
- Restore fisik cepat untuk database besar.

**Cons**:
- Membutuhkan role `REPLICATION` atau `archive_command` di konfigurasi server, padahal spec 0004 mewajibkan semua role `NOREPLICATION` dan entrypoint spec 0002 sengaja minimal.
- Alat baru yang harus dipin, penyimpanan WAL yang terus tumbuh, dan prosedur restore yang lebih rumit, tanpa platform atau SLA yang memintanya.
- Backup fisik memuat seluruh cluster termasuk `pg_authid`, yaitu hash password semua role.

### Opsi 3: Snapshot volume `pgsql_data`

Menyalin atau men snapshot volume Docker, misalnya `tar` saat server berhenti atau snapshot filesystem saat server berjalan. (basis: aturan infrastruktur tentang volume `pgsql_data`)

**Pros**:
- Sangat sederhana dan cepat pada filesystem yang mendukung snapshot.

**Cons**:
- Perlu server berhenti atau filesystem dengan snapshot konsisten (LVM, ZFS, layanan cloud), yang bergantung pada platform.
- Memuat seluruh cluster termasuk password role dan admin; tidak dapat dipulihkan ke major lain dan sulit dibuktikan konsistensinya per tabel.

### Opsi 4: Backup terkelola platform

Database terkelola atau layanan backup penyedia cloud dengan PITR bawaan. (basis: scope, platform dan penyedia belum dipilih)

**Pros**:
- RPO dan RTO terbaik dengan beban operasi paling kecil.

**Cons**:
- Platform belum dipilih, memilihnya atas nama pemilik melampaui delegasi, dan tidak dapat dibuktikan lokal.
- Mengikat pemulihan pada satu penyedia.

## Rationale

Masalah utamanya adalah membuktikan pemulihan, bukan sekadar membuat backup, tanpa platform dan tanpa data bisnis. Opsi 1 memberi bukti itu dengan komponen yang sudah ada: image server yang sama, provisioning yang sudah menjadi satu satunya sumber bentuk role, dan runner yang sudah memverifikasi riwayat migration terhadap checksum file. Restore ke target baru yang diprovision ulang menjawab dua kriteria scope sekaligus: password role tidak pernah ada di backup, dan setiap pemulihan otomatis merotasi credential database, yang memang dibutuhkan sesudah insiden. Probe 2026-10-06 membuktikan jalur ini apa adanya: provisioning ulang `verified`, runner `0 applied, 1 skipped`, data dan ACL sama.

Opsi 2 adalah jawaban yang tepat ketika produk membutuhkan RPO di bawah satu hari, tetapi saat ini ia melanggar keputusan role spec 0004, menambah alat, dan memasukkan hash password ke backup, tanpa kekuatan yang memintanya. Opsi 3 bergantung pada filesystem platform dan membawa seluruh cluster. Opsi 4 menunggu platform. Ketiganya dicatat sebagai jalur lanjutan: Opsi 2 atau 4 menjadi spec baru saat RPO perlu diperkecil.

Pemakaian ulang juga menentukan tempat bukti: suite `tests/integration/database/` sudah berjalan per push di tier nyata dengan PostgreSQL 18 yang dipin, pemindaian secret turunan seed, dan pembersihan sinyal yang diperiksa GATE-009, sehingga backup dan restore cukup menjadi satu file test baru dan satu bukti tambahan, tanpa tier, langkah, atau jenis bukti baru.

## Keputusan agent atas delegasi pemilik

Pemilik proyek mendelegasikan keputusan desain ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"). Tidak ada manusia selama run. Percakapan desain dijalankan sebagai pertimbangan internal: setiap pertanyaan dicatat dengan pilihan, rekomendasi, dan pilihan akhir. Semua keputusan berikut diambil oleh agent pada 2026-10-06 atas delegasi tersebut, tanpa konfirmasi manusia.

Framing yang disimpulkan: mode FEATURE (kemampuan baru di atas stack, topologi, dan gate yang ada, dengan membaca kode yang harus diintegrasikan), platform operasi database dan tooling CLI tanpa permukaan HTTP baru; stack dari `AGENTS.md` (Bun 1.4.2 dan Bun.SQL, PostgreSQL 18 image proyek, Docker Compose); build approach Tracer Bullet dari scope; workflow GA. Tidak ada spec yang tumpang tindih untuk diperbarui atau digantikan; spec 0002, 0004, 0005, 0010, 0011, dan 0012 menjadi batasan, dan matriks role spec 0004 mendapat amandemen. Belum ada data regulasi; dampaknya pada data pribadi dicatat di security model. Pemeriksaan "sudah dibangun" dan "visi produk" pada validasi scope tidak berlaku: topik adalah keputusan spesifik yang belum dibangun.

**Tahap kebutuhan**

1. **Pekerjaan inti dan batas.** Pilihan: (a) alat backup dan restore, sasaran tertulis, restore terisolasi yang terverifikasi, bukti per push, catatan latihan, dan prosedur insiden, tanpa unggah; (b) ditambah otomatisasi salinan ke penyedia penyimpanan contoh; (c) hanya prosedur tertulis. Rekomendasi dan pilihan: (a). (b) dilarang tugas dan memilih penyedia atas nama pemilik; (c) tidak membuktikan pemulihan, yang justru ditekankan scope.
2. **Metode backup.** Pilihan: Opsi 1 sampai 4. Dipilih Opsi 1, alasan di *Rationale*.
3. **RPO.** Pilihan: (a) 24 jam lewat backup harian ditambah backup wajib sebelum migration; (b) 1 jam lewat dump per jam; (c) menit lewat arsip WAL. Rekomendasi dan pilihan: (a). Belum ada data bisnis maupun SLA; backup sebelum migration menutup risiko terbesar di sekitar deploy. (b) melipatgandakan beban dan penyimpanan tanpa kebutuhan terukur; (c) membutuhkan Opsi 2.
4. **RTO.** Pilihan: (a) 4 jam; (b) 1 jam; (c) 24 jam. Rekomendasi dan pilihan: (a). Restore database saat ini berlangsung dalam hitungan detik (probe: 26 ms), sehingga waktu didominasi respons manusia dan langkah runbook; 1 jam menuntut jaga siaga yang belum ada, dan 24 jam terlalu lama untuk production. Nilai ini diukur pada setiap latihan, bukan diklaim dari test.
5. **Retensi.** Pilihan: (a) 35 hari dengan 7 backup lengkap terbaru selalu disimpan; (b) skema kakek ayah anak (7 harian, 4 mingguan, 12 bulanan); (c) 7 hari. Rekomendasi dan pilihan: (a). 35 hari menutup kesalahan logis yang baru ketahuan dalam satu siklus bulanan, sejalan dengan retensi log 30 hari spec 0012, dan membatasi berapa lama data yang dihapus pengguna masih tersimpan. Batas minimal 7 mencegah retensi menghapus semua backup ketika backup berhenti berhasil. (b) menyimpan data setahun tanpa kebutuhan hukum yang diketahui; (c) terlalu pendek untuk kerusakan diam diam.
6. **Backup sebelum migration.** Pilihan: (a) langkah wajib di prosedur deployment; (b) runner migration menolak berjalan tanpa backup baru. Dipilih (a): runner tidak memegang credential backup dan tidak boleh bergantung pada folder host; (b) menggabungkan dua tanggung jawab dan dua credential.
7. **Latihan restore.** Pilihan: (a) setiap 30 hari per environment dengan data nyata, sebelum production pertama, dan sesudah perubahan alat backup, role, atau pin PostgreSQL; (b) setiap kuartal; (c) hanya saat release. Dipilih (a): backup yang tidak pernah dipulihkan tidak dapat dipercaya, dan 30 hari selaras dengan retensi; (b) membiarkan kerusakan alat tidak terlihat terlalu lama; (c) tidak terikat pada perubahan data.
8. **Tempat bukti kandidat.** Pilihan: (a) file test baru di suite `tests/integration/database/` yang sudah menjadi langkah `test:database:real`, dengan `restore.json` sebagai bukti tambahan; (b) langkah tier nyata baru dengan orkestrasi dan jenis bukti sendiri seperti spec 0012; (c) lokal saja. Rekomendasi dan pilihan: (a). Tanpa tier, langkah, workflow, atau jenis bukti baru, cakupan GATE-009 dan pemindaian seed berlaku otomatis, dan bundle tier nyata mengikat bukti pada commit. (b) menambah ratusan baris orkestrasi dan perubahan gate untuk bukti yang sama; (c) tidak memberi bukti CI.

**Tahap data**

9. **Schema metadata backup** (pertanyaan `AGENTS.md`). Pilihan: (a) metadata sebagai file manifest dan checksum di samping dump, tanpa objek database; (b) tabel `common.backups`; (c) keduanya. Rekomendasi dan pilihan: (a), sehingga tidak ada data persisten baru dan tidak ada schema yang dipilih. Metadata backup harus tetap ada ketika database yang di backup hilang; tabel di database itu ikut hilang. Arahan orkestrator juga meminta tidak menambah objek database tanpa kebutuhan jelas.
10. **Cakupan.** Pilihan: (a) seluruh database `foundation` tanpa filter; (b) daftar schema eksplisit (`common` saja, lalu ditambah per fitur). Dipilih (a): schema dan tabel baru ikut otomatis tanpa daftar yang dapat tertinggal; schema kosong tidak berbiaya. Scope menyebut schema yang dipakai sebagai batas bawah, bukan larangan.
11. **Password role dan cara role dibuat ulang.** Pilihan: (a) tanpa globals; role dibuat ulang provisioning dengan password baru sebelum restore; (b) `pg_dumpall --roles-only --no-role-passwords` ikut disimpan untuk membuat ulang role; (c) globals beserta hash password. Rekomendasi dan pilihan: (a). Provisioning sudah menjadi satu satunya sumber bentuk role yang teruji, dan password baru adalah rotasi yang memang dibutuhkan sesudah insiden. (b) menggandakan definisi role yang dapat menyimpang dari spec 0004 dan tetap butuh langkah password; (c) menyimpan verifier SCRAM dan mengikat pemulihan pada credential lama.
12. **Credential job backup.** Pilihan: (a) role baru `foundation_backup` `NOINHERIT` dengan membership `pg_read_all_data` `SET TRUE`, dipakai lewat `pg_dump --role=pg_read_all_data`; (b) `foundation_migrator` dengan `pg_dump --role=foundation_owner`; (c) `foundation_admin`. Rekomendasi dan pilihan: (a). Job terjadwal memegang credential terus menerus, sehingga credential itu sebaiknya tidak dapat mengubah atau menghapus apa pun; aturan keamanan meminta privilege minimum per tugas. Pilihan kedua (b) tidak mengubah provisioning, tetapi memberi job terjadwal credential yang dapat menjalankan DDL sebagai owner; (c) superuser. Polanya sama dengan migrator (`NOINHERIT` lalu `SET ROLE` eksplisit), dan probe membuktikan role itu dapat membaca tetapi tidak dapat menulis atau menjadi owner. Pada satu host Docker pemisahan ini terbatas karena akses Docker setara root, dan hal itu dinyatakan di security model.
13. **Role wajib atau opt in.** Pilihan: (a) dibuat hanya bila `FOUNDATION_BACKUP_PASSWORD` diberikan, diverifikasi setiap kali ada; (b) wajib pada setiap provisioning. Dipilih (a): dua belas file orkestrasi dan test di luar `provision.ts` (misalnya `deployment-real.ts`, `readiness-real.ts`, `performance-real.ts`, dan test database) serta README, aturan deployment, dan spec 0004 dan 0012 memakai provisioning dengan dua password; (b) memaksa semuanya berubah tanpa manfaat bagi test yang tidak memakai backup. Role yang ada tetap diverifikasi penuh, sehingga opt in tidak melemahkan pemeriksaan.

**Tahap stack dan tool**

14. **Alat.** Pilihan: (a) `pg_dump` dan `pg_restore` dari image PostgreSQL proyek; (b) pgBackRest, WAL-G, atau Barman; (c) ekspor `COPY` buatan sendiri dengan Bun. Dipilih (a): sudah terpasang dan dipin, versi sama dengan server. (b) termasuk Opsi 2; (c) menulis ulang alat yang matang. Karena tidak ada alat baru, penawaran Agent Skills dan MCP (`internal/tool-discovery.md`) tidak berlaku.
15. **Format dan kompresi.** Pilihan: (a) format custom dengan `--compress=zstd`; (b) format direktori dengan `pg_dump -j` paralel; (c) SQL teks. Dipilih (a): satu file untuk checksum dan penyalinan, mendukung `pg_restore --list` dan restore selektif, zstd tersedia di build PGDG ini. (b) bermanfaat hanya pada ukuran besar dan menghasilkan banyak file; (c) tanpa daftar isi dan tanpa restore selektif.
16. **Bentuk job.** Pilihan: (a) file Compose sendiri `deploy/backup.yaml` dengan network data external; (b) service tambahan di `deploy/compose.yaml`; (c) perintah `docker run` di dokumen saja. Rekomendasi dan pilihan: (a). (b) mengubah tabel *Topologi* spec 0012 yang dikunci DEP-001 dan DEP-005, dan karena Compose menginterpolasi seluruh file, penjadwal backup membutuhkan `.env.deploy` yang memuat password admin; (a) cukup dengan `.env.backup` yang hanya memuat credential backup. (c) membuat perintah tidak dapat diuji per push. Probe membuktikan network external yang `internal: true` dari project lain, `user` host, bind mount script, dan `run -e` dari shell bekerja.
17. **Bahasa script.** Pilihan: (a) bash di image PostgreSQL untuk `pg_dump` dan `pg_restore`, dan Bun hanya untuk fingerprint; (b) Bun untuk semuanya di image runner; (c) image backup baru. Dipilih (a): image runner tidak memuat `pg_dump`, dan image baru menambah build, pin, dan pemindaian. Bun dipakai di tempat logika SQL dan test lebih penting (fingerprint).
18. **Checksum dan manifest.** Pilihan: (a) file `sha256sum` standar ditambah manifest JSON yang ditulis terakhir sebagai tanda lengkap; (b) manifest saja dengan checksum di dalamnya; (c) metadata di database. Dipilih (a): checksum dapat diverifikasi dengan alat standar di mana pun salinan berada, dan restore tidak perlu mengurai JSON untuk memeriksa integritas.
19. **Lokasi dan enkripsi.** Pilihan: (a) folder host 0700 di luar checkout dan volume, salinan di luar host oleh platform, enkripsi at rest pada lokasi penyimpanan; (b) ditambah enkripsi sisi client sekarang (misalnya age dengan public key); (c) volume Docker bernama. Rekomendasi dan pilihan: (a), dengan keputusan (b) dipindah menjadi hook fitur 15. Saat ini backup hanya memuat riwayat migration; enkripsi sisi client membutuhkan alat baru di image dan manajemen key yang belum ada. Begitu hash credential dan sesi tersimpan, kebocoran backup memberi bahan untuk menebak password secara offline, sehingga keputusan itu wajib sebelum fitur 15 selesai. (c) membuat backup hidup di mesin container yang sama dengan data.
20. **Penjadwal.** Pilihan: (a) penjadwal operator atau platform (systemd timer, cron, job terjadwal platform) yang menjalankan `create scheduled` lalu `check`; (b) service cron yang selalu berjalan di topologi. Dipilih (a): tidak ada container tambahan yang selalu hidup memegang credential; (b) menambah permukaan dan pemantauan tersendiri.

**Tahap antarmuka**

21. **Target restore.** Pilihan: (a) project baru yang diprovision lebih dulu, lalu `pg_restore --clean --if-exists --single-transaction --exit-on-error`; (b) restore di tempat ke database yang berjalan; (c) restore ke cluster baru tanpa provisioning, lalu provisioning. Rekomendasi dan pilihan: (a), terbukti pada probe. (b) dapat menimpa data sehat dan menghapus jejak insiden; (c) gagal karena owner objek harus sudah ada sebelum restore. Restore tanpa `--clean` ke database berisi gagal pada `CREATE SCHEMA auth` (probe), tetapi pemeriksaan target kosong tetap dibuat eksplisit agar pesan jelas dan target tidak pernah tersentuh.
22. **Verifikasi konsistensi.** Pilihan: (a) provisioning ulang, runner migration, fingerprint (jumlah baris, digest multiset baris, sequence, riwayat), dan readiness; (b) jumlah baris saja; (c) membandingkan dump kedua dari target dengan dump sumber. Dipilih (a): setiap bagian sudah ada atau kecil, dan digest menangkap perubahan nilai, bukan hanya jumlah. (c) peka terhadap urutan dan OID tanpa menambah keyakinan. Digest memakai `hashtextextended` yang tidak kriptografis; integritas file dijaga checksum SHA 256, dan catatan latihan hanya memuat jumlah baris agar digest data production tidak tersimpan.
23. **Pesan dan penyaringan.** Pilihan: (a) hanya kategori tetap; (b) keluaran mentah dengan penggantian DSN dan password. Dipilih (a): probe membuktikan libpq mencetak ulang potongan password untuk connection string dengan spasi dan persen encoding tidak sah, dan penggantian berbasis parsing URI di bash rapuh.
24. **Batas waktu.** `pg_dump` 3.600 detik, `pg_restore` 10.800 detik (di bawah RTO 4 jam), dan `--lock-wait-timeout=30s` agar backup gagal jelas saat bertabrakan dengan migration, bukan menggantung sampai jadwal berikutnya.
25. **Pemantauan.** Ambang `check` 26 jam (RPO ditambah 2 jam toleransi jadwal), memeriksa checksum backup terbaru, dan keluar 1 agar penjadwal atau platform dapat memicu alert.

**Tahap keamanan dan otorisasi**

26. **Akses manusia.** Hanya pemilik operasi; identitas penyimpanan dipisah untuk unggah, baca, dan hapus; CI dan pengembang tidak pernah menyentuh backup environment.
27. **Credential restore.** Pilihan: (a) DSN admin target dari shell lewat `run -e`; (b) di `.env.backup`. Dipilih (a): sama dengan provisioning spec 0012, dan file yang dipegang penjadwal tetap tanpa credential admin.
28. **Isolasi jaringan restore.** Container restore hanya bergabung dengan network data project target, sehingga tidak dapat menjangkau database sumber.
29. **Perbaikan kategori provisioning.** Probe menemukan `Unknown privilege drift` tercetak sebagai `Database provisioning failed` karena tidak ada di regex kategori aman. Karena role backup menambah jalur pesan itu, regex ditambah kategori tersebut; tidak ada nilai rahasia di pesan.

**Tahap kasus tepi dan kegagalan**

30. **Run bersamaan.** Tidak ada lock: nama memakai detik, file sementara per nama, dan retensi hanya menyentuh backup lama, sehingga dua run tidak saling merusak; penjadwal tidak boleh menjalankan run tumpang tindih.
31. **Row level security dan large object.** `pg_dump` sebagai `pg_read_all_data` gagal jelas pada tabel ber RLS (probe) dan tidak membaca large object, sehingga fitur yang memakainya wajib memperbarui spec ini (invariant 8), dan `check` yang gagal memberi sinyal.
32. **Versi major berbeda.** Restore menolak; upgrade major adalah prosedur terpisah sesuai aturan infrastruktur.
33. **Backup lebih lama atau lebih baru dari image.** Backup lama dipulihkan lalu runner menerapkan migration tertunda (jalur deploy biasa); backup yang lebih baru dari image memberi `Migration history drift` dan runbook berhenti.
34. **Pemindahan trafik saat pemulihan.** Project baru, project lama dihentikan tanpa menghapus volume sampai insiden ditutup, karena nama volume Compose tidak dapat dipakai ulang tanpa menghapus data lama.
35. **Pencabutan sesi.** Belum ada sesi; hook fitur 15 menetapkan apa yang harus disediakan agar langkah itu berubah dari `tidak berlaku` menjadi wajib.
36. **Desain test.** Sumber dimigrasi dengan root fixture (salinan migration repository ditambah satu migration dan satu seed fixture) agar data tidak sepele dan pemeriksaan riwayat dapat dibuktikan dua arah tanpa menambah file ke `database/` repository. Readiness memakai `createApp('production')` seperti DEP-009. Batas run `bun test` di `database-real.ts` dinaikkan dari 300.000 menjadi 600.000 ms karena suite bertambah dua cluster, masih jauh di bawah batas langkah tier nyata 1.500.000 ms.
37. **Bukti environment.** Pilihan: (a) template catatan latihan dan catatan pertama pada topologi rujukan, ditambah bagian template laporan release; (b) status latihan dihitung `test:report:release`. Dipilih (a): environment nyata belum ada, dan (b) menuntut format bukti mesin untuk catatan manual serta mengubah kriteria AC-12 spec 0012. Pilihan kedua dicatat di tindak lanjut bila pemilik release menginginkannya.

**Penerimaan spec.** Tidak ada manusia untuk panel konfirmasi; agent menerima isi spec ini atas delegasi pemilik pada 2026-10-06. Karena fitur 14 di scope menautkan spec ini, status tetap `Proposed` dan dimajukan `/develop`. Cross check independen dijalankan model lain pada tahap pipeline terpisah; temuannya dinilai dan diterapkan pada bagian *Cross check 2026-10-06*, dan fitur 14 di scope ditautkan ke spec ini pada tahap yang sama.

**Tingkat referensi**: `sources`. Tidak ada pemeriksaan web pada run ini; fakta versi dan perilaku berasal dari image yang dipin, kode repository, dan probe lokal.

## Cross check 2026-10-06

Cross check independen oleh model lain mengembalikan 30 temuan, sebagian sama satu sama lain. Agent menilai setiap temuan atas delegasi pemilik pada 2026-10-06 tanpa konfirmasi manusia, mengulang klaim yang dapat diuji dengan probe pada image yang dipin (*Bukti probe cross check 2026-10-06*), dan menerapkan perbaikan di `index.md`. Semua temuan dinilai nyata; yang berbeda dari rekomendasi tercatat di bawah *Ditolak atau diganti*. Keputusan desain yang diambil:

38. **Aturan grantee role backup.** Pilihan: (a) role backup dikenal hanya pada ACL database, grant langsung pada schema atau metadata gagal `Unknown privilege drift`, `CREATE` atau `TEMPORARY` pada database diperbaiki, dan grant option gagal; (b) role dikenal pada semua ACL sehingga grant langsung dicabut otomatis. Dipilih (a): role backup tidak pernah membutuhkan grant langsung, sehingga grant seperti itu tanda perubahan manual yang harus dilihat manusia, dan grant option gagal sama dengan role runtime. Daftar grantee ditulis tanpa subquery skalar, karena role yang tidak ada menghasilkan NULL dan `NOT IN` dengan NULL diam diam mematikan pemeriksaan. Hasil per kasus ada di tabel *Kasus provisioning role backup*.
39. **Arti `FOUNDATION_BACKUP_PASSWORD`.** Hanya variable yang tidak ada berarti role backup tidak dipakai; kosong atau kurang dari 16 karakter selalu gagal, ada atau tidaknya role, agar variable yang diekspor kosong tidak diam diam melewatkan pembuatan role lalu membuat backup pertama gagal autentikasi.
40. **GATE-009.** `backup.test.ts` masuk daftar `checked` dan `REAL_SUITES`, heuristik mengenali `docker network create`, `docker network rm`, dan `compose run --rm` di foreground, dan satu run `interruptedSuite` membuktikan pembersihan sinyal suite baru, sesuai aturan testing bahwa suite nyata baru memperluas pemeriksaan pada commit yang sama.
41. **Alat pembaca dump di test.** Container alat sekali jalan dari image PostgreSQL yang dipin, `--network none`, folder baca saja, dan nama eksplisit yang didaftarkan, karena host macOS dan runner GitHub tidak mempunyai alat PostgreSQL 18; hash juga dihitung ulang di Bun.
42. **Bukti kategori kegagalan.** Kategori yang dapat dipicu komponen nyata dibuktikan BKP-006 (izin, row level security, lock, database salah, folder, nama yang ada); `time limit`, `killed`, `archive invalid`, `interrupted`, `internal`, dan `Retention failed` hanya dibuktikan statis di BKP-001, dan AC-3 ditulis ulang agar tidak mengklaim bukti runtime untuk keenamnya. Kasus lock menambah sekitar 30 detik.
43. **Baris retensi dan isi `restore.json`.** Satu baris `Backup removed` per backup lengkap dan satu baris `Leftover removed` per file sisa dalam urutan tetap; setiap field `restore.json` mendapat tipe, `failures` dan `retention.leftovers` ditambah, dan nilai BKP-007 ditetapkan tepat.
44. **Fingerprint dengan `row_security` off.** Tanpa itu tabel ber RLS terbaca 0 baris tanpa galat dan perbandingan sumber dan target lulus palsu (probe).
45. **RLS dan `BYPASSRLS`.** `BYPASSRLS` pada role login tidak berpengaruh sesudah `SET ROLE pg_read_all_data` (probe), sehingga invariant 8, hook butir (5), dan prosedur insiden ditulis ulang: menyalakan RLS membutuhkan amandemen model akses, bukan satu atribut.
46. **Keaslian archive dan restore superuser.** Checksum dinyatakan hanya mendeteksi kerusakan. Langkah 1 runbook mewajibkan pembandingan sha256 dengan catatan di luar folder backup dan di luar identitas unggah (log penjadwal yang disimpan 35 hari atau metadata objek terkunci); tanda tangan atau enkripsi terautentikasi menjadi prasyarat hook butir (4); risiko archive palsu diterima sampai itu. Major backup dibaca dari header dump yang ikut checksum, bukan dari manifest, sehingga restore juga tidak perlu mengurai JSON tanpa `jq`.
47. **Urutan uji target.** Satu cluster target dipakai berurutan: belum diprovision (`target_not_provisioned`, dibuktikan snapshot katalog admin), diprovision kosong (`restore_failed`, dibuktikan fingerprint), dipulihkan BKP-004, lalu guard lain dengan fingerprint. `restore.durationMs` diukur dari awal run restore BKP-004 agar tidak tercampur waktu guard. Cluster target kedua ditolak karena menambah container dan waktu tanpa menambah keyakinan.
48. **Semantik `check`.** Umur dari stempel nama yang ditulis ulang ke ISO karena GNU `date` menolak bentuk stempel (probe), jam dibulatkan ke bawah, batas 26 jam inklusif, checksum diperiksa sebelum umur, dan folder diperiksa seperti `create`.
49. **Ketahanan script.** Trap menghapus semua file milik run sampai `done` dan tidak pernah file yang sudah ada; retensi yang gagal menyimpan backup baru dan keluar 1 dengan `Retention failed` agar alert berbunyi; exit 137 dibedakan menjadi `time limit` atau `killed` lewat durasi; trap TERM dan INT dengan proses anak di background karena script berjalan sebagai PID 1; variable dibaca `${NAME:-}`; `psql` memakai `-w`, `PGCONNECT_TIMEOUT=10`, dan `timeout` 60 detik.
50. **Pemetaan lock timeout.** pg_dump 18 melaporkan lock yang tertahan sebagai `canceling statement due to statement timeout` (probe), sehingga pola itu ditambah dan urutan pencocokan pola ditetapkan.
51. **Format file checksum.** Restore dan `check` mewajibkan tepat satu baris `<hash>  <nama>.dump` sebelum `sha256sum --check`, karena alat itu memeriksa file apa pun yang dinamai file checksum (probe).
52. **Database salah.** Backup menolak archive yang header nya bukan `dbname: foundation` atau tanpa data `common.schema_migrations`, agar DSN yang salah tunjuk tidak menghasilkan backup kosong yang kemudian menggeser backup asli lewat retensi.
53. **Batas `pg_authid`.** `pg_read_all_data` memberi baca setiap katalog termasuk `pg_authid` dan tidak dapat dicabut per katalog (probe). Keputusan 12 dipertahankan, karena alternatif grant `SELECT` eksplisit dengan default privilege mengubah pemeriksaan `Default privilege drift` spec 0004 dan harus dirawat per tabel. Sebagai gantinya `.env.backup` dinyatakan setingkat admin untuk kerahasiaan, setiap role wajib memakai password `openssl rand -hex 24`, kebocoran memicu rotasi keempat role, dan BKP-002 membuktikan batas itu apa adanya, bukan mengklaim penolakan.
54. **Sasaran di luar host.** RPO saat host hilang dinyatakan 25 jam; jaminan 7 backup berlaku di host; salinan di luar host memakai aturan jumlah versi, atau alert 27 jam dengan lifecycle dihentikan selama alert aktif.
55. **Isi aturan operasi.** `backup.md` memuat aturan nilai `.env.deploy` untuk `.env.backup`, `install -d -m 0700`, `chown` dan `chmod 0600` file yang disalin kembali, path absolut, dan arti database berisi data (paling sedikit satu baris `common.schema_migrations`).
56. **Latihan restore.** Empat image dicatat, RTO latihan berakhir pada readiness 200 karena latihan lokal tidak menjalankan edge dan tidak mempunyai input TLS, pohon input build dihitung sebelum catatan ditulis dengan perintah tetap, dan isolasi internet diamati pada network data `internal` yang nyata.
57. **BKP-002 di cluster bersama.** Test BKP-002 berada sesudah test DATA, kasus tanpa role berjalan pertama, setiap kasus drift dipulihkan di `finally`, dan role dihapus di akhir.
58. **`database-real.ts`.** `restore.json` lama dihapus sebelum run, ketiadaan atau status bukan `passed` menjadi kegagalan, jumlah file bundle dihitung sendiri, `run()` mendapat batas per panggilan, dan secret baru ikut environment build. Jenis bukti gate tetap `data`.

**Ditolak atau diganti** (satu baris alasan per butir):

- Allowlist jenis entri TOC sebelum restore (opsi pada temuan restore superuser): ditolak, karena definisi entri yang diizinkan seperti `TABLE` tetap dapat memuat SQL apa pun, sehingga memberi rasa aman palsu dan menghambat fitur yang kelak menambah fungsi atau trigger.
- Pola ekstraksi `serverVersion` dari manifest dan pesan untuk manifest rusak: tidak diperlukan lagi, karena restore membaca major dari header dump dan tidak membaca isi manifest; manifest tetap ditetapkan satu baris JSON ringkas.
- Perbaikan otomatis grant option `CONNECT` role backup (rekomendasi temuan matriks pertama): diganti gagal `Grant option drift`, sama dengan role runtime, agar pemeriksaan tidak melemah.
- Unit test fungsi pemetaan dengan contoh pesan untuk `time limit` dan `archive invalid`: diganti pemeriksaan statis BKP-001, karena pemetaan ditulis di bash tanpa harness unit dan harness baru tidak sebanding dengan manfaatnya.
- Shim `timeout` atau `pg_restore` khusus test lewat file Compose tambahan: ditolak, karena yang teruji menjadi shim, bukan alat nyata.
- Folder dengan UID container lain untuk memicu `Backup directory unavailable`: diganti `FOUNDATION_BACKUP_DIR` yang berupa file, karena izin bind mount Docker Desktop macOS tidak mengikuti UID seperti Linux.
- Menamai helper penghapusan dengan nama yang sudah dikenali heuristik (misalnya `removeStack`) agar GATE-009 lulus tanpa perubahan: ditolak, karena mengakali heuristik tanpa menambah keyakinan.

## Review 2026-10-06

Review kode independen oleh model lain mengembalikan sepuluh temuan (satu major, sembilan minor; dua pasang membahas hal yang sama). Tidak ada manusia yang dapat ditanya pada run ini, jadi agent menilai setiap temuan dan mengambil keputusan berikut sendiri atas delegasi pemilik pada 2026-10-06, memilih rekomendasi masing masing. Setiap temuan dibuktikan lebih dulu (*Bukti probe review 2026-10-06*), lalu test regresi ditulis dan dijalankan terhadap perilaku lama (gagal) dan perilaku baru (lulus).

59. **Password DSN di argumen proses** (major, dua temuan). Pilihan: (a) script memisahkan password dari DSN URI ke `PGPASSWORD` dan memberi `--dbname` URI tanpa password, dengan aturan userinfo dan decode persen libpq; (b) script menulis file `PGPASSFILE` mode 0600 di `/tmp`; (c) mengurai seluruh DSN ke `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, dan `PGPASSWORD`; (d) menerima risiko dan mencatatnya dengan `hidepid=2` sebagai mitigasi host. Rekomendasi dan pilihan: (a). Environment proses hanya terbaca UID yang sama dan root, sama dengan file di tmpfs container, dan DSN lengkap sudah ada di environment container, sehingga (a) tidak menambah paparan; (b) menambah file dan escape `:` serta `\` tanpa perlindungan tambahan; (c) memindahkan seluruh parsing URI (multi host, IPv6, parameter) ke bash, padahal keputusan 23 mencatat parsing URI di bash rapuh, sedangkan (a) hanya memisahkan userinfo dan membiarkan libpq mengurai sisanya beserta pesan galatnya; (d) membiarkan password superuser terbaca pengguna host saat insiden, bertentangan dengan langkah 3 aturan deployment. Bentuk selain URI, password dengan spasi atau persen tidak sah (termasuk `%00`), dan parameter query `password` ditolak sebagai `invalid connection string`, karena tidak dapat dipisah tanpa password tertinggal di argumen; kasus BKP-006 connection string rusak tetap memberi kategori yang sama.
60. **Role login job backup** (minor). Pilihan: (a) `psql` `SELECT session_user` sebelum `pg_dump`, selain `foundation_backup` gagal `Backup failed: permission denied`; (b) memeriksa nama user di URI saja; (c) tidak berubah. Dipilih (a): (b) dilewati parameter `user` atau `PGUSER`, dan (c) membiarkan DSN superuser menghasilkan backup tanpa galat (probe), bertentangan dengan invariant 3. Kategori yang ada dipakai, sesuai *Prosedur insiden* (`permission denied` berarti DSN memakai role lain). Cadangan kategori `psql` adalah `pg_dump`, sama dengan pola restore yang memakai cadangan `pg_restore` untuk `psql`.
61. **Isolasi network restore** (minor). Pilihan: (a) network `restore_data` sendiri dengan nama `${FOUNDATION_RESTORE_DATA_NETWORK:-}` yang hanya dari shell; (b) `${FOUNDATION_RESTORE_DATA_NETWORK:?}`; (c) hanya memperbaiki kalimat spec dan dokumen. Dipilih (a): restore tanpa variable itu berhenti di Compose sebelum container dibuat (probe), sedangkan (b) juga menghentikan job backup karena Compose menginterpolasi seluruh file (probe), dan (c) membiarkan isolasi bergantung pada ingatan operator. Sebelumnya, operator yang lupa awalan shell membawa DSN superuser target ke network sumber; autentikasi gagal karena password target baru dan langkah 9 menolak database berisi, tetapi isolasi yang ditulis invariant 3 belum ditegakkan.
62. **Nama `.partial` pada retensi** (minor). Pilihan: (a) hanya nama yang cocok pola nama backup ditambah ekstensi dan `.partial` yang disentuh dan dicetak; (b) mencetak nama dengan karakter kontrol yang di escape. Dipilih (a): nama lain bukan buatan `create`, sehingga tidak perlu dihapus, dan tidak ada nama tak tervalidasi yang tercetak ke log penjadwal yang menjadi catatan sha256 independen. Probe membuktikan nama `.partial` yang ditanam dengan baris baru mencetak baris `Backup created:` palsu.
63. **Batas tunggu lock fingerprint** (minor). Pilihan: (a) `SET LOCAL lock_timeout = '30s'`; (b) ditambah `statement_timeout`; (c) tidak berubah. Dipilih (a): akar masalah adalah tunggu lock tanpa batas (probe: masih menunggu sesudah 41 detik), dan 30 detik sama dengan `--lock-wait-timeout=30s` backup. `statement_timeout` ditolak, karena scan digest tabel besar yang sah dapat lebih lama dari batas mana pun yang dipilih sekarang.
64. **Bukti runtime TERM dan INT** (minor, dua temuan). Pilihan: (a) kasus BKP-006 dengan komponen nyata selama `pg_dump` atau `psql` menunggu lock; (b) tetap statis saja. Dipilih (a): jendela lock sudah ada, sehingga AC-3 tidak lagi menyebut `interrupted` sebagai kategori yang hanya statis. Backup memakai TERM, INT, dan `docker stop`; restore memakai TERM dan INT saat langkah 9 menunggu lock `common.schema_migrations` target, dengan fingerprint target pada lock yang sama untuk keputusan 63, dan pembacaan argumen proses lewat `docker top` untuk keputusan 59. BKP-006 kini membuktikan juga AC-5 dan AC-6, dan registry diperbarui. GATE-009 tidak berubah: `docker kill`, `docker stop`, dan `docker top` tidak membuat resource, dan nama run sudah didaftarkan `composeRun`.
65. **Jam engine container pada test** (minor). Pilihan: (a) jendela nama dan `createdAt` dari `date -u +%s` container alat; (b) melebarkan jendela jam host. Dipilih (a): nama backup berasal dari jam engine, dan jam mesin virtual Docker Desktop dapat bergeser dari jam host ke arah mana pun, sehingga (b) hanya menggeser batas flake.
66. **Keputusan `restore.json` yang dapat diuji** (minor). Pilihan: (a) modul `tests/orchestration/restore-evidence.ts` dengan unit test GATE-008; (b) tetap di `database-real.ts` dengan pemeriksaan teks. Dipilih (a): `database-real.ts` langsung berjalan saat diimpor, sehingga cabang `Restore evidence missing` dan `Restore evidence not passed` sebelumnya tanpa test perilaku. Semantik keputusan tidak berubah.

**Ditolak atau diganti pada review** (satu baris alasan per butir):

- Mengubah baris *Perubahan GATE-009* untuk kasus sinyal baru (saran temuan TERM dan INT): tidak diperlukan, karena heuristik GATE-009 sudah mengenali setiap pembuatan resource baru dan tidak ada resource baru.
- `statement_timeout` pada fingerprint: ditolak (keputusan 63).
- Mencatat argumen proses sebagai risiko yang diterima dengan `hidepid=2`: diganti perbaikan keputusan 59.
- Catatan latihan restore 2026-10-06 tidak diubah: catatan itu bukti apa adanya untuk versi sebelum review; latihan ulang dicatat di *Follow-up* spec.

## Bukti probe review 2026-10-06

Probe memakai image `foundation-postgres:18-pinned` dan container sekali jalan, tanpa mencetak password:

- `pg_dump --dbname=postgres://u:<password>@10.255.255.1:5432/foundation` yang menunggu koneksi: `docker top` mencetak password apa adanya pada baris `bash` dan `pg_dump`, `/proc/<pid>/cmdline` bermode 0444, sedangkan `/proc/<pid>/environ` bermode 0400.
- libpq 18: `unexpected spaces found in "<token>"` untuk spasi di password, parameter query, atau nama database; `invalid percent-encoded token` untuk `%zz`; `forbidden value %00 in percent-encoded value`; tab dan baris baru di password lolos parser URI. `printf -v c '%b' "\xHH"` memberi byte yang sama di bash 3.2 host macOS dan bash 5.2 image.
- Script lama dengan `pg_dump` dan `pg_restore` palsu: file `.foundation-x<baris baru>Backup created: ...<baris baru>.partial` bermtime lama menghasilkan tiga baris keluaran, di tengahnya baris `Backup created:` palsu yang utuh.
- Cluster PostgreSQL 18 sekali jalan yang diprovision: `create manual` dengan DSN `foundation_admin` keluar 0 dengan tiga file backup; `database/fingerprint.ts` saat admin menahan `ACCESS EXCLUSIVE` pada `common.schema_migrations` masih menunggu sesudah 41 detik.
- `docker compose config` atas `deploy/backup.yaml` lama dengan env file berisi `FOUNDATION_DATA_NETWORK=foundation-deploy_data` dan profil `restore`: service `restore` bergabung dengan network `foundation-deploy_data`. Network kedua dengan `${VAR:?}` menghentikan `--profile backup config` saat variable kosong; dengan `${VAR:-}`, `run backup` berhasil dan `run restore` berhenti dengan `network  declared as external, but could not be found`.
- Jam: `date -u +%s` host dan container sama dalam 1 detik saat probe, sehingga flake jam tidak dapat dipicu sekarang; temuan dibuktikan lewat pembacaan kode (jendela nama dari jam host, nama dari jam container).

## Bukti probe 2026-10-06

Dijalankan agent pada sesi ini dengan Docker 29.8.0 (linux/arm64, Docker Desktop di macOS) dan Docker Compose 5.5.1, memakai image lokal `foundation-postgres:18-pinned` (ID `sha256:ae46ecb5…e775`, PostgreSQL 18.6, paket `18.6-4PGDG.rhel10.2`). Semua container, network, dan folder probe dihapus sesudahnya; password probe acak dan tidak dicetak.

- Image memuat `pg_dump`, `pg_restore`, `pg_dumpall`, `psql`, `pg_basebackup`, dan `pg_verifybackup` 18.6; `pg_config --configure` memuat `--with-zstd`, `--with-lz4`, dan `--with-openssl`. `sha256sum`, `date`, `stat`, dan `timeout` GNU coreutils 9.5, `awk`, `find`, `mv`, dan `sync` tersedia; CLI `openssl`, `gpg`, dan `age` tidak ada. Alat berjalan sebagai UID sembarang (12345) tanpa entri passwd, dengan `HOME=/`.
- Sumber diprovision dan dimigrasi dengan `database/provision.ts` dan `database/migrate.ts` apa adanya, ditambah tabel fixture `users.restore_fixture` (identity, text Unicode dengan tab dan baris baru, bytea, NULL) milik owner, role backup `NOINHERIT` dengan `pg_read_all_data` `SET TRUE`, dan `ALTER DATABASE foundation SET` berisi sentinel. `pg_dump --role=pg_read_all_data --format=custom --compress=zstd` dari container sekali jalan di network yang sama selesai dalam 60 ms tanpa satu baris pun di stderr, dump 6.681 byte, `sha256sum -c` lulus, dan `pg_restore --list` memuat 18 entri (schema, ACL, tabel, komentar, data, sequence, constraint), termasuk ACL schema `public` milik `pg_database_owner`.
- SQL hasil `pg_restore --file` memuat sentinel baris, tidak memuat sentinel pengaturan database, tidak memuat keempat password, dan tidak memuat `PASSWORD`, `SCRAM-SHA-256`, `CREATE ROLE`, maupun `ALTER DATABASE`.
- Target baru diprovision dengan password baru, lalu `pg_restore --clean --if-exists --single-transaction --exit-on-error` sebagai `foundation_admin` target selesai dalam 26 ms dengan exit 0. Provisioning ulang mencetak `verified` untuk setiap baris termasuk `database privileges`; `migrate.ts` mencetak `Migrations: 0 applied, 1 skipped`; jumlah baris dan `sum(hashtextextended(t::text, 0))` fixture, riwayat migration, ACL tabel dan keempat schema, serta `last_value` sequence sama persis antara sumber dan target; `foundation_backend` membaca metadata dengan password baru dan `search_path` `pg_catalog`; password backup sumber ditolak di target.
- Provisioning ulang pada sumber yang mempunyai role backup dengan `CONNECT` gagal dengan `Database provisioning failed` (pesan `Unknown privilege drift` tidak ada di regex kategori), sehingga provisioning harus mengenal role itu. Runner migration tetap lulus dengan role backup ada.
- Role backup tanpa `SET ROLE` ditolak (`permission denied for schema common`); sesudah `SET ROLE pg_read_all_data` dapat membaca tetapi `DELETE` ditolak; `SET ROLE foundation_owner` ditolak.
- Tabel dengan row level security membuat `pg_dump` sebagai `pg_read_all_data` gagal: `query would be affected by row-level security policy`.
- `pg_restore` tanpa `--clean` ke database berisi gagal pada `CREATE SCHEMA auth` dengan exit 1 dalam satu transaksi.
- libpq mencetak ulang potongan password pada dua bentuk connection string rusak: `unexpected spaces found in "<password>"` dan `invalid percent-encoded token: "<password>"`; port tidak sah dan parameter query asing tidak mencetak password.
- File Compose sendiri dengan `name: foundation-backup`, network external yang dibuat `docker network create --internal`, `user` UID host, bind mount script baca saja, dan `run --rm -e FOUNDATION_ADMIN_DATABASE_URL` dari environment shell berjalan; container melihat `/backup` dengan mode 700, `psql` menjangkau server lewat alias `postgres`, dan file yang ditulis dengan `umask 077` bermode 0600.

## Bukti probe cross check 2026-10-06

Dijalankan agent tahap cross check pada image lokal yang sama (`sha256:ae46ecb5…e775`, PostgreSQL 18.6) dengan container dan network sekali pakai bernama `foundation-xcheck-probe-<hex>`, password acak yang tidak dicetak, dan pembersihan lewat `trap`; tidak ada container atau network probe yang tersisa.

- Role `NOINHERIT` dengan `pg_read_all_data` `SET TRUE`, sesudah `SET ROLE pg_read_all_data`, membaca `pg_catalog.pg_authid` (dua baris dengan `rolpassword` terisi: admin dan role itu sendiri; hanya jumlah yang dicetak).
- Dalam transaksi `REPEATABLE READ READ ONLY` sesudah `SET LOCAL ROLE pg_read_all_data`, tabel dengan `ENABLE ROW LEVEL SECURITY` tanpa policy terbaca `0` tanpa galat; dengan `SET LOCAL row_security = off`, query yang sama gagal `query would be affected by row-level security policy for table "r"`.
- Role login dengan `BYPASSRLS` dan `pg_read_all_data` `SET TRUE`, menjalankan `pg_dump --role=pg_read_all_data`, tetap gagal dengan pesan row level security yang sama pada `COPY`.
- `pg_dump --lock-wait-timeout=2s` saat sesi admin menahan `ACCESS EXCLUSIVE` keluar 1 dengan `pg_dump: error: query failed: ERROR:  canceling statement due to statement timeout` dan detail `Query was: LOCK TABLE ... IN ACCESS SHARE MODE`.
- Header `pg_restore --list` memuat `;     dbname: foundation`, `;     Dumped from database version: 18.6`, dan `;     Dumped by pg_dump version: 18.6`, lalu entri seperti `TABLE DATA public t foundation_admin`.
- `date -u -d 2026-10-06T02:00:00Z +%s` berhasil, sedangkan `date -u -d 20261006T020000Z` gagal `invalid date`.
- `sha256sum --check --strict --status` atas file checksum yang menamai file lain (salinan dump dengan nama berbeda) keluar 0.

## Pertanyaan yang belum dapat diputuskan

Setiap pertanyaan berikut mempunyai jalur otonom yang sudah diputuskan, sehingga build tidak berhenti menunggu manusia.

- Penerimaan pemilik atas RPO 24 jam, RTO 4 jam, dan retensi 35 hari untuk produk nyata. Nilainya keputusan agent yang dapat ditinjau ulang saat produk mempunyai SLA atau kebutuhan hukum; perubahan lewat pembaruan spec ini.
- Penyedia penyimpanan di luar host, cara enkripsi at rest, dan penjadwal pada platform. Ditetapkan sebagai kewajiban operasi; implementasinya menunggu platform.
- Perilaku bind mount dengan `user` UID host pada runner Linux GitHub (pemeriksaan mode 0700 dan izin tulis). Probe hanya di Docker Desktop macOS; bila berbeda di Linux, langkah 1 *Build plan* menyesuaikan cara test menyiapkan folder tanpa melonggarkan pemeriksaan mode di script.
- Nama container `compose run` untuk pembersihan sinyal sudah diputuskan pada cross check: `compose run --rm --name foundation-backup-run-<hex>-<n>` di foreground, dihapus `docker rm -f` pada sinyal dan dikenali GATE-009 sebagai penghapusan (baris *Perubahan GATE-009* di spec).
- Durasi `test:database:real` di runner GitHub sesudah dua cluster tambahan dan kasus lock sekitar 30 detik; terukur sesudah push.
- Kebutuhan hukum tentang data yang dihapus pengguna tetapi masih ada di backup sampai 35 hari; diputuskan saat produk menyimpan data pribadi.
- Batas lock `pg_restore --single-transaction` untuk database dengan ribuan objek; ditangani saat ukuran itu tercapai.

## References

**Project sources**:

- `AGENTS.md`, sumber aturan, koordinasi subagent, dan pertanyaan schema.
- `docs/scope/scope.md`, fitur 14 (Selesai ketika dan Data), fitur 15 (sesi dan credential), batas dan keputusan, dan build approach Tracer Bullet.
- `docs/rules/security.md`, backup yang dapat dipulihkan, pencabutan secret dan sesi, privilege minimum, secret terpisah, dan log tanpa credential.
- `docs/rules/database.md`, role terpisah, identifier berkualifikasi, dan larangan schema baru tanpa keputusan.
- `docs/rules/infrastructure.md`, image PostgreSQL proyek, volume `pgsql_data`, akses Docker setara root, dan prosedur upgrade major terpisah.
- `docs/rules/deployment.md`, langkah provisioning dan migration, rotasi password role, dan retensi log 30 hari.
- `docs/rules/testing.md`, bukti dengan komponen nyata, registry skenario, dan pembersihan sinyal suite nyata.
- Spec 0002 (image dan entrypoint PostgreSQL), 0004 (role dan privilege, diamandemen), 0005 (runner dan verifikasi riwayat), 0010 (tier, bundle, GATE-009), 0011 (pin dan hardening container), dan 0012 (topologi rujukan, network `data`, `.env.deploy`, readiness).
- `database/provision.ts`, `database/runner.ts`, `deploy/compose.yaml`, `.env.deploy.example`, `infrastructure/postgres/Dockerfile`, `infrastructure/postgres/docker-entrypoint.sh`, `scripts/serve.ts`, `scripts/doctor.ts`, `scripts/lib/gate.ts`, `scripts/lib/test-inventory.ts`, `tests/orchestration/database-real.ts`, `tests/orchestration/signal-cleanup.ts`, `tests/integration/database/provision.test.ts`, `tests/integration/database/health.test.ts`, dan `tests/integration/deployment/static.test.ts`.

**Practices & standards**:

- Backup yang tidak pernah dipulihkan belum terbukti; latihan restore berkala ke target terisolasi.
- RPO dan RTO sebagai sasaran yang diukur, bukan diasumsikan.
- Prinsip privilege minimum untuk credential job, dan pemisahan credential admin dari credential terjadwal.
- Backup lengkap ditandai berkas terakhir yang ditulis, dengan checksum SHA 256 yang dapat diverifikasi di mana pun salinan berada.
- Salinan di failure domain berbeda dengan enkripsi at rest dan penghapusan hanya lewat lifecycle.
- Rotasi credential sesudah pemulihan dari insiden.
- OWASP ASVS sebagai rujukan kontrol keamanan yang dapat diuji, sesuai aturan keamanan proyek.
