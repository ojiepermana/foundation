# 0008. Autentikasi dengan tautan email

**Date**: 2026-09-17
**Status**: Proposed

## Summary

Anda dapat masuk dengan memasukkan email lalu mengonfirmasi tautan yang dikirim ke kotak masuk. Frontend menerima tautan, tetapi backend memvalidasi token dan membuat sesi. Password dihapus, sedangkan passkey tetap tersedia. Pengaturan ENV wajib menentukan apakah tautan login harus dibuka pada browser peminta atau boleh dibuka pada perangkat lain.

## Requirements

**User stories**: Sebagai pengguna terdaftar, Anda ingin masuk dan mengaktifkan akun tanpa password. Sebagai pemilik akun, Anda ingin tetap memakai passkey dan mengelolanya setelah konfirmasi terbaru. Sebagai operator, Anda ingin memilih aturan perangkat melalui ENV dan mempertahankan akun yang sudah ada.

| ID | Kriteria penerimaan |
| :--- | :--- |
| AC-1 | Permintaan login hanya menerima email. Akun active memperoleh tautan; email tidak dikenal dan akun disabled tidak memperoleh tautan atau akun baru. Semua permintaan yang lolos validasi dan pembatasan memberi respons generik yang sama. |
| AC-2 | CLI tetap membuat akun pending dengan nama, email unik yang dinormalisasi, dan role admin atau user. Email CLI hanya menuju halaman masuk. Akun pending dapat meminta tautan; verifikasi pertama mengaktifkan akun dan langsung membuat sesi. |
| AC-3 | AUTH_EMAIL_LINK_MODE wajib berisi same_browser atau cross_device. Nilai kosong atau salah menggagalkan startup. Mode pertama memerlukan cookie browser peminta; mode kedua membuat sesi pada browser pembuka tanpa cookie peminta. Tidak ada peralihan mode otomatis saat verifikasi gagal. |
| AC-4 | Tautan membuka frontend dengan token dalam fragment URL. Frontend menghapus fragment dan hanya mengirim token ke backend setelah tombol konfirmasi ditekan. Token sah dipakai sekali, termasuk pada permintaan bersamaan, dan keberhasilan mengembalikan SessionData serta cookie lalu membuka dashboard. |
| AC-5 | Password tidak lagi diminta, disimpan, dihash, atau diverifikasi untuk akun aplikasi. Kolom password_hash dihapus, token aktivasi/reset lama tidak berlaku, dan API password lama memberi 410 untuk permintaan berorigin sah. Kredensial passkey tetap ada. |
| AC-6 | Sesi memakai cookie HttpOnly, SameSite=Lax, Secure pada HTTPS, dan batas absolut sesuai SESSION_TTL_SECONDS yang ada. Logout mencabut sesi. Backend tetap memeriksa akun active, role, CSRF, pemilik kredensial, dan larangan menonaktifkan atau menurunkan admin aktif terakhir. |
| AC-7 | Login email dan login passkey dengan verifikasi pengguna memberi bukti konfirmasi selama 5 menit. Setelah itu, perubahan passkey memerlukan tautan konfirmasi ulang yang terikat pada pengguna dan sesi peminta. Verifikasi kembali ke profil tanpa otomatis menambah atau menghapus passkey. |
| AC-8 | Permintaan email memiliki jeda 60 detik dan paling banyak 3 permintaan yang diizinkan per 15 menit per email, dibagi antara login dan konfirmasi ulang. Batas IP yang ada tetap berlaku. Redis tidak tersedia membuat mutasi auth ditolak dengan 503. |
| AC-9 | Token dan email terenkripsi dicatat dalam transaksi yang sama. Respons 202 berarti permintaan diterima, bukan email sudah terkirim. Retry SMTP memakai token yang sama, tidak memperpanjang masa berlaku, dan tidak membuat sesi atau token baru. |
| AC-10 | UI menyediakan input email, status permintaan, pilihan passkey, tombol konfirmasi, status sibuk, dan kegagalan yang dapat dipulihkan tanpa formulir password. Sesi akun lain tidak diganti tanpa logout. Tidak ada endpoint pemeriksaan token awal atau tampilan email tujuan yang diklaim sudah diverifikasi. |
| AC-11 | Tautan login terbaru membatalkan tautan login lama untuk akun yang sama. Token salah, kedaluwarsa, sudah dipakai, salah browser, atau tidak cocok dengan mode yang berlaku tidak membuat sesi. Perubahan mode membatalkan token mode lama secara permanen. Respons verifikasi yang hilang tidak membuat token dapat dipakai ulang. |
| AC-12 | Token login dan konfirmasi ulang berlaku 15 menit secara bawaan, dapat diatur melalui ENV. Worker membersihkan token 7 hari setelah dipakai atau kedaluwarsa, saat mulai dan setiap jam, tanpa menghambat pengiriman email. |
| AC-13 | Peralihan memakai jeda layanan singkat setelah antrean email lama selesai. Migrasi mempertahankan pengguna, role, status, profil, dan passkey; mencabut sesi lama; serta menggagalkan seluruh transaksi bila validasi data gagal. Bukti auth lama tidak dianggap bukti alur baru. |

## Decision

**Chosen option**: Perubahan terarah pada autentikasi native yang sudah ada, dengan pergantian schema terkoordinasi setelah irisan lengkap lulus uji.

Anda tetap memakai Angular 22, Bun, Elysia, Bun.SQL dengan PostgreSQL, pembatas Redis, outbox SMTP, dan SimpleWebAuthn 14. Tidak ada provider atau library baru. Rencana mengikuti Tracer Bullet dari scope: satu alur nyata melewati database, email, API, dan frontend terlebih dahulu, lalu menambah aturan dan bukti lainnya.

**Implementation skills**: `angular-developer`, skill lokal Google LLC pada `~/.agents/skills/angular-developer/SKILL.md`. Angular memakai Signal Forms, signals, komponen yang dimuat sesuai rute, dan pola API proyek. Anda tidak perlu merombak lapisan HTTP untuk perubahan ini.

Konten desain disetujui pada 2026-09-17. Pemeriksaan spec oleh model tambahan dilewati atas pilihan Anda. Status tetap Proposed karena alur baru belum dibangun; review kode auth tetap diperlukan sebelum penerimaan GA.

Spec ini menggantikan [keputusan auth 0003](../0003-user-auth/index.md). Untuk bagian yang bertentangan, kontrak ini juga menjadi acuan atas syarat password dan jenis token pada [model data 0002](../0002-data-model.md), template auth pada [email 0006](../0006-email.md), serta formulir password pada [UI 0007](../0007-ui.md). Kontrak lain dalam ketiga spec itu tetap berlaku. Implementasi saat spec ini dibuat masih mengikuti versi lama.

## Feature design

### Batas perubahan

Tidak ada registrasi publik, perubahan email, OAuth, tenant, penghapusan akun, atau provider baru. Role admin dan user tetap memakai kebijakan sekarang. Pembersihan token adalah pemeliharaan auth dalam worker, bukan scheduler pekerjaan umum. Kredensial SMTP dan secret layanan bukan password akun pengguna dan tidak dihapus.

### Data model sketch

Semua waktu memakai `timestamptz` dan jam PostgreSQL. Field yang tidak disebut berubah tetap mengikuti migrasi yang sudah ada. PK berarti kunci utama, FK berarti rujukan ke tabel lain, dan nullable berarti boleh kosong.

| Entitas | Kunci dan relasi | Target |
| :--- | :--- | :--- |
| users | PK id UUID; satu pengguna memiliki banyak sesi, token, dan passkey | Hapus password_hash beserta constraint yang bergantung padanya. Status active wajib memiliki activated_at. Nama, email unik, role, dan status tetap. |
| sessions | PK id UUID; FK user_id ke users | Kolom tetap. Tambah UNIQUE(id, user_id) untuk FK gabungan token konfirmasi. Default reauthenticated_at tetap epoch; login yang telah terbukti secara eksplisit mengisinya dengan waktu DB. |
| action_tokens | PK id UUID; FK user_id wajib; token_hash char(64) unik | purpose wajib login atau reauthentication. created_at dan expires_at wajib; consumed_at nullable. Hash memakai SHA256 atas token acak 32 byte, bukan token mentah. |
| action_tokens.login_mode | text nullable | Wajib same_browser atau cross_device pada purpose login; wajib kosong pada reauthentication. |
| action_tokens.browser_binding_hash | char(64) nullable | Wajib pada login same_browser; wajib kosong pada login cross_device dan pada reauthentication. |
| action_tokens.session_id | UUID nullable | Kosong pada login; wajib pada reauthentication. FK gabungan (session_id, user_id) ke sessions(id, user_id) memastikan sesi milik pengguna yang sama, dengan ON DELETE CASCADE. |
| passkey_credentials, webauthn_challenges | Relasi pengguna dan sesi yang ada | Schema dan kredensial tetap. Tidak menambah metode atau purpose challenge baru. |
| mail_outbox, audit_events | Struktur yang ada | Schema tetap. Jenis pesan baru dibentuk oleh template, bukan tabel tambahan. |

Constraint DB menolak kombinasi purpose, mode, pengikat, dan session_id yang tidak sah. Indeks pengguna dan purpose tetap dipakai. Tambah indeks `COALESCE(consumed_at, expires_at)` untuk pembersihan. Tidak ada batas permanen jumlah token historis; retensi dan pembatas permintaan membatasi pertumbuhannya.

### State transitions

1. CLI membuat pending dan undangan email dalam satu transaksi. Undangan menuju `/login`, tanpa token, email pada URL, atau aktivasi otomatis. Perintah kirim ulang CLI tetap hanya menerima akun pending.
2. Permintaan tautan login mengunci pengguna. Untuk pending atau active, backend membatalkan token login yang belum dipakai, membuat token baru, dan mencatat outbox dalam satu transaksi. Akun lain tidak diubah.
3. Verifikasi mencari kandidat melalui hash, mengunci pengguna sebelum token, kemudian memeriksa purpose, expiry, consumed_at, status, mode, dan pengikat. Membuka halaman atau GET tidak mengonsumsi token.
4. Untuk pending, transaksi yang sama mengisi activated_at dan mengubah status menjadi active. Untuk active, activated_at tidak diubah. Token dikonsumsi, sesi baru dibuat, dan audit ditulis dalam transaksi tersebut. Cookie hanya dikirim setelah commit.
5. Jika ada sesi sah untuk akun lain, backend memberi 409 SESSION_ACCOUNT_CONFLICT tanpa memakai token. Jika sesi sah milik akun yang sama, verifikasi membuat sesi baru dan mencabut sesi browser itu saja. Sesi lain tetap berlaku.
6. Disable mencabut semua sesi dan seluruh token belum dipakai milik akun. Aktivasi kembali oleh admin memerlukan activated_at yang sudah terisi, bukan password. Token sebelum disable tidak boleh hidup kembali setelah enable.
7. Konfirmasi ulang memakai purpose reauthentication, pengguna dari sesi, dan session_id peminta. Penerbitan terbaru membatalkan token reauthentication lama pada sesi itu saja. Verifikasi memperbarui reauthenticated_at dan mengonsumsi token dalam satu transaksi, tanpa sesi baru.

### Mode dan konfigurasi

| ENV atau aturan | Kontrak |
| :--- | :--- |
| AUTH_EMAIL_LINK_MODE | Wajib same_browser atau cross_device, tanpa default. Berlaku untuk login, bukan untuk melepaskan pengikatan sesi konfirmasi ulang. |
| AUTH_EMAIL_LINK_TTL_SECONDS | Default 900, integer 60 sampai 1800. Berlaku untuk login dan konfirmasi ulang. Batas ini adalah rekomendasi teknis untuk mencegah token berumur panjang. |
| SESSION_TTL_SECONDS | Tetap seperti sekarang, default 604800. Tidak ada refresh sesi atau perubahan batas absolut. |
| APP_URL, APP_ENCRYPTION_KEY, SMTP dan Redis | Memakai konfigurasi yang ada. APP_URL adalah origin tepercaya, bukan Host header atau input pengguna. Produksi tetap memerlukan HTTPS. |
| ACTIVATION_TTL_SECONDS, RESET_TTL_SECONDS | Tidak dipakai lagi untuk auth baru. Dokumentasi dan contoh konfigurasi menghapus keduanya saat implementasi. |

API, worker, CLI, proses uji, dan contoh konfigurasi menerima mode wajib yang sama. ENV hanya dibaca oleh backend saat startup, bukan dikompilasi ke Angular. Perubahan mode dilakukan dengan menghentikan seluruh API lama, menyamakan ENV, lalu memulai API baru. Sebelum menerima trafik, API menandai token login belum dipakai dengan login_mode berbeda sebagai consumed. Kegagalan langkah ini menggagalkan startup. Setiap verifikasi juga membandingkan login_mode dengan mode saat ini. Beralih kembali ke mode sebelumnya tidak menghidupkan token yang sudah dibatalkan. Menjalankan instance dengan mode berbeda secara bersamaan tidak didukung.

Pada same_browser, cookie `foundation_email_browser` menyimpan rahasia acak 32 byte: HttpOnly, SameSite=Lax, Path=/, Secure pada HTTPS, tanpa Domain. Backend menyimpan hash rahasia pada token, membandingkannya dengan waktu konstan, dan tidak mengikat ke IP atau User Agent. Cookie valid yang sudah ada dipakai lagi; jika hilang atau formatnya salah, backend membuat yang baru saat permintaan email. Max-Age mengikuti TTL token. Respons 202 memakai kebijakan cookie yang sama untuk email dikenal dan tidak dikenal. Cookie pengikat tidak diperbarui oleh halaman verifikasi. Cookie hilang berarti pengguna meminta tautan baru pada browser itu. Mode cross_device mengabaikan cookie pengikat dan tidak menyimpan browser_binding_hash.

### API surface

Path pada tabel relatif terhadap `/api/v1`. Semua POST, PATCH, dan DELETE tetap memerlukan Origin yang sama dengan APP_URL. CSRF adalah bukti tambahan yang dikirim dari sesi melalui header `X-CSRF-Token`. Respons error memakai envelope proyek yang sudah ada, dengan requestId dan kode aman.

| Endpoint | Method | Input | Output | Auth | Error utama |
| :--- | :--- | :--- | :--- | :--- | :--- |
| /auth/email/request | POST | email string, 3 sampai 254 karakter, normalisasi yang ada | 202, data.message generik, data.mode, data.retryAfterSeconds = 60 | Publik, Origin | 422, 429, 503 |
| /auth/email/verify | POST | token string base64url tepat 43 karakter | 200, data berisi User dan csrfToken, Set-Cookie sesi | Token; CSRF juga wajib bila sudah memiliki sesi sah | 400 INVALID_TOKEN, 403 CSRF_INVALID, 409 SESSION_ACCOUNT_CONFLICT, 429, 503 |
| /auth/reauthentication/email/request | POST | Objek kosong; email bukan input | 202, pesan penerimaan generik dan retryAfterSeconds = 60 | Sesi active dan CSRF | 401, 403, 429, 503 |
| /auth/reauthentication/email/verify | POST | token string base64url tepat 43 karakter | 200, data.ok = true | Sesi peminta yang sama dan CSRF | 400 INVALID_TOKEN, 401, 403, 429, 503 |
| /auth/session | GET | Cookie sesi | SessionData | Sesi active | 401 |
| /auth/logout | POST | Objek kosong | data.ok, cookie dihapus | Sesi dan CSRF | 401, 403 |
| /auth/passkey/options | POST | Objek kosong | challengeId dan options | Publik, Origin | 429, 503 |
| /auth/passkey/verify | POST | challengeId dan response | SessionData dan cookie sesi | Bukti passkey dengan user verification | 401, 422, 429, 503 |
| /me | PATCH | name | User | Sesi dan CSRF | 401, 403, 422 |
| /me/passkeys | GET | Tidak ada | Daftar passkey milik pengguna | Sesi | 401 |
| /me/passkeys/options | POST | Objek kosong | Registration options | Sesi, CSRF, konfirmasi terbaru | 401, 403 REAUTH_REQUIRED, 409 |
| /me/passkeys/verify | POST | response dan name | data.ok | Sesi, CSRF, konfirmasi terbaru | 400, 401, 403, 409 |
| /me/passkeys/:id | DELETE | id | data.ok | Pemilik, CSRF, konfirmasi terbaru | 401, 403, 404 |
| /users | GET | page, limit, search | Daftar dan meta pagination yang ada | Admin | 401, 403, 422 |
| /users/:id | PATCH | name, role, status yang sudah didukung | User | Admin dan CSRF | 401, 403, 404, 409 LAST_ADMIN, 422 ACTIVATION_REQUIRED |

Endpoint lama `/auth/login`, `/auth/activate`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/reauthenticate`, dan `/me/password` memberi 410 `PASSWORD_AUTH_REMOVED` pada method POST. Handler tidak lagi mengautentikasi password, menukar token lama, atau memvalidasi skema password. Pemeriksaan Origin dan batas ukuran body tetap berlaku. Input token yang melanggar skema body memberi 422; token dengan bentuk benar tetapi gagal pemeriksaan semantik memberi 400 INVALID_TOKEN. Token reauthentication tidak dapat ditukar melalui endpoint login, dan sebaliknya.

### Value sourcing

| Aksi | Nilai yang dihasilkan atau ditampilkan | Sumber |
| :--- | :--- | :--- |
| CLI | id, nama, email, role, status pending, undangan | UUID acak backend; argumen CLI tervalidasi; default status DB; APP_URL dengan path /login. |
| Permintaan login | Email tujuan dan nama pada pesan | Input email yang dinormalisasi untuk pencarian; users.email dan users.name, bukan alamat dari URL verifikasi. |
| Permintaan login | mode, pesan generik, retryAfterSeconds | Config backend; teks tetap yang sama untuk semua akun; konstanta 60. Bukan status pengiriman SMTP. |
| Penerbitan | Token, hash, cookie pengikat, expiry | Generator token kriptografis yang ada; SHA256; cookie atau generator rahasia baru; waktu DB ditambah TTL config. |
| Email login atau konfirmasi | URL, label tindakan, waktu berlaku | APP_URL; path /verify-email atau /verify-reauthentication berdasarkan purpose backend; fragment token; expiry token yang sama. |
| Verifikasi login | Akun, role, aktivasi, SessionData, csrfToken | action_tokens.user_id; baris users yang dikunci; waktu DB; sesi baru; helper csrfFor atas token sesi. Raw token sesi hanya masuk cookie. |
| Halaman verifikasi | Tombol, status, kegagalan | Path frontend menentukan tindakan; token fragment hanya input tak tepercaya; hasil API menentukan sukses atau gagal. Tidak menampilkan identitas akun dari token. |
| Konfirmasi ulang | Email tujuan, sesi target, bukti terbaru | Identitas sesi pada backend, users.email, sessions.id, dan waktu DB setelah token terbukti. Tidak menerima email atau session_id dari body. |
| Pembatas | Key email dan waktu coba lagi | Digest email ternormalisasi dari body login atau users.email pada konfirmasi ulang; TTL key Redis untuk Retry-After. |
| Navigasi | Dashboard atau profil | Tujuan tetap /dashboard untuk login dan /profile untuk konfirmasi ulang. Tidak menerima return URL. |
| Pembersihan | Batas waktu, jumlah baris, jadwal | Waktu DB dikurangi 7 hari; COALESCE(consumed_at, expires_at); jumlah hasil delete; timer worker 1 jam. |

### Security model dan failure modes

Backend adalah satu satunya penentu identitas. Token, cookie, purpose, mode, status akun, expiry, dan kepemilikan sesi diperiksa ulang saat mutasi, bukan hanya ketika email diminta. Penguncian tetap berurutan pengguna sebelum sesi atau token. Perubahan role admin memakai advisory lock yang sudah ada. Transaksi penerbitan, verifikasi, disable, dan konfirmasi ulang tidak boleh meninggalkan perubahan parsial.

Tautan konfirmasi ulang selalu memerlukan sesi peminta yang masih active. Mode cross_device untuk login tidak mengubah aturan ini. Login email dan passkey yang berhasil menetapkan reauthenticated_at secara eksplisit ke waktu DB. Pemeriksaan konfirmasi menolak waktu epoch, waktu masa depan, dan umur 300 detik atau lebih. Challenge WebAuthn tetap 5 menit, sekali pakai, dengan verifikasi origin, RP ID, userHandle, user verification, counter, dan status akun sebagaimana implementasi yang ada.

Pembatas IP tetap 60 percobaan per path dalam 15 menit memakai IP peer yang sudah dipercaya, bukan header IP kiriman pengguna. Kedua endpoint permintaan email memakai key email bersama: satu skrip Redis atomik memeriksa jeda 60 detik dan kuota 3 dalam jendela 900 detik, lalu mencatat izin hanya jika kedua syarat lolos. Percobaan yang ditolak tidak mengirim atau membatalkan token. Kuota diberlakukan juga untuk email tidak dikenal dan disabled. Kegagalan transaksi sesudah izin tetap dapat memakai kuota, sehingga batas tidak dapat dilewati lewat retry. Respons 429 memberi Retry-After dalam detik dari TTL pembatas. Pemeriksaan ini tidak bergantung pada countdown UI.

Pada kegagalan DB sebelum commit, token dan outbox sama sama tidak tercatat. Jika worker atau SMTP gagal setelah commit, outbox tetap menjadi sumber pemulihan. Retry tidak membuat token baru; tautan dapat kedaluwarsa atau dibatalkan oleh permintaan terbaru sebelum email tiba. Pengguna meminta tautan baru sesuai pembatas. Jangan mengklaim pengiriman SMTP tepat sekali.

Jika respons verifikasi terputus, frontend menyatakan status belum dapat dipastikan. Tidak ada API pengambilan hasil lama atau penerbitan sesi kedua dari token yang sudah dipakai. Pengguna dapat meminta tautan baru, atau membuka sesi yang memang sudah tersedia tanpa mengklaim token tadi berhasil. Salah browser tidak mengonsumsi token; token masih dapat dibuka pada browser peminta sebelum expiry. Cookie aplikasi tidak dibagikan otomatis ke browser dalam aplikasi email.

Audit keberhasilan memakai event `auth.login.email`, `auth.activation.completed`, `auth.reauthentication.email`, dan `auth.login.passkey` yang relevan. Event pengguna dan passkey tetap ada. Log operasional memuat kategori aman, requestId, jumlah token dibersihkan, dan kegagalan worker, tanpa email mentah, token, URL lengkap, cookie, atau isi pesan. Tidak ada klaim kepatuhan regulasi tambahan.

### Frontend

Anda dapat mempertahankan desain dan komponen yang ada pada [design.md](../../../../design.md) serta [ui-registry.md](../../../../ui-registry.md). Ini perubahan alur auth, bukan desain visual baru. Form memakai validasi email, state sibuk yang mencegah pengiriman ganda, serta pesan status yang dapat dibaca teknologi bantu.

`/login` menampilkan email dan pilihan passkey. Respons 202 menampilkan pesan generik dan aksi meminta ulang setelah countdown. `/verify-email` dan `/verify-reauthentication` membaca tepat satu parameter token melalui URLSearchParams, menolak fragment kosong atau ambigu, dan segera menghapus fragment dengan replaceState sebelum pemeriksaan sesi atau navigasi. Token hanya tinggal pada memori komponen, tidak pada localStorage, sessionStorage, query string, log, atau telemetry. Memuat ulang halaman yang sudah dibersihkan memerlukan pembukaan ulang email.

Callback tidak dilindungi guard yang mengalihkan sebelum fragment dibersihkan. Callback memuat sesi yang ada untuk memperoleh CSRF, tetapi tidak mengirim token secara otomatis dan tidak memeriksanya lebih dulu untuk memperoleh email tujuan. Tombol konfirmasi memicu POST yang sesuai. Berhasil login memakai Api.establish lalu menuju dashboard; berhasil konfirmasi ulang menuju profil. Pada konflik akun, UI menampilkan aksi logout menggunakan sesi saat ini. Setelah logout berhasil, token di memori tetap dapat dikonfirmasi, tanpa perlu memuat ulang halaman.

Profil menghapus bagian ubah password dan input konfirmasi password. Ketika membutuhkan bukti baru, tombol meminta email konfirmasi ulang memakai akun pada sesi, bukan input alamat bebas. Pengguna memulai ulang tindakan passkey setelah kembali ke profil. Rute lama `/activate`, `/forgot-password`, dan `/reset-password` membersihkan fragment, memberi status tautan lama, dan menawarkan halaman masuk tanpa meneruskan token. Status kosong, kedaluwarsa, error layanan, 429, pembatalan passkey, fokus keyboard, dan layout mobile tetap dapat digunakan.

### Pemeliharaan worker

Pembersihan berjalan pada startup dan setiap 3600 detik melalui tugas terpisah yang mengikuti AbortSignal worker. Setiap putaran menghapus paling banyak 10 batch berisi 1000 baris dengan cutoff `COALESCE(consumed_at, expires_at) <= now() - interval '7 days'`. Setiap batch memakai transaksi singkat dan `FOR UPDATE SKIP LOCKED`, sehingga beberapa worker dapat berjalan tanpa menghapus token aktif atau menghalangi pengiriman. Bila masih ada sisa, putaran berikutnya melanjutkan. Kegagalan dicatat dan dicoba lagi pada jadwal berikutnya, tidak menghentikan worker email. Tidak ada retensi baru untuk audit atau sesi pada perubahan ini.

### Critical test scenarios

Matriks lengkap, perintah uji yang sudah tersedia, dan syarat bukti ada pada [verify.md](verify.md). Setiap baris matriks menunjuk AC di atas. Seluruh pemeriksaan perilaku masih belum dijalankan untuk desain ini.

## Migration plan

**Strategy**: Pergantian terarah dengan jeda layanan yang disetujui, bukan menjalankan versi password dan tanpa password bersamaan. Anda dapat menguji seluruh irisan pada database uji terlebih dahulu.

1. Siapkan ENV wajib pada seluruh proses dan validasi data: tidak boleh ada pengguna active dengan activated_at kosong. Bila ada data tidak sah, migrasi berhenti; jangan mengarang bukti verifikasi email atau mengubah role.
2. Hentikan API dan kegiatan CLI yang menghasilkan email. Biarkan worker lama menyelesaikan outbox. Tidak boleh ada payload email yang masih menunggu, sedang dikirim, atau failed yang belum selesai. Kegagalan SMTP menjadi penghalang peralihan, bukan alasan menghapus pesan secara diam diam.
3. Setelah antrean selesai, hentikan worker lama dan buat cadangan DB yang terlindungi. Terapkan satu migrasi baru sesudah 0002, dengan mekanisme checksum, advisory lock, dan transaksi migrator yang ada. Jangan mengubah migrasi lama.
4. Dalam transaksi migrasi, hapus token action lama, cabut sesi lama, tandai challenge WebAuthn lama sudah dipakai, hapus constraint password dan kolom password_hash, lalu tambahkan constraint, FK, dan indeks target. Data users dan passkey dipertahankan.
5. Mulai API dan worker baru dengan ENV yang sama. Periksa kesiapan, login email kedua mode pada lingkungan uji, sesi, passkey, dan pemeliharaan. Layanan baru baru dapat diterima setelah bukti yang disepakati tersedia.

**Rollback**: Kegagalan sebelum commit mengembalikan seluruh migrasi. Sebelum trafik baru diterima, pemulihan cadangan bersama binary lama dapat dilakukan pada jeda layanan bila diperlukan. Setelah ada transaksi pengguna baru, utamakan perbaikan maju; pemulihan cadangan akan kehilangan data baru dan memerlukan keputusan operator. Menjalankan binary lama pada schema baru tidak didukung, dan hash password tidak dapat direkonstruksi dari schema baru.

**Risks**: Antrean SMTP yang gagal dapat memperpanjang jeda. Proses versi lama atau ENV yang berbeda dapat melanggar kebijakan baru. Cadangan masih dapat memuat hash password lama, sehingga akses dan retensinya tetap memerlukan perlindungan operator.

## Build plan

Setiap langkah berikut adalah irisan yang dapat Anda bangun dan periksa. Belum ada yang ditandai selesai untuk spec ini.

1. Bangun satu jalur nyata pada database uji: migrasi target, validasi ENV, penerbitan token dan outbox, SMTP sink, form email, callback dengan tombol, cookie sesi, dan dashboard untuk akun active pada same_browser. Perbarui fixture yang terkena schema dalam irisan yang sama. Memenuhi AC-1, AC-3, AC-4, AC-5, AC-6, AC-9, AC-13.
2. Lengkapi mode cross_device, pembatalan token saat perubahan mode, login pending yang mengaktifkan akun, undangan dan kirim ulang CLI, serta 410 dan halaman pengganti alur password. Buktikan alur CLI sampai dashboard. Memenuhi AC-1, AC-2, AC-3, AC-5, AC-10, AC-11.
3. Lengkapi alur profil sampai konfirmasi ulang email dan perubahan passkey. Ubah bukti terbaru pada login email dan passkey; pertahankan pemeriksaan admin, status akun, dan kepemilikan. Memenuhi AC-6, AC-7, AC-10.
4. Buktikan race penerbitan dan konsumsi, transaksi gagal, origin dan CSRF, konflik akun, cookie hilang, token salah purpose, timeout, batas Redis bersama, dan gangguan email. Lengkapi state UI yang terkait tanpa mengubah desain umum. Memenuhi AC-4, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11.
5. Tambahkan pemeliharaan worker yang dibatasi per batch dengan indeks retensi dari migrasi target, dan uji kegagalan serta beberapa worker. Buktikan token belum layak hapus tetap dapat diverifikasi. Memenuhi AC-11, AC-12.
6. Jalankan simulasi migrasi dari schema lama dengan akun pending, active, disabled, admin, passkey, dan pesan mengantre. Perbarui contoh ENV, petunjuk CLI, runbook, dan bukti pengujian. Jalankan matriks verifikasi, pemeriksaan build, review kode auth, dan penerimaan perangkat passkey fisik sebelum menutup GA. Memenuhi AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13.

## Consequences

Anda tidak perlu mengelola password pengguna. Sistem email menjadi bagian penting dari akses akun, sehingga gangguan SMTP dapat menghalangi login bagi pengguna tanpa passkey. Akun email yang diambil alih dapat dipakai untuk masuk dan mengelola passkey setelah pembuktian email.

Mode same_browser membatasi penyalahgunaan tautan lintas browser, tetapi pengguna aplikasi email dengan browser internal mungkin perlu kembali ke browser peminta. Mode cross_device lebih fleksibel, tetapi tombol konfirmasi tanpa identitas tujuan tidak mencegah seluruh serangan login CSRF, yaitu orang membuka tautan untuk akun milik pihak lain. Anda memilih tidak menambah pemeriksaan identitas awal; risiko ini tetap berlaku dan tidak boleh diklaim sudah dihilangkan.

Permintaan terbaru dari pihak lain dapat membatalkan tautan akun yang sedang ditunggu. Pembatas memperkecil gangguan, bukan menghapusnya. Pengiriman terlambat dapat membawa tautan yang sudah tidak berlaku. Migrasi memerlukan jeda layanan, antrean kosong, cadangan, dan login ulang seluruh pengguna.

## Follow-up

* [ ] Catat aturan Angular pada konteks area web bila konteks agen ditambahkan. Saat desain dibuat, tidak ada AGENTS.md atau CLAUDE.md proyek; skill ini tidak membuatnya.
* [ ] Selaraskan bagian auth yang kini usang pada spec data, email, dan UI dengan kontrak pengganti ini. Jangan mengubah keputusan lain atau menganggap fitur lama kehilangan seluruh buktinya.
* [ ] Bukti SMTP nyata dan perangkat passkey fisik tetap diperlukan sesuai gerbang proyek. SMTP sink dan authenticator virtual bukan bukti pengiriman nyata atau perangkat fisik.

## Rationale

Alasan dan alternatif ada pada [rationale.md](rationale.md).
