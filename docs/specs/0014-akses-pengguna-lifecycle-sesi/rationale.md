# Rationale: Akses pengguna dan lifecycle sesi

## Context

> Catatan premis: topik "akses pengguna dan lifecycle sesi" mencakup beberapa keputusan yang dapat dibangun terpisah (masuk dan keluar, registrasi, profil, pemulihan akun, MFA, peran). Scope sendiri meminta topik ini dipecah menjadi alur kecil sebelum implementasi. Spec ini memutuskan alur pertama saja: masuk dan keluar dengan email dan password, identitas pemanggil, daftar dan pencabutan sesi milik sendiri, perintah operator, dan hook backup spec 0013. Alur lain menjadi tindak lanjut spec ini, tidak didaftarkan sebagai fitur scope baru. Pola kegagalan "membangun auth sendiri" juga berlaku di sini: aturan proyek sudah memilih sesi opaque di server, `Bun.password`, dan SQL tanpa ORM, sehingga risikonya ditangani dengan ruang lingkup kecil, kontrol yang mengikuti cheat sheet OWASP, test negatif pada komponen nyata, dan review independen pada workflow GA, bukan dengan menambah layanan auth.

Fitur 15 di scope berada di bagian *Ditunda* karena belum ada produk yang membutuhkan identitas. Pemilik kini meminta semua fitur scope diselesaikan dan mendelegasikan keputusan desain. Selesai ketika: batas tiap alur, permission, dan model sesi disepakati; akses lintas pengguna ditolak backend; expiry, revocation, rotasi, logout, CSRF, validasi input, serta batas percobaan dibuktikan sesuai cakupan; UI tidak menyimpan token di browser storage; credential tidak bocor pada response atau log. Data: identitas bisnis dan profil di `users`; credential, hash token, sesi, serta otorisasi di `auth`.

Keadaan saat ini (dibaca dari kode dan probe pada 2026-10-06):

- Schema `users` dan `auth` ada tetapi kosong; hanya migration `0001-common-metadata-comment.sql` yang ada. `foundation_backend` hanya membaca `common.schema_migrations`, tanpa default grant ke tabel baru (spec 0004 AC-4: grant tabel ditambahkan lewat migration fitur pemiliknya). Runner spec 0005 menerima satu statement per file dan menjalankan seed sebagai `foundation_owner` sesudah semua migration terapan.
- Komposisi production `createApp` hanya memasang route health; OpenAPI dan route development hanya di komposisi development (spec 0012). Backend membatasi body 1.024 byte dan edge `client_max_body_size 1k`.
- Edge mengosongkan semua header alamat client sebelum meneruskan ke backend dan meneruskan `Host` client apa adanya, sehingga backend tidak dapat mengenali alamat client dan tidak boleh membangun URL dari `Host` (aturan keamanan dan spec 0012).
- Checker OpenAPI spec 0008 adalah allow list: parameter `cookie` ditolak, tetapi security scheme `apiKey` dengan `in: cookie` diterima dan sudah dibuktikan generator SDK pada fixture `subset-full.json`; nullable ditolak; response 2xx selain 204 wajib `$ref`.
- READY-007 (spec 0006) dan DEP-006 (spec 0012) menegaskan navigasi production hanya berisi Beranda dan tidak ada request `/api/` saat `/` dan `/kesiapan` dibuka.
- Spec 0013 meninggalkan *Hook fitur 15*: perintah pencabutan seluruh sesi untuk restore dan insiden, skenario backup baru, keputusan apakah sesi ikut backup dan apakah hash password yang bocor memicu reset paksa, keputusan enkripsi sisi client dan keaslian backup, dan batas row level security.
- Fitur 16 (pekerjaan latar belakang pertama) kemungkinan memakai data ini untuk membersihkan sesi dan penghitung percobaan, dengan role worker sendiri tanpa akses `auth` otomatis (aturan worker).

Kekuatan yang membatasi keputusan: aturan keamanan (sesi opaque, cookie `HttpOnly` dan `Secure` di production, `SameSite` eksplisit, CSRF selain `SameSite`, hash token di `auth`, Argon2id lewat `Bun.password` yang diuji terhadap kapasitas runtime, respons yang tidak membocorkan keberadaan akun, rate limit per akun dan per sumber tanpa mempercayai header alamat), aturan database (privilege minimum per tabel, tanpa schema baru, identifier berkualifikasi), aturan OpenAPI dan SDK (security scheme sesuai perilaku nyata, regenerasi setiap perubahan backend), aturan UI (komponen hanya dari `@ojiepermana/angular`), dan aturan testing (PostgreSQL nyata, Playwright lewat stack nyata, bukti jujur). Tanpa keputusan ini, tidak ada identitas untuk produk berikutnya dan langkah pencabutan sesi di runbook backup tetap tidak berlaku.

## Options considered

### Opsi 1: Sesi opaque di PostgreSQL dengan implementasi native Bun

Backend membuat token acak, menyimpan hash SHA 256 nya di `auth.sessions`, dan mengirim token lewat cookie `HttpOnly`. Password diverifikasi `Bun.password` Argon2id; CSRF dicegah origin, `SameSite=Strict`, dan token HMAC turunan token sesi. Akun dibuat operator lewat job runner. (basis: aturan keamanan bagian *Autentikasi dan sesi browser*, aturan Bun dan ElysiaJS tentang fasilitas native, OWASP Session Management Cheat Sheet)

**Pros**:
- Tanpa dependency, secret, atau layanan baru; memakai PostgreSQL, runner, edge, dan gate yang ada.
- Pencabutan instan dan nyata di server, termasuk pencabutan massal saat restore.
- Semua SQL dan privilege terlihat dan teruji per kolom.

**Cons**:
- Proyek bertanggung jawab atas setiap detail keamanan; satu kesalahan urutan pemeriksaan berdampak langsung.
- Setiap request terautentikasi membaca database.

### Opsi 2: Library auth yang di host sendiri

Library auth TypeScript yang mengelola sesi, password, dan tabel sendiri. (basis: pola kegagalan membangun auth sendiri)

**Pros**:
- Banyak kasus tepi sudah ditangani dan diuji komunitas.
- Jalur cepat ke OAuth, MFA, dan pemulihan akun kelak.

**Cons**:
- Library umum membawa skema tabel dan lapisan adapter atau ORM sendiri, bertentangan dengan SQL langsung tanpa ORM, pembagian `users` dan `auth`, serta grant per kolom.
- Dependency baru dengan permukaan besar yang harus dipin, diaudit, dan dibuktikan cocok dengan Elysia, edge, dan SDK generator.

### Opsi 3: Penyedia identitas terkelola

Login di layanan pihak ketiga (OIDC), backend hanya memverifikasi sesi atau token dari penyedia. (basis: membeli kemampuan yang bukan inti)

**Pros**:
- MFA, pemulihan akun, dan deteksi penyalahgunaan tersedia.
- Password tidak pernah disimpan proyek.

**Cons**:
- Memilih penyedia, akun, dan secret atas nama pemilik tanpa kebutuhan produk; tidak dapat diuji per push tanpa jaringan keluar, padahal backend tidak mempunyai egress (spec 0012).
- Checker OpenAPI menolak `oauth2` dan `openIdConnect`, dan topologi rujukan berubah.

### Opsi 4: Token bertanda tangan tanpa status (JWT) di cookie

Backend menandatangani klaim sesi; tidak ada tabel sesi. (basis: pola token tanpa status)

**Pros**:
- Tanpa baca database per request.
- Mudah dipakai beberapa layanan.

**Cons**:
- Pencabutan dan logout tidak nyata tanpa daftar tolak, padahal scope meminta revocation dan hook backup meminta pencabutan seluruh sesi; aturan keamanan melarang memilih JWT hanya untuk menghindari penyimpanan sesi.
- Membutuhkan kunci tanda tangan baru beserta rotasinya.

## Rationale

Scope dan aturan keamanan meminta pencabutan yang nyata (logout, revocation, perubahan credential, dan pencabutan massal sesudah restore), sehingga state sesi harus ada di server; itu langsung menyingkirkan Opsi 4. Opsi 3 menuntut penyedia dan jaringan keluar yang tidak dimiliki topologi dan checker, serta memilih vendor atas nama pemilik. Opsi 2 menarik untuk alur yang lebih kaya, tetapi bentrok dengan tiga keputusan proyek yang sudah berlaku (SQL tanpa ORM, pembagian schema, privilege per kolom) dan menambah dependency besar untuk alur yang kecil.

Opsi 1 memakai seluruh fondasi yang sudah terbukti: runner dengan role owner untuk akun operator, privilege per kolom lewat migration, edge yang sudah menjadi satu satunya pintu publik untuk batas per alamat, `Bun.password` yang sudah ditunjuk aturan, dan gate yang memindai credential. Risiko membangun sendiri ditekan dengan menyempitkan alur pertama, mengikuti kontrol OWASP satu per satu, dan menjadikan setiap kontrol skenario negatif di PostgreSQL nyata dan browser nyata. Token CSRF diturunkan dari token sesi dengan HMAC, sehingga tidak ada secret server baru untuk dirotasi dan tidak ada kolom tambahan.

## Keputusan agent atas delegasi pemilik

Pemilik proyek mendelegasikan keputusan desain ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"). Tidak ada manusia selama run. Percakapan desain dijalankan sebagai pertimbangan internal: setiap pertanyaan dicatat dengan pilihan, rekomendasi, dan pilihan akhir. Semua keputusan berikut diambil oleh agent pada 2026-10-06 atas delegasi tersebut, tanpa konfirmasi manusia.

Framing yang disimpulkan: mode FEATURE (kemampuan baru di atas stack yang ada, membaca kode yang harus diintegrasikan), platform web Angular dengan API Bun dan Elysia serta operasi CLI; stack dari `AGENTS.md`; build approach Tracer Bullet dari scope; workflow GA. Pemeriksaan "sudah dibangun" dan "visi produk" tidak berlaku: topik adalah keputusan spesifik yang belum dibangun. Tidak ada spec yang tumpang tindih untuk diperbarui atau digantikan; spec 0003, 0004, 0006, 0007, 0008, 0009 (literal SDK-005), 0012, dan 0013 diamandemen lewat catatan saat build. Pertanyaan schema `AGENTS.md` tidak ditanyakan ulang karena keputusannya sudah ada di scope (*Batas dan keputusan* dan baris Data fitur 15) dan `foundation.md` bagian 6 dan 9.

**Tahap kebutuhan**

1. **Batas alur pertama.** Pilihan: (a) masuk, keluar, identitas, daftar dan pencabutan sesi sendiri, perintah operator; (b) ditambah registrasi mandiri; (c) ditambah pemulihan akun lewat email. Rekomendasi dan pilihan: (a). Scope meminta alur kecil dan tidak ada produk yang membutuhkan registrasi publik; (c) membutuhkan infrastruktur email dan worker yang belum ada.
2. **Cara akun dibuat.** Pilihan: (a) perintah operator sebagai job image runner; (b) file seed berisi akun development; (c) endpoint admin HTTP. Dipilih (a): tanpa permukaan publik baru dan memakai credential operator yang sudah ada; (b) menaruh password di repository; (c) membutuhkan otorisasi admin yang belum dirancang (aturan deployment: admin tidak ada).
3. **Identifier masuk.** Pilihan: (a) email dan password; (b) username dan password; (c) magic link atau passkey. Dipilih (a): umum, cocok dengan identitas bisnis di `users`, tanpa email keluar; (c) membutuhkan email atau dukungan WebAuthn yang belum ada.
4. **Halaman.** Pilihan: (a) `/masuk` dan `/akun` (profil, sesi aktif, keluar); (b) `/masuk` dan tombol keluar di shell saja. Dipilih (a): sesi aktif adalah permukaan tempat akses lintas pengguna harus ditolak, dan `/akun` menjadi tempat identitas tanpa memanggil API dari shell.
5. **Peran.** Pilihan: (a) satu peran implisit pengguna, otorisasi berbasis kepemilikan; (b) tabel peran sekarang. Dipilih (a): tidak ada operasi yang membutuhkan peran; tabel peran tanpa pemakai menjadi data mati. Rotasi saat hak berubah berlaku saat peran ditambahkan.
6. **MFA.** Pilihan: (a) tindak lanjut; (b) TOTP sekarang. Dipilih (a): scope menyebut kebutuhan MFA belum diputuskan; password minimal 15 karakter memenuhi NIST SP 800-63B rev 4 untuk satu faktor.
7. **Ingat saya.** Pilihan: (a) tidak ada; (b) cookie persisten 30 hari. Dipilih (a): cookie sesi browser dan masa absolut 12 jam, sesuai rekomendasi OWASP untuk cookie non persisten.

**Tahap data**

8. **Entitas.** Pilihan: (a) `users.users`, `auth.password_credentials`, `auth.sessions`, `auth.sign_in_attempts`; (b) hash password di `users.users`; (c) penghitung percobaan di memori proses. Dipilih (a). (b) melanggar pembagian schema scope; (c) tidak berlaku lintas container dan hilang saat restart.
9. **Primary key.** Pilihan: (a) `uuid` dari `gen_random_uuid()`; (b) `bigint` identity; (c) `uuidv7()`. Dipilih (a): id sesi muncul di path dan daftar, sehingga angka berurutan memudahkan tebakan; (c) membocorkan waktu pembuatan lewat id (waktu sudah ditampilkan, tetapi tanpa alasan menambah sumber kedua).
10. **Penyimpanan hash token.** Pilihan: (a) SHA 256 heksadesimal `text` dengan CHECK; (b) `bytea`; (c) HMAC dengan pepper server. Dipilih (a): token 256 bit acak tidak dapat ditebak sehingga hash tanpa garam cukup (OWASP), bentuk heksadesimal mengikuti kolom `checksum` spec 0004, dan tidak ada ketidakpastian parameter biner `Bun.SQL`; (c) menambah secret tanpa manfaat untuk token acak.
11. **Email unik tanpa membedakan huruf.** Pilihan: (a) kolom ternormalisasi huruf kecil dengan `UNIQUE` dan CHECK; (b) extension `citext`; (c) index unik atas `lower(email)`. Dipilih (a): tanpa extension baru (butuh `CREATE EXTENSION`), dan email yang tersimpan sudah bentuk final. Email dibatasi ASCII terlihat agar `lower()` PostgreSQL dan normalisasi aplikasi selalu sama; email internasional menjadi tindak lanjut bila dibutuhkan.
12. **Representasi kedaluwarsa.** Pilihan: (a) kolom `expires_at` dan `idle_expires_at`; (b) dihitung dari `created_at`, `last_seen_at`, dan konstanta. Dipilih (a): job pembersihan fitur 16 cukup membaca kolom tanpa mengetahui konstanta, dan CHECK menjaga `idle_expires_at <= expires_at`.
13. **Pencabutan.** Pilihan: (a) `revoked_at` dan `revoked_reason`; (b) hapus baris. Dipilih (a): jejak audit alasan pencabutan, dan backend tidak membutuhkan `DELETE`.
14. **Retensi.** Pilihan: (a) baris tetap sampai job fitur 16, dengan kontrak role worker tertulis; (b) backend menghapus baris lama saat request. Dipilih (a): backend tetap tanpa `DELETE` pada sesi, dan pembersihan menjadi pekerjaan latar belakang yang sesuai fitur 16.
15. **Batas sesi per akun.** Pilihan: (a) 10 sesi aktif, yang paling lama tidak aktif dicabut; (b) tanpa batas dengan pagination daftar. Dipilih (a): daftar selalu kecil sehingga pagination tidak dibutuhkan, dan jumlah baris per akun terbatas. Advisory lock per akun menjaga batas saat masuk bersamaan.
16. **Hapus akun.** `ON DELETE CASCADE` dari `users.users` ke credential dan sesi; penghapusan akun sendiri menjadi tindak lanjut.
17. **Irisan migration.** Pilihan: (a) sembilan file satu statement di irisan pertama; (b) dibagi per irisan. Dipilih (a): model ini kecil dan utuh; runner mewajibkan satu statement per file.
18. **Konfirmasi model data.** Model pada tabel *Model data* spec diterima sebagai target (konfirmasi yang direkomendasikan), tanpa perubahan.

**Tahap stack dan alat**

19. **Pendekatan auth.** Opsi 1 sampai 4; dipilih Opsi 1, alasan di *Rationale*. Tidak ada alat baru, sehingga penawaran Agent Skills dan MCP (`internal/tool-discovery.md`) tidak dijalankan.
20. **Parameter hash password.** Pilihan: (a) Argon2id `m=19456,t=2,p=1`; (b) bawaan Bun 1.4.2 `m=65536,t=2,p=1`; (c) bcrypt. Rekomendasi dan pilihan: (a), konfigurasi minimum OWASP Password Storage Cheat Sheet. Probe: verifikasi 19,4 ms dan RSS proses sekitar 116 MiB sesudah 4 verifikasi bersamaan, sedangkan (b) 69,8 ms dan RSS sekitar 300 MiB sesudah 4 verifikasi bersamaan, terlalu dekat dengan batas 512 MiB container backend. Parameter tersimpan di string hash, sehingga kenaikan kelak lewat rehash saat masuk (tindak lanjut). (c) tidak sesuai aturan yang menunjuk Argon2id.
21. **Kebijakan password.** Pilihan: (a) 15 sampai 128 code point sesudah NFKC tanpa aturan komposisi; (b) 8 karakter; (c) 12 karakter dengan aturan komposisi. Dipilih (a): NIST SP 800-63B rev 4 mewajibkan minimal 15 karakter untuk password satu faktor dan menyarankan normalisasi Unicode; batas 128 menjaga body di bawah 1.024 byte. Saat masuk hanya batas 1 sampai 128, agar kebijakan baru tidak mengunci password lama.
22. **CSRF.** Pilihan: (a) origin dan `Sec-Fetch-Site`, `SameSite=Strict`, JSON wajib untuk masuk, dan token HMAC turunan token sesi pada header untuk `DELETE`; (b) double submit cookie bawaan Angular (`XSRF-TOKEN`); (c) origin saja. Dipilih (a): token terikat sesi tanpa penyimpanan dan tanpa secret baru, dikirim lewat parameter header yang dideklarasikan sehingga SDK membawanya tanpa interceptor. (b) membutuhkan nama cookie berbeda antara build development dan production dan cookie yang dapat dibaca JavaScript; (c) dinyatakan aturan keamanan tidak cukup.
23. **Atribut cookie.** Pilihan: (a) `__Host-` dengan `Secure` di production, nama tanpa prefix tanpa `Secure` di development, `HttpOnly`, `SameSite=Strict`, tanpa `Max-Age`; (b) nama yang sama di kedua mode; (c) `SameSite=Lax`. Dipilih (a): aturan keamanan meminta `__Host-` bila topologi memungkinkan dan konfigurasi development yang dinyatakan khusus; browser tidak menjamin cookie `Secure` di HTTP 127.0.0.1. Mode ditentukan `createApp`, bukan environment. (c) tidak dibutuhkan karena tidak ada navigasi masuk dari situs lain yang perlu membawa sesi.
24. **Masa berlaku.** Pilihan: (a) idle 30 menit dan absolut 12 jam; (b) idle 15 menit dan absolut 8 jam; (c) absolut 30 hari. Dipilih (a), sesuai tingkat 2 OWASP ASVS 4 untuk autentikasi satu faktor. (b) mengikuti tingkat 3 yang mengandaikan MFA; (c) tingkat 1 dan bertentangan dengan keputusan tanpa ingat saya.
25. **Batas percobaan.** Pilihan: (a) per kunci email 10 per jendela tetap 15 menit dihitung sebelum verifikasi, ditambah per alamat client di edge 30 per menit burst 10; (b) backoff eksponensial per akun; (c) CAPTCHA. Dipilih (a): penghitung di database bersama berlaku lintas container dan sama untuk email terdaftar dan tidak, sedangkan batas alamat hanya mungkin di edge karena backend tidak menerima alamat client. Jumlah tebakan per akun paling banyak 960 per hari, yang tidak berarti terhadap password minimal 15 karakter. (b) lebih rumit diuji dengan hasil serupa; (c) membutuhkan layanan pihak ketiga dan tidak dapat dibuktikan test otomatis tanpa melewatinya.
26. **Batas verifikasi per proses.** Pilihan: (a) 4 berjalan, antrean 12, tunggu 2.000 ms; (b) 4 tanpa antrean; (c) tanpa batas. Dipilih (a): memori Argon2id terbatas sekitar 76 MiB per proses, lonjakan kecil tetap dilayani, dan beban berlebih menjadi 503 terkontrol.
27. **References.** Level `sources`: project sources dan praktik bernama. Dua fakta penentu (minimum OWASP Argon2id dan minimal 15 karakter NIST SP 800-63B rev 4) diperiksa lewat pencarian web pada 2026-10-06, tetapi tidak ditulis sebagai tautan.

**Tahap API**

28. **Bentuk path.** Pilihan: (a) sumber daya `/api/auth/session` (POST, GET, DELETE) dan `/api/auth/sessions`; (b) kata kerja `/api/auth/sign-in` dan `/api/auth/sign-out`. Dipilih (a): satu path untuk sesi pemanggil, dan batas edge cukup satu kunci method dan path.
29. **Body identitas.** `AuthSession` memuat `user`, `session`, dan `csrfToken`, dipakai oleh masuk dan `getAuthSession`, sehingga frontend memulihkan token CSRF sesudah muat ulang tanpa browser storage.
30. **Model galat.** Pilihan: (a) satu model bernama `AuthError` dengan enum teks tetap; (b) schema inline per status. Dipilih (a): kontrak adapter spec 0009 butir 6 meminta model bernama untuk body galat yang dibutuhkan UI.
31. **Security scheme.** Pilihan: (a) `apiKey` di `cookie` bernama `sessionCookie` dengan nama cookie production dan deskripsi nama development; (b) tanpa security scheme. Dipilih (a): checker dan generator sudah menerimanya (probe), dan aturan meminta security sesuai perilaku nyata. Tabel *Aturan checker* tidak berubah.
32. **Operasi wajib.** Tiga entri untuk operasi 200 JSON; dua operasi 204 tidak dapat menjadi entri karena entri membutuhkan komponen response sukses.
33. **Origin yang diizinkan.** Pilihan: (a) `PUBLIC_ORIGIN` wajib di production, bawaan `http://127.0.0.1:8889` dan `http://localhost:8889` di development; (b) dari header `Host`. Dipilih (a): aturan keamanan melarang menurunkan URL dari `Host`.

**Tahap keamanan**

34. **Kepemilikan.** Setiap operasi sesi difilter `user_id` sesi tervalidasi; sesi orang lain menjawab 404 yang sama dengan id yang tidak ada, agar keberadaan sesi orang lain tidak terdeteksi.
35. **Role perintah operator.** Pilihan: (a) `foundation_migrator` lalu `foundation_owner` lewat runner, seperti seed; (b) role login baru `foundation_operator` dengan grant minimum; (c) `foundation_backend`. Dipilih (a): pemegang job runner sudah memegang credential migrator dan admin, sehingga role baru tidak mengurangi kuasa operator tetapi menambah provisioning, rotasi, dan langkah restore; spec 0013 butir 1 meminta job image runner tanpa backend. (c) memperluas backend dengan `INSERT` akun, yang tidak dibutuhkan alur web.
36. **Log keamanan.** Event `auth` dengan `accountKey` (16 karakter hash) alih alih email, sehingga serangan pada satu akun dapat dikorelasikan tanpa menyimpan email di log.
37. **Pembaruan sesi oleh GET.** Pilihan: (a) GET memperbarui `last_seen_at` dan `idle_expires_at` sebagai pencatatan sesi; (b) idle hanya diperpanjang oleh request yang mengubah data. Dipilih (a): (b) membuat sesi kedaluwarsa saat pengguna aktif membaca. Request GET lintas situs tidak membawa cookie `SameSite=Strict`, sehingga pencatatan ini tidak dapat dipicu situs lain.
38. **Hook backup spec 0013.** Butir 1 sampai 5 diputuskan seperti tabel *Keputusan hook backup*. Butir 4: enkripsi sisi client membutuhkan alat, kunci, dan rotasi di script backup dan restore, yang paling baik dipilih bersama platform penyimpanan; nilai sensitif baru dari fitur ini (hash token dan hash password) sudah tidak berguna atau mahal dipakai bila bocor, sehingga risiko yang ada tetap diterima dengan catatan.

**Tahap kasus tepi**

39. **Masuk bersamaan.** Advisory lock transaksi per akun; reservasi percobaan atomik lewat satu `INSERT ... ON CONFLICT ... RETURNING`.
40. **Database berhenti.** Semua route auth menjawab 503; halaman menampilkan teks `unavailable`. Readiness tetap milik route health.
41. **Jam.** Semua kedaluwarsa memakai `now()` PostgreSQL, sehingga beberapa container dengan jam berbeda tetap konsisten.
42. **Cookie ganda atau rusak.** Diperlakukan sebagai tanpa sesi (401), tidak memilih salah satu.
43. **Sesi dicabut saat halaman terbuka.** Request berikutnya 401; halaman mengosongkan state dan membuka `/masuk` dengan teks sesi berakhir.
44. **Variasi path untuk melewati batas edge.** Backend menolak path yang tidak sama persis (404), sehingga kunci path mentah di edge dan route backend selalu sama.

**Tahap halaman**

45. **Sumber desain.** Dari UI dan shell yang ada (spec 0007) dengan komponen publik `@ojiepermana/angular` (form, input, label, button, card, alert, badge); tidak ada alat desain atau screenshot. Pilihan lain (alat desain, screenshot) tidak tersedia tanpa manusia.
46. **Navigasi.** Pilihan: (a) item statis `Akun` di semua build, READY-007 dan DEP-006 diamandemen; (b) tanpa item navigasi, tautan di beranda. Dipilih (a): titik masuk yang wajar, dan tetap tanpa request API dari shell.
47. **Tanpa request saat bootstrap.** Shell tidak memanggil `getAuthSession`, agar spec 0007 AC-5 dan READY-007 tetap berlaku; identitas di shell tampil hanya bila state sudah diketahui.
48. **Konfirmasi pencabutan.** Tanpa dialog: mengakhiri sesi dapat dipulihkan dengan masuk lagi, dan tombol dinonaktifkan selama request.

**Tahap bukti**

49. **Tempat bukti.** Pilihan: (a) memakai langkah yang ada: suite database baru di `test:database:real`, test tanpa database di `test:integration`, spec `*.real.e2e.spec.ts` yang dijalankan `test:readiness:real` dan `test:tooling:real`, spec deployment di `test:deployment:real`, dan BKP-009 di suite backup; (b) orkestrasi dan langkah tier baru `test:auth:real`. Dipilih (a): pola file baru sudah dimiliki tabel pemilik runner, tidak ada tier atau jenis bukti baru, dan pemindaian credential yang ada cukup ditambah nilai akun uji dan sidik token (keputusan 65). Konsekuensinya alur browser auth berjalan dua kali per push (dengan dan tanpa `serve`), yang juga membuktikan `serve`.
50. **k6.** Tidak ada profil baru: spec 0011 mengukur endpoint yang tidak berubah. Kapasitas Argon2id dibuktikan `auth_capacity` di dalam batas container backend.

**Tahap cross check** (sesudah pemeriksaan independen oleh model lain; diputuskan agent atas delegasi pemilik pada 2026-10-06, tanpa konfirmasi manusia)

51. **Tempat penolakan sebelum body.** Pilihan: (a) satu guard `onRequest` plugin auth untuk langkah 1 sampai 4 yang mengembalikan `Response`, dengan baris log request ditulis guard sendiri; (b) `onParse` yang menolak sebelum membaca body ditambah `onTransform` dengan `status(...)` untuk `DELETE`; (c) tetap `onTransform`. Rekomendasi dan pilihan: (a). Probe menunjukkan hanya `onRequest` yang menjawab sebelum body diurai dan tanpa menjalankan handler; (b) membagi satu aturan ke dua hook dan bergantung pada nilai kembali parser yang tidak didokumentasikan; (c) terbukti tidak dapat memberi 403 sebelum 400 `PARSE` dan, bila mengembalikan `Response`, tetap menjalankan handler.
52. **`Cache-Control: no-store` untuk semua jawaban auth.** Pilihan: (a) guard menetapkan `set.headers` untuk prefix `/api/auth/`; (b) `onError` khusus plugin. Dipilih (a): terbukti terbawa ke jawaban `onError` root dan 404, tanpa urutan hook galat yang harus dibuktikan terpisah.
53. **Id request bersama.** Pilihan: (a) `WeakMap` tingkat modul di `request-log.ts` dengan `requestIdFor` dan `writeRequestLine`; (b) `createRequestLog` mengembalikan objek berisi plugin dan fungsi; (c) decorate konteks Elysia. Dipilih (a): pemakai `createRequestLog` tidak berubah, dan konteks `onRequest` tidak perlu membawa nilai tambahan. Key `Request` membuat map aman dipakai beberapa app dalam satu proses.
54. **Resep 204 dengan galat.** Semua status `signOut` dan `revokeAuthSession` di `detail.responses` tanpa map `response`, sesuai probe; konsekuensi tanpa validasi response runtime diterima karena kedua route hanya menjawab 204 tanpa body atau `AuthError` dari satu fungsi.
55. **Properti body tidak dikenal.** Pilihan: (a) dibuang (normalisasi bawaan); (b) 400 lewat `normalize: false` pada plugin auth. Dipilih (a): (b) juga mematikan pembuangan field response di luar model, yang menjadi lapisan pencegah kebocoran; properti tambahan tidak berbahaya karena handler hanya membaca `email` dan `password`.
56. **Satuan panjang password.** Satu aturan di `credentials.ts`: penetapan wajib `isWellFormed()`, tanpa karakter kontrol, paling banyak 128 code point mentah dan 15 sampai 128 code point sesudah NFKC; masuk dibatasi 256 satuan UTF 16 di schema lalu 128 code point di handler. Dengan begitu password yang sah selalu lolos schema, NFKC yang memanjang (misalnya U+FDFA menjadi 18 code point) tertangkap saat penetapan, dan body sah selalu di bawah 1.024 byte. 413 dari Bun atau edge dicatat sebagai jawaban di luar kontrak.
57. **Email tidak sah sesudah normalisasi.** 400 sebelum slot, reservasi, dan Argon2id, karena pemeriksaan format tidak mengungkap keberadaan akun dan mencegah baris percobaan untuk string sembarang.
58. **Header CSRF pada `DELETE` tanpa sesi.** Pilihan: (a) header wajib di schema, tidak ada atau salah bentuk selalu 400; (b) header opsional di schema dan diwajibkan sesudah resolusi sesi. Dipilih (a): kontrak SDK tetap mewajibkan parameter itu dan frontend selalu mempunyai token dari `AuthSession`; AC-8 ditulis ulang agar 204 dan 401 tanpa sesi berlaku untuk header yang bentuknya benar.
59. **Pola `sessionId`.** `pattern` UUID huruf kecil di samping `format: uuid`, karena format Elysia menerima bentuk `urn:uuid:` yang membuat PostgreSQL gagal dan akan menjadi 503.
60. **Penggantian password yang berpacu dengan masuk.** `set-password` dan `revoke-sessions --email` mengambil lock per akun yang sama dengan transaksi masuk, dan transaksi masuk membaca ulang `password_hash` sesudah lock; `revoke-sessions --all` tanpa lock per akun karena masuk sesudahnya sah dan runbook menjalankannya saat backend berhenti.
61. **Pembatalan pencabutan.** Database tidak dapat mencegahnya tanpa trigger (sengaja tidak dipakai), sehingga kontrolnya bentuk statement: perpanjangan tunggal dengan penjaga, `revoked_at IS NULL` pada setiap `UPDATE`, dan AUTH-007 membuktikan nol baris untuk sesi dicabut dan kedaluwarsa.
62. **Koneksi selama Argon2id.** Tidak ada koneksi atau transaksi yang ditahan selama hash atau verifikasi; pool 5 koneksi cukup untuk 4 verifikasi berjalan dan 12 antrean, dan `auth_capacity` memeriksa readiness 200 selama beban.
63. **Seam test.** Opsi `auth` `createApp` (`verify` dan `slots`), hanya dari test dan tidak pernah dari environment, agar AUTH-005 dan AUTH-006 menghitung verifikasi dan mengisi slot tanpa melanggar invariant 9.
64. **Pertumbuhan tabel percobaan.** Backend menghapus paling banyak 10 baris kedaluwarsa sesudah setiap reservasi dengan grant `DELETE` yang sudah ada, pada kedua jalur agar waktu tetap setara. Pertumbuhan sesi dicatat sebagai keterbatasan dengan batasnya.
65. **Pemindaian token.** Pilihan: (a) sidik HMAC dengan kunci run di file 0600 di luar artefak, dicocokkan pada setiap deret 43 karakter base64url; (b) pola teks di samping nama cookie dan `"csrfToken"`; (c) token mentah di file sink 0600. Dipilih (a): menangkap token yang bocor tanpa label, dan token tidak pernah ditulis ke file mana pun; (b) melewatkan token tanpa label; (c) menulis credential ke disk.
66. **Bukti adapter dengan backend nyata.** Pilihan: (a) `session()` dan `sessions()` menjadi `unavailable` lewat route GET yang tidak memeriksa origin, 403 adapter lewat `HttpTestingController`, dan 403 backend lewat test `bun:test`; (b) interceptor test yang menambah `Origin`; (c) `PUBLIC_ORIGIN` di harness spec 0009. Dipilih (a): harness lima variable tidak berubah dan tidak bergantung pada apakah fetch test boleh menetapkan `Origin`.
67. **Check batas edge.** 30 request dengan email berbeda, paling banyak 5 bersamaan, dan anggaran 10 `POST` masuk lewat edge untuk check sebelumnya; lulus dengan paling sedikit satu 429 edge tanpa baris request backend. Hasilnya tidak bergantung pada kecepatan runner dan tidak membutuhkan jeda.
68. **Urutan check deployment.** `auth_account_job` sesudah `readiness_after_migration`, empat check auth lain sesudah `browser_flow`, urutan daftar sama dengan urutan eksekusi; `auth_capacity` memakai akun kedua yang tidak pernah menerima password salah di run itu.
69. **Perintah operator.** Kolom stream dan exit untuk setiap baris; `Account exists` dan `Account not found` ke stderr dengan exit 1 karena perintah tidak menjalankan permintaan operator, sedangkan `Sessions revoked: 0` exit 0 karena keadaan yang diminta sudah tercapai. Prioritas galat tetap dan nama tampilan ditolak, tidak dipotong.
70. **Halaman.** `novalidate` dengan pemeriksaan isian kosong sesudah `trim`, wilayah `alert` dan `status` tetap per halaman, signal `notice` untuk pesan sesudah pindah ke `/masuk`, sesi pemanggil tanpa tombol `Akhiri sesi`, `Keluar` menuju `/masuk` dengan `Anda sudah keluar.`, dan format waktu `id-ID` dengan atribut `datetime` yang diperiksa test.
71. **Daftar email saat backup bocor.** Query admin tetap `SELECT email FROM users.users ORDER BY email` di runbook, tanpa perintah operator baru.
72. **Batas waktu `test:database:real`.** `bun test` naik ke 900.000 ms dengan grace 75.000 ms tetap: run terakhir 151,3 detik secara lokal ditambah suite auth dan BKP-009, dengan cadangan untuk runner CI yang lebih lambat, masih di bawah batas langkah tier nyata. BKP-009 menjadi test terakhir `backup.test.ts` dan gagal dengan alasan bernama bila masa idle 30 menit terancam.
73. **Daftar test lama dan teks `createApp`.** Tabel *Test dan file lama yang berubah* dan teks akhir `createApp` ditulis di spec, sehingga SDK-005, spawn production, BKP-003, BKP-001, navigasi, dan file `tsconfig` berubah pada commit yang sama dengan pemicunya.

**Tahap perbaikan sesudah code review**

Keputusan 74 sampai 77 diambil agent pada 2026-10-06 atas delegasi pemilik yang sama, sesudah code review oleh model lain (`docs/reviews/2026-10-06-main-user-session.md`), tanpa konfirmasi manusia.

74. **Path yang dibandingkan guard.** Temuan: Elysia 1.4.30 merutekan request yang tidak cocok dengan router Bun mulai dari `/` pertama pada indeks 11 `request.url`, sedangkan Bun menulis `request.url` sebagai `http://<Host><target>` (atau target saja untuk Host seperti `a b`). Dengan `Host: abc`, `POST //api/auth/session` dirutekan ke handler masuk, sementara guard membaca pathname `//api/auth/session` dan tidak menanganinya; edge meneruskan Host client dan path mentah, dan kunci batas masuknya hanya `POST:/api/auth/session`, sehingga origin, `Content-Type`, `strictGet`, `no-store`, dan batas edge terlewati (dibuktikan ulang lewat socket mentah: 503 dari handler, dan 485 dari 2.754 kombinasi Host dan path mencapai handler). Pilihan: (a) guard juga menghitung path seperti Elysia (`routedPath` di `plugins/request-guard.ts`), menangani request bila salah satu path berawalan `/api/auth/`, dan langkah 1 menjawab 404 bila keduanya berbeda; (b) guard memakai path Elysia saja untuk langkah 1; (c) pemeriksaan ulang langkah 1 sampai 4 di setiap handler; (d) edge menolak Host yang tidak dikenal atau `//` di path. Rekomendasi dan pilihan: (a). (b) masih menjalankan handler masuk untuk path mentah yang bukan kunci batas edge, sehingga batas edge tetap dapat dilewati; (c) menggandakan guard di lima handler dan bertentangan dengan invariant 11; (d) mengubah kebijakan Host spec 0012 dan DEP-001 tetapi tidak menutup jalur langsung ke backend, sedangkan (a) menutup keduanya, karena handler kini hanya berjalan bila path mentah sama persis dengan route, dan path itu juga yang dibaca kunci edge. Request sah dengan Host 3 karakter atau kurang tidak ada untuk origin publik berupa nama domain (nama domain terpendek sudah 4 karakter, dan client lain mengirim port bersama Host), jadi 404 untuk Host seperti itu diterima. Bukti: test listener nyata AUTH-009 di `tests/integration/backend/auth.test.ts` dengan request mentah lewat socket.
75. **Urutan baris saat pencabutan.** Temuan: perpanjangan pemanggil lalu pencabutan target mengunci dua baris dalam urutan request, sehingga dua sesi satu akun yang saling mencabut membentuk siklus lock dan satu request menjawab 503 sesudah `deadlock_timeout` (dibuktikan ulang pada PostgreSQL 18). Pilihan: (a) kedua statement berjalan dalam urutan id sesi; (b) satu statement untuk kedua baris; (c) tanpa perpanjangan di route pencabutan; (d) lock per akun di route pencabutan. Dipilih (a): statement *Perpanjangan sesi* dan *Pencabutan* tidak berubah, AC-7 tetap berlaku, dan urutan global menurut id mencegah siklus antar pencabutan berapa pun jumlah sesinya. Siklus yang jauh lebih langka antara pencabutan dan rotasi atau batas 10 sesi saat masuk tidak ditutup; PostgreSQL mengakhirinya sebagai 503 yang dapat diulang, tanpa celah keamanan, dan (d) dapat dipilih kelak bila itu teramati.
76. **Trim `Content-Type` linear.** Spasi U+0020 di kedua ujung dibuang dengan loop, bukan regex `/ +$/` yang kuadratik pada deret spasi panjang di header pilihan client (16.000 spasi sekitar 120 ms per request di event loop). Aturan *Content-Type* tidak berubah, dan tidak ada batas panjang baru, karena spasi opsional di sekitar `;` tidak dibatasi jumlahnya oleh spec.
77. **`key_hash` dan `accountKey` tanpa kunci.** Temuan: SHA 256 tanpa kunci atas `sign-in:` dan email ternormalisasi memungkinkan pembaca log atau backup memastikan apakah email tebakan pernah dicoba masuk, termasuk email yang bukan akun. Pilihan: (a) diterima sebagai risiko tercatat; (b) HMAC dengan secret server. Dipilih (a): (b) menambah secret server yang harus dirotasi, padahal spec menyatakan tidak ada secret server baru, dan setiap rotasi memutus korelasi `accountKey` lintas waktu serta membuat baris percobaan yang sedang berjalan tidak terhitung. Pembaca backup sudah memegang email semua akun di `users.users`; yang bertambah hanya email bukan akun yang dicoba dalam jendela percobaan yang belum dibersihkan. Pembaca log adalah operator platform log. Bila log atau backup kelak dibuka untuk pihak lain, (b) menjadi tindak lanjut lewat pembaruan spec ini.

## Cross check

Pemeriksaan independen oleh model lain (baca saja) pada 2026-10-06 mengembalikan 36 temuan, banyak di antaranya sama dari dua pemeriksa, yaitu satu blocker, tiga belas major, dan dua puluh dua minor. Agent memeriksa setiap temuan terhadap kode dan probe sesi ini (bagian *Bukti probe*), lalu menerapkan perbaikan yang direkomendasikan atau yang lebih baik atas delegasi pemilik; keputusan 51 sampai 73 mencatat pilihannya. Semua temuan nyata, sehingga tidak ada temuan yang ditolak seluruhnya. Bagian rekomendasi berikut tidak diambil:

- Hook `onParse` sebagai tempat penolakan: diganti guard `onRequest` yang menangani keempat langkah di satu tempat (keputusan 51).
- `onError` khusus plugin auth untuk `no-store`: header yang ditetapkan guard sudah terbawa ke jawaban `onError` root (keputusan 52).
- `normalize: false` agar properti tidak dikenal menjawab 400: mematikan pembuangan field response (keputusan 55).
- Header `x-csrf-token` opsional di schema: kontrak SDK tetap mewajibkannya dan AC-8 ditulis ulang (keputusan 58).
- File sink token mentah 0600 dan pemindaian pola saja: sidik HMAC menangkap token tanpa label tanpa menulis token (keputusan 65).
- Interceptor `Origin` di test atau `PUBLIC_ORIGIN` di harness spec 0009: bukti 503 lewat route GET tidak membutuhkan origin, sehingga harness dan spec 0009 tidak berubah selain literal SDK-005 (keputusan 66).
- Jeda 25 detik sebelum `auth_edge_rate_limit`: check 30 request dengan anggaran 10 untuk check sebelumnya lulus berapa pun isi bucket (keputusan 67).
- Lock per akun untuk `revoke-sessions --all`: masuk yang selesai sesudahnya sah dengan password yang berlaku, dan runbook menjalankannya saat backend berhenti (keputusan 60).
- Perintah `list` untuk daftar email: query admin di runbook cukup tanpa permukaan operator baru (keputusan 71).
- Menjadikan pembersihan sebagai kriteria fitur 16 di scope: pemilik meminta run terbatas dan bagian fitur lain tidak diubah; pembersihan bertahap percobaan dan catatan *Follow-up* menggantikannya (keputusan 64).
- Pemangkasan sesi yang dicabut per akun saat masuk: backend sengaja tanpa `DELETE` pada `auth.sessions`, sehingga batas pertumbuhan dicatat sebagai keterbatasan (keputusan 64).
- Restore kedua sekali pakai untuk BKP-009: menjadikan BKP-009 test terakhir lebih sederhana dan tidak membutuhkan cluster tambahan (keputusan 72).
- Menyegarkan `last_seen_at` lewat admin atau membuat sesi tepat sebelum restore di BKP-009: sesi harus ada sebelum backup agar ikut fingerprint, dan file berjalan jauh di bawah masa idle 30 menit; BKP-009 gagal dengan alasan bernama bila batas itu terancam (keputusan 72).

## Bukti probe 2026-10-06

- Bun 1.4.2, `Bun.password.hash` dengan `{ algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 }` menghasilkan prefix `$argon2id$v=19$m=19456,t=2,p=1`; bawaan tanpa opsi `$argon2id$v=19$m=65536,t=2,p=1`. Pada Apple M1 Max: verifikasi rata rata 19,4 ms (19456) dan 69,8 ms (65536); 4 verifikasi bersamaan 23,5 ms dan 88,0 ms. `Bun.password.verify` atas hash yang tidak cocok mengembalikan `false` tanpa exception.
- `scripts/validate-openapi.ts` rule `security` menerima `apiKey` dengan `in: cookie`; rule `parameter` menolak `in: cookie`. `node_modules/@ojiepermana/angular/sdk/src/parser/ir.js` versi 22.1.14 mencatat security scheme tetapi tidak mengeluarkan kode untuknya, dan `emit/operations.js` mengeluarkan parameter header lewat `rb.header(name, ...)`.
- `database/provision.ts` hanya memeriksa ACL database, schema, dan `common.schema_migrations`, sehingga grant tabel baru dari migration tidak membuat provisioning ulang sesudah restore gagal.
- `deploy/compose.yaml`: backend `cpus: 1`, `mem_limit: 512m`; runner `mem_limit: 256m`, dan image runner tidak menjalankan `bun install`, sehingga `libs/server/auth/` hanya boleh memakai fasilitas bawaan Bun.
- `tests/e2e/readiness/readiness-production.e2e.spec.ts` dan `tests/e2e/deployment/edge.deployment.e2e.spec.ts` menghitung tepat satu tautan navigasi production; `playwright.real.config.ts` dipakai `test:readiness:real` dan `test:tooling:real` dengan pola `**/*.real.e2e.spec.ts`.
- Lifecycle Elysia: `onTransform` berjalan sebelum validasi schema, `onBeforeHandle` sesudahnya (skill `elysiajs`, `references/lifecycle.md`). Catatan ini tidak cukup dan dikoreksi probe cross check di bawah: body diurai sebelum `onTransform`.

Probe cross check 2026-10-06 (Elysia 1.4.30, `@elysia/openapi` 1.4.16, Bun 1.4.2, skrip di scratchpad sesi, tidak masuk repository):

- `POST` dengan JSON rusak dan `Origin` palsu, lewat hook `onTransform` yang menolak origin, menjawab 400 `PARSE`, bukan 403: body diurai sebelum `onTransform`. `onTransform` yang mengembalikan `Response` tidak menghentikan lifecycle (handler berjalan, 200); yang mengembalikan `status(403, ...)` berhenti, tetapi tetap sesudah body diurai. `multipart/form-data` tanpa boundary menjawab 400 `PARSE` sebelum `onTransform`.
- `onRequest` dalam plugin berlaku global; mengembalikan `Response` di sana menjawab sebelum body diurai tanpa menjalankan handler, untuk body sah maupun rusak, tetapi `onAfterResponse` tidak berjalan, sehingga plugin log spec 0012 tidak menulis baris untuk jawaban itu.
- `set.headers['cache-control'] = 'no-store'` yang ditetapkan di `onRequest` terbawa ke jawaban `onError` root untuk JSON rusak, validasi, galat handler (500), dan path tidak dikenal (404).
- Elysia hanya mengurai `Content-Type` berawalan `application/json` huruf kecil sebagai JSON (`application/json ; charset=UTF-8` diurai, `Application/JSON` dan `APPLICATION/JSON` sampai ke validasi sebagai teks dan menjawab 400).
- Dengan normalisasi bawaan, body dengan properti tambahan pada schema `additionalProperties: false` diterima dan properti itu dibuang. `maxLength` 128 menolak 65 emoji (130 satuan UTF 16) dan menerima 64.
- Format `uuid` Elysia menerima `urn:uuid:123e4567-...` dan huruf besar sebagai parameter path.
- Route dengan map `response` untuk galat dan `detail.responses` berisi 204 mengekspor operasi tanpa 204, dan `validateOpenApi` menolaknya dengan rule `response`. Route tanpa map `response` dengan semua status (204 `{ description }` dan galat `$ref` `AuthError`) di `detail.responses` lolos semua rule sampai `required-operation` (yang gagal hanya karena probe tidak memuat operasi health).
- Repository: `createRequestLog` menyimpan id request di `WeakMap` per instance dan `requestIdOf` membuat id acak baru pada setiap panggilan bila `x-request-id` tidak sah; `parseBackendLogLine` di `tests/orchestration/deployment-real.ts` hanya menerima baris `request` dan lifecycle; SDK-005 mengganti literal `tags: [{ name: 'development' }, { name: 'health' }]` dan `.use(developmentRoutes).use(healthRoutes);`; `application.test.ts`, `logging.test.ts`, dan `backend/readiness.test.ts` menjalankan backend production tanpa `PUBLIC_ORIGIN`; `backup.test.ts` mengharapkan tepat tabel `common.schema_migrations` dan `users.restore_fixture` serta `migrations.count` 2, dan `expectTargetUnchanged` membandingkan target dengan fingerprint sumber sampai test probe fingerprint di akhir file; `database-real.ts` memberi `bun test` 600.000 ms di dalam batas langkah tier nyata 1.500.000 ms, dan run terakhir `test:database:real` 151,3 detik; `playwright.real.config.ts` dan `playwright.deployment.config.ts` memakai `trace: 'off'`; harness Vitest spec 0009 memberi backend tepat lima variable.

## Pertanyaan yang belum dapat diputuskan

Setiap pertanyaan berikut mempunyai jalur otonom yang sudah diputuskan, sehingga build tidak berhenti menunggu manusia.

- Penerimaan pemilik atas masa berlaku 30 menit dan 12 jam, batas 10 percobaan per 15 menit, dan batas edge 30 per menit untuk produk nyata. Nilainya keputusan agent yang dapat diubah lewat pembaruan spec ini.
- Penerimaan risiko butir 4 hook backup (tanpa enkripsi sisi client dan tanda tangan backup) sampai platform penyimpanan dipilih.
- Durasi verifikasi Argon2id di runner GitHub dengan `cpus: 1`; batas 2.000 ms pada `auth_capacity` diukur sesudah push. Bila tidak terpenuhi, parameter tidak diturunkan di bawah minimum OWASP; yang disesuaikan adalah batas antrean atau batas container lewat pembaruan spec ini dan spec 0012.
- Perilaku median durasi AUTH-005 di runner CI yang berisik; ambang 1,5 kali dipilih longgar, dan kegagalan pertama diselidiki sebagai kemungkinan kebocoran timing, bukan dilonggarkan.
- Kebutuhan hukum untuk email dan nama tampilan saat produk mempunyai audiens nyata, termasuk retensi backup 35 hari.

## References

**Project sources**:

- `AGENTS.md`, sumber aturan, koordinasi subagent, dan pertanyaan schema.
- `docs/scope/scope.md`, fitur 15 (Selesai ketika dan Data), fitur 16, batas dan keputusan schema, dan build approach Tracer Bullet; `docs/foundation.md` bagian 6 dan 9.
- `docs/rules/security.md`, sesi opaque, cookie, CSRF, Argon2id lewat `Bun.password`, batas percobaan tanpa header alamat, dan log keamanan.
- `docs/rules/database.md`, schema `users` dan `auth`, relasi lintas schema, privilege minimum, dan larangan schema baru.
- `docs/rules/elysia.md`, `docs/rules/openapi-sdk.md`, `docs/rules/angular.md`, `docs/rules/ui-ux.md`, `docs/rules/testing.md`, `docs/rules/deployment.md`, `docs/rules/backup.md`, dan `docs/rules/worker.md`.
- Spec 0004 (role dan privilege), 0005 (runner dan seed sebagai owner), 0006 (READY-006, READY-007, orkestrasi nyata), 0007 (shell dan navigasi), 0008 (aturan checker dan operasi wajib), 0009 (kontrak adapter dan harness backend), 0010 (registry, GATE-009, tier), 0012 (komposisi production, edge, topologi, check deployment), dan 0013 (hook fitur 15, runbook, `restore.json`).
- `apps/backend/src/app.ts`, `apps/backend/src/index.ts`, `apps/backend/src/config/env.ts`, `apps/backend/src/plugins/request-guard.ts`, `apps/backend/src/plugins/request-log.ts`, `apps/frontend/src/app/`, `apps/frontend/edge/nginx.conf`, `database/runner.ts`, `database/provision.ts`, `deploy/compose.yaml`, `scripts/validate-openapi.ts`, `scripts/lib/gate.ts`, `scripts/lib/test-inventory.ts`, `scripts/serve.ts`, dan `tests/orchestration/readiness-real.ts`.
- Skill `elysiajs` (`references/lifecycle.md`, `references/cookie.md`) dan `angular-developer`.

**Practices & standards**:

- OWASP ASVS 4 tingkat 2 untuk masa idle dan absolut sesi; OWASP ASVS sebagai rujukan kontrol sesuai aturan keamanan.
- OWASP Session Management Cheat Sheet: token acak minimal 64 bit, hash token di server, cookie non persisten `HttpOnly`, `Secure`, `SameSite`, dan prefix `__Host-`, serta token baru saat masuk.
- OWASP Cross Site Request Forgery Prevention Cheat Sheet: token terikat sesi, pemeriksaan origin dan Fetch Metadata, header khusus untuk API, dan `SameSite` bukan satu satunya pertahanan.
- OWASP Password Storage Cheat Sheet: Argon2id minimal 19 MiB, 2 iterasi, parallelism 1.
- OWASP Authentication Cheat Sheet: jawaban dan waktu identik tanpa enumerasi akun, serta batas percobaan per akun dan per sumber.
- NIST SP 800-63B rev 4: password satu faktor minimal 15 karakter, tanpa aturan komposisi, tanpa pemotongan, dan normalisasi Unicode.
- Prinsip privilege minimum per kolom dan pemisahan role pembersihan dari role runtime.
