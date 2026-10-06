# Keamanan aplikasi

Keamanan menjadi bagian desain, implementasi, testing, dan operasi. Gunakan pertahanan berlapis untuk mengurangi peluang serangan dan membatasi dampaknya; tidak ada konfigurasi tunggal yang menjamin aplikasi kebal. Aturan ini berlaku bagi frontend, backend, worker, database, dan tooling bersama [workflow development](development-workflow.md).

## Desain fitur dan batas kepercayaan

Saat `/scope` dan `/architect`, identifikasi data sensitif, siapa yang boleh mengaksesnya, endpoint publik, batas antarproses, dan kemungkinan penyalahgunaan fitur. Specs mencatat model autentikasi, aturan otorisasi, schema/role database, kebijakan data, serta skenario serangan yang perlu dibuktikan.

Gunakan OWASP ASVS sebagai rujukan kontrol yang dapat diuji. Pilih kontrol sesuai fitur dan catat bukti; sekadar menggunakan framework, SDK, HTTPS, atau memisahkan schema belum membuktikan bahwa kontrol diterapkan.

## Kontrol minimum dan pembuktiannya

| Risiko | Aturan implementasi | Bukti yang diperlukan |
| --- | --- | --- |
| Akses data pengguna lain atau eskalasi hak | Backend menolak akses secara default dan memeriksa permission, kepemilikan objek, serta tenant bila ada pada setiap operasi. Role/owner tidak diambil dari payload yang tidak dipercaya. | Pengguna A tidak dapat membaca/mengubah data B; pengguna biasa tidak dapat menjalankan operasi admin. |
| SQL injection dan mass assignment | SQL memakai parameter Bun.SQL; identifier dinamis memakai allowlist. Request memakai schema dan field yang diizinkan, kemudian response dipetakan eksplisit. | Input berbahaya menjadi nilai data atau ditolak; field tambahan tidak mengubah role/owner/status yang dilindungi. |
| Pencurian atau penyalahgunaan sesi | Token sesi dibuat dengan sumber acak kriptografis, mempunyai expiry, dapat dicabut, dan diganti saat login atau perubahan hak. | Sesi kedaluwarsa, dicabut, dan sebelum rotasi ditolak; logout dan reset password berlaku di backend. |
| CSRF dan origin palsu | Operasi yang mengubah data dengan autentikasi cookie memakai perlindungan CSRF serta validasi origin yang sesuai. GET tidak mengubah data. | Request perubahan data tanpa bukti CSRF atau dari origin yang tidak diizinkan ditolak. |
| XSS dan clickjacking | Gunakan binding/sanitization Angular, hindari HTML tidak dipercaya dan bypass sanitization; terapkan CSP serta pembatasan frame pada respons dokumen frontend. | Payload HTML tidak dieksekusi; CSP tetap mendukung theme/UI dan deployment yang digunakan. |
| Brute force dan konsumsi resource berlebihan | Batasi percobaan login/reset serta endpoint mahal, ukuran body/upload, pagination, durasi query/request, concurrency, dan antrean worker. | Kelebihan batas ditolak secara terkontrol; k6 mengukur kapasitas dan pemulihan sesuai specs. |
| File berbahaya, path traversal, dan SSRF | Upload memakai batas ukuran/jenis, nama penyimpanan dari server, dan lokasi yang tidak dapat mengeksekusi kode. Akses URL keluar memakai allowlist serta pemeriksaan redirect/DNS ketika fitur menggunakannya. | File/path/URL terlarang ditolak dan tidak menjangkau filesystem atau jaringan internal yang dilarang. |
| Kebocoran data dan kesalahan konfigurasi | Response error tidak menampilkan stack, SQL, atau secret; log disaring. TLS, role minimum, secret terpisah, dan dependency terkunci diterapkan. | Tidak ada kredensial pada bundle, response, log, laporan, atau artefak; role tidak dapat mengakses area yang dilarang. |

Auth guard frontend hanya membantu navigasi. Guard tersebut tidak menggantikan pemeriksaan izin backend. Pengujian mencakup akses langsung ke API melalui SDK maupun request HTTP di luar frontend.

## Autentikasi dan sesi browser

Untuk aplikasi Angular ini, default yang disarankan adalah sesi opaque yang disimpan di server, dikirim melalui cookie `HttpOnly`, `Secure` di production, dan `SameSite` eksplisit sesuai alur. Model final, expiry, rotasi, logout, pemulihan akun, serta kebutuhan MFA ditetapkan dalam specs autentikasi sebelum implementasi. Jangan memilih JWT hanya untuk menghindari penyimpanan sesi; jika diperlukan oleh integrasi, desain validasi dan pencabutannya juga harus jelas.

Simpan hash token sesi/reset di `auth`, bukan token mentah. Jangan menyimpan session ID, access/refresh token, atau password dalam `localStorage`/`sessionStorage`. Penggunaan cookie aman tetap memerlukan perlindungan CSRF; `SameSite` saja bukan pengganti semua pemeriksaan CSRF.

Password memakai hash Argon2id melalui API native async `Bun.password`, dengan parameter yang memenuhi rujukan keamanan dan diuji terhadap kapasitas runtime. Jangan mengenkripsi password untuk dapat dibaca kembali. Token reset sekali pakai, dibatasi waktu, dan respons login/pemulihan tidak membocorkan keberadaan akun. Perubahan credential atau hak akses mempertimbangkan pencabutan sesi.

Untuk production, prefer cookie dengan prefix `__Host-` jika topologi memungkinkan: `Secure`, `Path=/`, tanpa `Domain`. Development HTTP lokal memakai konfigurasi cookie yang dinyatakan khusus development; konfigurasi production tidak boleh diam-diam menonaktifkan `Secure`.

Alur pertama akses pengguna ([spec 0014](../specs/0014-akses-pengguna-lifecycle-sesi/index.md)) menerapkan aturan ini sebagai sesi opaque di schema `auth`:

- Cookie production `__Host-foundation_session` dengan `Path=/; Secure; HttpOnly; SameSite=Strict`, tanpa `Domain`, `Expires`, atau `Max-Age`. Development memakai `foundation_session` tanpa `Secure` karena berjalan di HTTP lokal. Nama dan atribut ditentukan mode komposisi `createApp`, bukan environment, sehingga production tidak dapat mematikan `Secure`.
- Token sesi 32 byte acak hanya ada di `Set-Cookie`; database menyimpan SHA 256 nya. Sesi berakhir 30 menit sesudah tidak aktif dan paling lama 12 jam sesudah dibuat, dengan waktu dari `now()` PostgreSQL. Masuk lagi mengganti sesi yang dibawa request, satu akun paling banyak mempunyai 10 sesi aktif, dan sesi yang dicabut tidak pernah aktif lagi.
- Route yang mengubah data menolak dengan 403 request tanpa `Origin` yang sama persis dengan origin yang diizinkan (`PUBLIC_ORIGIN`) atau dengan `Sec-Fetch-Site` selain `same-origin`. Masuk hanya menerima `Content-Type: application/json`, dan kedua route `DELETE` wajib membawa header `X-CSRF-Token` yang sama dengan token CSRF sesi (HMAC dari token sesi, tidak disimpan). Penolakan itu terjadi di guard `onRequest` plugin auth sebelum body diurai, karena hanya `onRequest` di Elysia yang dapat menjawab sebelum body diurai tanpa menjalankan handler.
- Password memakai Argon2id `m=19456,t=2,p=1` lewat `Bun.password`, minimal 15 karakter saat ditetapkan operator. Masuk dibatasi 10 percobaan per 15 menit per akun di database bersama (kunci dari email ternormalisasi, ada atau tidak akunnya), paling banyak 4 verifikasi password berjalan per proses dengan antrean 12, dan 30 request per menit per alamat client di edge. Jawaban masuk yang gagal sama untuk akun yang ada dan yang tidak ada.
- Log event `auth` mencatat masuk, keluar, pencabutan sesi, dan penolakan origin atau CSRF dengan `requestId` request nya, tanpa email, password, cookie, atau token. Akun hanya dibuat, diganti password nya, dan dicabut sesinya oleh operator lewat `database/accounts.ts` di image runner, menurut [aturan deployment](deployment.md); restore dan insiden mencabut seluruh sesi menurut [aturan backup](backup.md).

## HTTP, Angular, dan Elysia

- Gunakan HTTPS pada akses production; terapkan HSTS setelah topologi TLS siap. Header keamanan dokumen frontend ditangani oleh server/reverse proxy yang mengirim dokumen tersebut, bukan hanya middleware backend API.
- CORS hanya mengizinkan origin yang dinyatakan; jangan memakai wildcard untuk request credential. CORS bukan kontrol autentikasi atau penghalang client nonbrowser.
- Rate limit login dan operasi mahal mempertimbangkan identitas akun serta sumber request. Pada beberapa container, koordinasikan limit dengan penyimpanan/edge bersama. Jangan mempercayai header IP forwarding dari client tanpa proxy yang dipercaya.
- Gunakan schema Elysia untuk request dan response, batas ukuran dan timeout eksplisit, serta error yang konsisten. Periksa cakupan dan urutan hook/plugin agar route sensitif benar-benar terlindungi.
- SDK generated tidak dianggap validasi keamanan di server. Security scheme OpenAPI harus sesuai perilaku nyata, dan alur SDK harus membawa cookie/token sesuai model yang dipilih.
- Gunakan CSP dan Trusted Types ketika sesuai integrasi Angular/library. Hindari `bypassSecurityTrust*`, eval, atau HTML dari input tanpa keputusan dan verifikasi yang jelas dalam specs.
- Endpoint debug, metrics, administrasi, dan UI OpenAPI di production mempunyai kebijakan akses eksplisit. Ekspor spec lokal tetap bekerja tanpa membuka route bisnis sebagai publik.
- Pada topologi deployment rujukan (spec 0012), edge nginx yang mengirim dokumen frontend menerapkan header dokumen: `Content-Security-Policy` tanpa script inline dengan Trusted Types (policy `angular`, `angular#bundler`, dan `angular#components`), HSTS, `nosniff`, `Referrer-Policy`, dan larangan frame. Jawaban `/api/` mendapat header API sendiri, tanpa CORS karena frontend dan API berbagi origin. Edge mengosongkan header alamat dan skema client sebelum meneruskan request, jadi backend dan fitur berikutnya tidak menurunkan alamat atau skema client dari header request. Edge meneruskan `Host` pilihan client apa adanya, jadi `Host` juga tidak dipercaya: URL absolut seperti tautan reset password, redirect, dan tautan email dibangun hanya dari konfigurasi. Nilai CSP hanya berubah lewat spec 0012 dengan alasan tertulis, tidak dilonggarkan agar test lulus. Kebijakan endpoint production, rotasi secret, sertifikat TLS, dan izin file key ada di `docs/rules/deployment.md` ([aturan deployment](deployment.md)).

## Database, worker, dan deployment

Ikuti [aturan database](database.md): schema `common`, `users`, dan `auth`, identifier berkualifikasi schema, serta role migration terpisah dari role runtime. Schema adalah pengelompokan domain; privilege SQL yang menentukan siapa dapat mengaksesnya. Jangan menganggap pemisahan schema sebagai isolasi tenant.

Backend dan setiap worker menggunakan credential serta privilege minimum sesuai tugas. Runtime tidak memakai superuser, tidak mempunyai DDL, dan tidak menjadi pemilik schema/tabel. Migration hanya dijalankan oleh runner terpisah. Uji pula penolakan akses database, bukan hanya keberhasilan query yang diizinkan.

Job worker mempunyai schema tervalidasi, identitas/otorisasi sumber yang sesuai, batas retry, timeout, concurrency, dan perilaku idempotensi. File/URL pada job tetap dianggap input yang perlu diperiksa. Jangan memasukkan password/token mentah ke antrean atau log job.

Container berjalan sebagai user yang diperlukan tanpa privilege berlebih, memakai batas resource, dan tidak memuat secret di image. Production memisahkan akses database/antrean dari jaringan publik. Reverse proxy atau layanan edge dapat membatasi trafik masuk; mitigasi beban jaringan besar juga memerlukan kontrol infrastruktur. Image frontend, backend, dan runner migration dibangun dari root monorepo dengan konteks daftar izin, base image yang dipin digest, user numerik, dan tanpa `ARG` atau `ENV` credential; topologi `deploy/compose.yaml` hanya mempublikasikan edge, dan setiap service hanya menerima credential miliknya, menurut `docs/rules/deployment.md`. Paket OS image belum dipindai pemindai kerentanan, dan status kesiapan release bukan izin deploy.

Secret berasal dari environment/secret manager, terpisah per layanan dan environment, dengan rencana rotasi. `.env` tidak masuk Git; `.env.example` hanya nama variable dan contoh tanpa secret. Konfigurasi yang dikompilasi ke Angular tidak memuat URL berkredensial, password database, atau kunci privat.

## Verifikasi dan operasi

Masukkan skenario keamanan relevan ke registry test sesuai [aturan testing](testing.md): otorisasi negatif, validasi input, lifecycle sesi, CSRF, akses role database, limit, dan batas worker/upload bila fitur memakainya. Playwright membuktikan alur browser; integration membuktikan backend serta privilege PostgreSQL; k6 membuktikan perilaku pada batas beban yang disepakati.

CI memeriksa secret yang tidak sengaja disimpan, dependency berisiko, dan kontrol kode yang relevan. Gunakan scanner yang versinya dipin dan laporkan temuan serta cakupannya; tidak ditemukannya masalah oleh scanner bukan bukti seluruh aplikasi aman. Temuan yang memengaruhi kandidat release diselesaikan atau dicatat dengan keputusan risiko yang jelas, tanpa memalsukan status test.

Tier keamanan gate CI (spec 0010 AC-5) adalah `bun run test:ci:security`, yang menjalankan `bun run check:security` (`tests/orchestration/security-scan.ts`) dengan tiga pemindai:

- gitleaks dari image yang dipin tag dan digest indeks di `tests/security/scanners.json`, memindai seluruh riwayat Git yang dapat dijangkau dengan konfigurasi tetap `tests/security/gitleaks.toml`. Konfigurasi itu memakai aturan bawaan ditambah satu allowlist untuk checksum SHA 256 dan fingerprint key PGP pada bukti test di `docs/testing/evidence/<NNNN>/*.json`; bentuknya dikunci GATE-007. Checkout dangkal membuat gitleaks `not_run`. Perubahan yang belum masuk commit tidak dipindai gitleaks. Git di dalam container membaca atribut dari pohon kosong (`GIT_ATTR_SOURCE`), sehingga `.gitattributes` di repository, misalnya `-diff` atau `binary`, tidak dapat membuat file terbaca biner dan terlewat dari pemindaian.
- `bun audit` dari Bun versi `engines.bun`, di folder sementara yang hanya berisi salinan `package.json` dan `bun.lock`. Advisory `high` dan `critical` gagal, `moderate` dan `low` dilaporkan tanpa menggagalkan, dan severity lain gagal. Database advisory bersifat langsung, sehingga hasil dapat berubah tanpa perubahan kode.
- actionlint dari image yang dipin di `tests/security/scanners.json`, dengan konfigurasi kosong `tests/security/actionlint.yaml` atas setiap file `.github/workflows/*.yml` dan `*.yaml`; setiap temuan gagal.

Ambang dan konfigurasi tidak dapat dilemahkan lewat environment, argumen, atau file milik repository: `.gitleaks.toml`, `.gitleaksignore`, komentar `gitleaks:allow`, `.github/actionlint.yaml`, dan `.github/actionlint.yml` tidak berpengaruh, dan keberadaan file itu di checkout menggagalkan `check:security`. `.gitattributes` tetap boleh ada untuk keperluan lain, tetapi atributnya tidak dipakai saat gitleaks membaca riwayat. Satu satunya jalan pengecualian adalah entri bertanggal di `tests/security/exceptions.json` yang masuk lewat review: secret dengan fingerprint `<commit>:<file>:<rule>:<line>`, alasan, pemilik, dan tanggal dicatat; dependency dengan advisory, paket, alasan, pemilik, tanggal dicatat, dan `expires` paling lama 90 hari setelah dicatat. Pengecualian kedaluwarsa gagal, dan pengecualian tanpa temuan dilaporkan sebagai tidak terpakai. Secret nyata dirotasi atau dihapus, bukan dikecualikan.

Container pemindai berjalan tanpa jaringan, dengan filesystem hanya baca, user non root, tanpa capability, `no-new-privileges`, batas proses, memory, dan CPU, serta nama acak `foundation-security-<pemindai>-<12 heksadesimal>` yang dihapus pada setiap jalur keluar. Pemindai yang tidak dapat berjalan dicatat `not_run` dan membuat tier gagal. Hasil ditulis ke `.local/feature-11/security.json` dengan nama, versi, image beserta digest, cakupan, jumlah temuan per kebijakan, dan field temuan yang dinamai spec 0010 saja, tanpa nilai secret, potongan baris, nama author, atau email; laporan gate merangkumnya. Pin pemindai diperbarui manual dengan membaca digest indeks lewat `docker buildx imagetools inspect <image>:<tag>`.

Log keamanan mencatat kegagalan login, penolakan akses, perubahan hak, dan aksi sensitif menggunakan identitas serta correlation ID yang sesuai. Jangan merekam body/password/cookie/token mentah. Tentukan alert untuk lonjakan kegagalan atau penyalahgunaan, retensi data, backup yang dapat dipulihkan, dan langkah pencabutan secret/sesi ketika insiden terjadi.

Backup database, restore, dan prosedur insiden mengikuti `docs/rules/backup.md` ([aturan backup](backup.md), spec 0013). Job backup memakai role `foundation_backup` yang tidak dapat menulis atau membuat objek, tetapi sesudah `SET ROLE pg_read_all_data` membaca seluruh data dan verifier password SCRAM semua role di `pg_authid`. Karena itu `.env.backup` dan file backup diperlakukan setingkat admin untuk kerahasiaan: file 0600 di folder 0700, enkripsi at rest, salinan di luar host dengan identitas terpisah untuk unggah, baca, dan hapus, serta password acak `openssl rand -hex 24` untuk setiap role. Restore selalu masuk ke target baru dengan password role baru dan menjalankan `pg_restore` sebagai superuser; checksum di samping dump hanya mendeteksi kerusakan, sehingga operator membandingkan sha256 dump dengan catatan independen sebelum restore. Script backup dan restore hanya mencetak pesan kategori tetap, karena libpq mencetak ulang potongan password pada connection string yang rusak. Kebocoran `.env.backup`, `.env.deploy`, atau backup memicu rotasi keempat role menurut prosedur insiden.

Laporan release mencatat kontrol yang diuji, temuan yang belum selesai, batas pengujian, dan hasil pemulihan jika masuk cakupan. Jangan menyatakan tahan serangan hanya karena unit test atau build lulus.

## Referensi

- [OWASP ASVS](https://owasp.org/projects/asvs).
- [Otorisasi OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
- [Sesi OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- [Perlindungan CSRF OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- [Penyimpanan password OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- [SQL injection OWASP](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html).
- [Keamanan REST OWASP](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).
- [Upload file OWASP](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).
- [Keamanan Angular](https://angular.dev/best-practices/security).
