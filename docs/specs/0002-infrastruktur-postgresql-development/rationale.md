# Alasan infrastruktur PostgreSQL development

## Context

Scope fitur 3 berstatus `in-progress`: `docker-compose.yml` sudah mendefinisikan PostgreSQL 18, tetapi belum ada bukti container nyata, dan tiga syarat selesai belum punya keputusan: image CI yang dapat direproduksi, pemisahan credential admin dari runtime, dan cara membuktikan persistensi tanpa merusak data. Fitur 5, 6, 10, dan 2 bergantung pada server ini, jadi keputusan yang salah di sini merambat ke seluruh alur database.

Pemeriksaan repo menemukan dua celah. `.env.infrastructure.example` disebut oleh README, aturan infrastruktur, dan `.gitignore`, tetapi file itu tidak ada. Perubahan lokal pada `.gitignore` yang belum di commit menghapus pola `.env.*`, sehingga `.env.infrastructure` berisi password superuser dapat ikut ter commit.

Ada juga batasan dari aturan proyek: Compose root hanya untuk infrastruktur, migration dan seed tidak boleh lewat `initdb.d`, credential admin terpisah dari runtime, penghapusan volume tidak dijalankan otomatis, dan bukti yang dilewati tidak boleh dilaporkan lulus. Mesin pengembang adalah Mac arm64 dengan Docker 29.8 dan Compose v5.5.1, sedangkan CI kemungkinan amd64. Di mesin itu juga tertinggal container dan volume uji dari run sebelumnya yang masih berjalan, tanda bahwa resource uji tanpa pembersihan terjamin mudah menumpuk.

Anda menetapkan bahwa server development harus berbasis Oracle Linux 10 slim dan image yang sama menjadi dasar production. Image PostgreSQL resmi tidak menyediakan varian Oracle Linux.

## Options considered

### Perbaiki di tempat dengan image resmi Debian

Pertahankan `postgres:18`, tambahkan pin digest untuk CI, file contoh env, perbaikan `.gitignore`, dan suite uji. Kelebihannya: perubahan paling kecil, entrypoint dirawat upstream, dokumentasi komunitas luas. Kekurangannya: OS dasar berbeda dari Oracle Linux yang Anda tetapkan untuk production, sehingga dev dan production menyimpang di paket, glibc, dan path. (basis: `docs/rules/infrastructure.md`, image resmi yang dipakai saat ini)

### Ganti langsung dengan image Oracle Linux 10 slim dan paket PGDG (dipilih)

Dockerfile proyek di atas `oraclelinux:10-slim`, paket `postgresql18-server` dari repo PGDG, entrypoint minimal milik proyek. Kelebihannya: paritas dev, CI, dan production; PGDG merilis patch cepat dan menyediakan paket EL 10 untuk x86_64 dan aarch64; versi paket dapat dikunci tepat. Kekurangannya: proyek merawat Dockerfile dan entrypoint sendiri, dan patch hanya masuk lewat rebuild. (basis: jawaban Anda, pemeriksaan repo PGDG pada References)

### Oracle Linux 10 slim dengan paket AppStream

Dockerfile yang sama, tetapi PostgreSQL dari AppStream Oracle Linux. Kelebihannya: paket datang dari vendor OS yang sama. Kekurangannya: stream PostgreSQL 18 di EL 10 dapat terlambat atau belum tersedia, dan jadwal patch mengikuti vendor, bukan komunitas PostgreSQL. (basis: pola distribusi paket AppStream pada keluarga RHEL)

Strangler (jalan berdampingan lalu pindah bertahap) tidak diperlukan: belum ada data dev yang hidup di volume proyek, dan volume lama dibiarkan utuh sehingga revert satu commit sudah cukup sebagai rollback.

## Rationale

Image resmi Debian adalah pilihan dengan perawatan paling ringan, dan tanpa syarat paritas production saya akan merekomendasikannya. Syarat itu ada: Anda menetapkan Oracle Linux sebagai dasar production, dan menjalankan dev di OS berbeda berarti perbedaan paket, glibc, dan path baru terlihat saat deployment. Karena PGDG menyediakan PostgreSQL 18 untuk EL 10 di kedua arsitektur, image ini berjalan native di Mac Anda dan di CI amd64, sehingga biaya utamanya tinggal merawat entrypoint. Biaya itu kecil karena aturan proyek sudah melarang `initdb.d`, jadi sebagian besar fitur entrypoint resmi memang tidak dipakai. (basis: `docs/rules/infrastructure.md`, `docs/rules/database.md`)

Entrypoint minimal dengan inisialisasi lewat staging dan `postgres --single` menutup dua kegagalan yang umum pada image database: healthcheck yang lulus saat server sementara masih inisialisasi, dan cluster setengah jadi setelah proses terputus. Collation builtin `C.UTF-8` dipilih karena base image akan diperbarui berkala; collation libc yang berubah bersama glibc dapat membuat index teks tidak konsisten tanpa peringatan. (basis: dokumentasi `initdb` PostgreSQL 18, stabilitas collation antar versi glibc)

Pin mengikuti aturan yang sudah Anda tulis: major floating di dev agar patch keamanan mudah didapat, digest dan versi paket tepat di test serta CI agar bukti dapat diulang. Suite terisolasi dengan project unik dan `system_identifier` membuktikan persistensi named volume tanpa menulis data, sekaligus menjamin volume dev tidak pernah tersentuh, sesuai larangan penghapusan volume otomatis. Pola `.env.*` di `.gitignore` dikembalikan karena password superuser yang masuk riwayat Git tidak dapat ditarik kembali dengan aman. (basis: `docs/rules/security.md`, `docs/rules/testing.md`)

## References

**Project sources**: `AGENTS.md`, `docs/scope/scope.md` fitur 3, `docs/rules/infrastructure.md`, `docs/rules/database.md`, `docs/rules/security.md`, `docs/rules/testing.md`, `docs/rules/development-commands.md`, `docker-compose.yml`, `scripts/doctor.ts` (pemeriksaan role superuser), spec [0001](../0001-struktur-aplikasi-dependency/index.md).

**Practices & standards**: least privilege untuk credential database; secret di luar image dan version control; verifikasi rantai pasok dengan GPG dan pin digest; build yang dapat direproduksi dari digest indeks multi arch; collation builtin untuk stabilitas antar versi glibc; sinyal fast shutdown untuk PostgreSQL di container; resource uji terisolasi dengan cleanup berpagar.

**Links** (diverifikasi web saat sesi desain):

- [Paket repo PGDG per distribusi](https://yum.postgresql.org/repopackages/)
- [Direktori paket PostgreSQL 18 untuk keluarga RHEL](https://download.postgresql.org/pub/repos/yum/18/redhat/)
- [Pembaruan key GPG repo PGDG](https://yum.postgresql.org/news/pgdg-rpm-repo-gpg-key-update/)
- [initdb PostgreSQL 18: locale provider builtin dan data checksums](https://www.postgresql.org/docs/18/app-initdb.html)
- [Image resmi Oracle Linux di Docker Hub](https://hub.docker.com/_/oraclelinux)
- [Catatan komunitas: EL 10 tanpa module PostgreSQL](https://github.com/Linuxfabrik/lfops/issues/370)
