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

## HTTP, Angular, dan Elysia

- Gunakan HTTPS pada akses production; terapkan HSTS setelah topologi TLS siap. Header keamanan dokumen frontend ditangani oleh server/reverse proxy yang mengirim dokumen tersebut, bukan hanya middleware backend API.
- CORS hanya mengizinkan origin yang dinyatakan; jangan memakai wildcard untuk request credential. CORS bukan kontrol autentikasi atau penghalang client nonbrowser.
- Rate limit login dan operasi mahal mempertimbangkan identitas akun serta sumber request. Pada beberapa container, koordinasikan limit dengan penyimpanan/edge bersama. Jangan mempercayai header IP forwarding dari client tanpa proxy yang dipercaya.
- Gunakan schema Elysia untuk request dan response, batas ukuran dan timeout eksplisit, serta error yang konsisten. Periksa cakupan dan urutan hook/plugin agar route sensitif benar-benar terlindungi.
- SDK generated tidak dianggap validasi keamanan di server. Security scheme OpenAPI harus sesuai perilaku nyata, dan alur SDK harus membawa cookie/token sesuai model yang dipilih.
- Gunakan CSP dan Trusted Types ketika sesuai integrasi Angular/library. Hindari `bypassSecurityTrust*`, eval, atau HTML dari input tanpa keputusan dan verifikasi yang jelas dalam specs.
- Endpoint debug, metrics, administrasi, dan UI OpenAPI di production mempunyai kebijakan akses eksplisit. Ekspor spec lokal tetap bekerja tanpa membuka route bisnis sebagai publik.

## Database, worker, dan deployment

Ikuti [aturan database](database.md): schema `common`, `users`, dan `auth`, identifier berkualifikasi schema, serta role migration terpisah dari role runtime. Schema adalah pengelompokan domain; privilege SQL yang menentukan siapa dapat mengaksesnya. Jangan menganggap pemisahan schema sebagai isolasi tenant.

Backend dan setiap worker menggunakan credential serta privilege minimum sesuai tugas. Runtime tidak memakai superuser, tidak mempunyai DDL, dan tidak menjadi pemilik schema/tabel. Migration hanya dijalankan oleh runner terpisah. Uji pula penolakan akses database, bukan hanya keberhasilan query yang diizinkan.

Job worker mempunyai schema tervalidasi, identitas/otorisasi sumber yang sesuai, batas retry, timeout, concurrency, dan perilaku idempotensi. File/URL pada job tetap dianggap input yang perlu diperiksa. Jangan memasukkan password/token mentah ke antrean atau log job.

Container berjalan sebagai user yang diperlukan tanpa privilege berlebih, memakai batas resource, dan tidak memuat secret di image. Production memisahkan akses database/antrean dari jaringan publik. Reverse proxy atau layanan edge dapat membatasi trafik masuk; mitigasi beban jaringan besar juga memerlukan kontrol infrastruktur.

Secret berasal dari environment/secret manager, terpisah per layanan dan environment, dengan rencana rotasi. `.env` tidak masuk Git; `.env.example` hanya nama variable dan contoh tanpa secret. Konfigurasi yang dikompilasi ke Angular tidak memuat URL berkredensial, password database, atau kunci privat.

## Verifikasi dan operasi

Masukkan skenario keamanan relevan ke registry test sesuai [aturan testing](testing.md): otorisasi negatif, validasi input, lifecycle sesi, CSRF, akses role database, limit, dan batas worker/upload bila fitur memakainya. Playwright membuktikan alur browser; integration membuktikan backend serta privilege PostgreSQL; k6 membuktikan perilaku pada batas beban yang disepakati.

CI memeriksa secret yang tidak sengaja disimpan, dependency berisiko, dan kontrol kode yang relevan. Gunakan scanner yang versinya dipin dan laporkan temuan serta cakupannya; tidak ditemukannya masalah oleh scanner bukan bukti seluruh aplikasi aman. Temuan yang memengaruhi kandidat release diselesaikan atau dicatat dengan keputusan risiko yang jelas, tanpa memalsukan status test.

Log keamanan mencatat kegagalan login, penolakan akses, perubahan hak, dan aksi sensitif menggunakan identitas serta correlation ID yang sesuai. Jangan merekam body/password/cookie/token mentah. Tentukan alert untuk lonjakan kegagalan atau penyalahgunaan, retensi data, backup yang dapat dipulihkan, dan langkah pencabutan secret/sesi ketika insiden terjadi.

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
