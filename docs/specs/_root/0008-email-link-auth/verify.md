# Verifikasi autentikasi dengan tautan email

Dokumen ini adalah rencana bukti untuk [spec 0008](index.md), bukan laporan keberhasilan. Seluruh skenario di bawah belum dijalankan terhadap implementasi baru. Anda dapat memperbarui suite yang ada terlebih dahulu, tanpa membuat kerangka pengujian baru.

## Matriks skenario

| AC | Pemeriksaan yang dapat membantah implementasi |
| :--- | :--- |
| AC-1 | Email active, tidak dikenal, dan disabled memberi respons 202 dengan bentuk, pesan, mode, dan kebijakan cookie yang sama setelah pembatas lolos. Hanya active atau pending mendapat outbox; email baru tidak membuat user. Email salah memberi 422. |
| AC-2 | CLI nyata membuat pending dan email menuju /login tanpa token. Normalisasi dan duplikat tetap benar. Login email pertama mengisi activated_at dan membuat sesi; replay tidak mengaktifkan ulang. Kirim ulang CLI menolak akun selain pending. |
| AC-3 | ENV hilang, kosong, atau salah menolak startup. Same_browser berhasil pada context peminta dan gagal pada context baru tanpa mengonsumsi token. Cross_device berhasil pada context kedua dan tidak membuat sesi pada context peminta. |
| AC-4 | Membuka atau memindai callback, termasuk JavaScript tanpa menekan tombol, tidak mengonsumsi token. Fragment hilang dari URL. POST setelah konfirmasi menghasilkan satu sesi. Dua POST bersamaan hanya memiliki satu pemenang. Kegagalan penyimpanan sesi membatalkan konsumsi token dan aktivasi. |
| AC-5 | Schema baru tidak memiliki password_hash atau constraint password. Tidak ada field password pada login, aktivasi, reset, profil, dan konfirmasi ulang. Keenam endpoint lama memberi 410 tanpa mengubah sesi atau token. Password SMTP tetap berfungsi. |
| AC-6 | Cookie memiliki HttpOnly, SameSite=Lax, Path=/, serta Secure pada HTTPS; token mentah tidak ada pada DTO. Reload dan logout sesuai kontrak. Origin atau CSRF salah ditolak. Pengguna biasa tidak dapat mengelola user lain; balapan penurunan admin terakhir tetap dilindungi. Disable membatalkan sesi dan token. |
| AC-7 | Login email dan passkey yang diverifikasi membuka jendela 5 menit. Pada umur 300 detik, perubahan passkey ditolak. Konfirmasi ulang memakai email sesi, menolak sesi lain atau akun lain, menolak token login, dan hanya memperbarui sesi peminta. Token konfirmasi tidak bisa dipakai untuk login. Logout sebelum verifikasi menggagalkan token konfirmasi. |
| AC-8 | Jeda 60 detik dan batas 3 per 15 menit berlaku atomik pada request bersamaan, juga lintas endpoint login dan konfirmasi ulang. Email tidak dikenal mendapat kebijakan sama. Retry-After berasal dari TTL Redis. Redis mati memberi 503 tanpa penerbitan token. Batas IP yang ada tetap berlaku. |
| AC-9 | Insert outbox gagal membatalkan token dan pembatalan token sebelumnya. Setelah commit, gangguan Redis relay atau SMTP tidak menghilangkan outbox. Retry SMTP memakai token dan expiry yang sama; email duplikat tidak membuka sesi kedua. Email terlambat tidak memperpanjang token. |
| AC-10 | Uji email kosong atau salah, status sibuk, resend, 429, layanan gagal, token hilang, dan passkey dibatalkan. Akun A membuka tautan B menghasilkan konflik tanpa konsumsi, logout A lalu konfirmasi token B berhasil. Tidak ada pemeriksaan token awal. Fokus keyboard, label, pesan teknologi bantu, dan layout desktop serta mobile tetap benar. |
| AC-11 | Resend membuat tautan lama gagal. Balapan resend dan verifikasi memiliki urutan transaksi yang sah. Token malformed, expired, consumed, salah purpose, salah browser, dan mode lama tidak membuat sesi. Pergantian same_browser ke cross_device lalu kembali tidak menghidupkan token awal. Respons yang hilang tidak dapat dipulihkan dengan replay token. |
| AC-12 | TTL default 900 dan batas config 60 sampai 1800 diuji tanpa menunggu waktu nyata. Cleanup startup dan timer hanya menghapus token yang memenuhi cutoff 7 hari, memakai maksimal 10 batch per putaran. Dua worker dan kegagalan DB tidak menghapus token baru atau menghentikan pengiriman. Shutdown membatalkan timer. |
| AC-13 | Migrasi dari 0002 dengan seluruh status user dan passkey mempertahankan data yang wajib, mencabut sesi dan challenge lama, serta membatalkan token action lama. Active tanpa activated_at menggagalkan migrasi tanpa perubahan parsial. Outbox belum selesai menghalangi peralihan. Latih pemulihan sebelum trafik baru diterima. |

## Suite yang digunakan

Anda dapat memperbarui [tes auth integrasi](../../../../tests/integration/auth.test.ts), [tes operasi](../../../../tests/integration/operations.test.ts), [tes mail integrasi](../../../../tests/integration/mail.test.ts), [tes keamanan unit](../../../../tests/unit/security.test.ts), dan [tes mail unit](../../../../tests/unit/mail.test.ts). Uji pembatas dan pembersihan dapat memakai suite auth dan operasi yang ada. Fixture yang masih membutuhkan password ikut berubah dalam irisan terkait.

Frontend memakai [tes halaman auth](../../../../apps/web/src/app/auth-page.spec.ts), [tes API frontend](../../../../apps/web/src/app/api.spec.ts), [alur layanan nyata](../../../../tests/e2e/flow.spec.ts), dan [tes UI](../../../../tests/e2e/ui.spec.ts). Test browser memakai context terpisah agar bukti mode perangkat tidak hanya mengganti cookie pada browser yang sama.

Setelah implementasi dan layanan uji siap, Anda dapat menjalankan pemeriksaan berikut secara bertahap:

```sh
bun test --timeout 30000 tests/integration/auth.test.ts tests/integration/operations.test.ts tests/integration/mail.test.ts
bun test tests/unit/security.test.ts tests/unit/mail.test.ts
bun run test:web
bun run test:e2e --grep 'Live services'
bun run test:e2e -- tests/e2e/ui.spec.ts
bun run check
```

Nama tes layanan nyata dan konfigurasi fixture dapat diperbarui selama implementasi. Jalankan alur nyata untuk kedua nilai AUTH_EMAIL_LINK_MODE pada instance yang terisolasi atau secara berurutan. Jangan menjalankan dua mode pada database yang sama secara bersamaan. Tes expiry memakai timestamp atau clock terkontrol, bukan menunggu 15 menit atau 7 hari.

## Verifikasi layanan nyata

1. Pada lingkungan uji, Anda dapat menjalankan PostgreSQL, Redis, API, worker, frontend, dan SMTP sink. Gunakan akun pengujian yang sah. Catat mode ENV tanpa mencatat secret.
2. Dari CLI, buat pending dan periksa email undangan. Buka halaman masuk, minta tautan, lalu buka callback pada browser peminta. Sebelum menekan tombol, periksa bahwa belum ada konsumsi token atau sesi baru.
3. Setelah konfirmasi, periksa dashboard, aktivasi, cookie, reload, dan logout. Ulangi dengan token baru pada browser lain untuk membuktikan penolakan same_browser.
4. Hentikan API, pilih cross_device, dan mulai kembali. Tautan mode lama harus gagal. Minta tautan baru pada browser pertama dan konfirmasikan pada browser kedua. Hanya browser kedua memperoleh sesi.
5. Ulangi dalam urutan mode sebaliknya. Token yang pernah dibatalkan tetap gagal ketika mode asal dipakai kembali. Uji cookie hilang, browser dalam aplikasi email, tautan lama sesudah resend, dan respons verifikasi yang diputus.
6. Di profil, uji tambah dan hapus passkey dengan bukti terbaru serta setelah jendela habis. Tautan konfirmasi ulang yang dibuka pada sesi lain tetap gagal meskipun mode login cross_device.
7. Anda dapat menguji pengiriman pada SMTP sebenarnya dengan akun milik penguji setelah operator menyediakan konfigurasi. SMTP sink hanya membuktikan integrasi lokal, bukan keterkiriman email nyata.

## Penerimaan passkey fisik

Gerbang auth/passkey tetap GA. Review kode auth yang baru dan authenticator virtual diperlukan, tetapi tidak menggantikan perangkat fisik. Anda dapat mengulangi pengujian pada origin yang sesuai konfigurasi RP dan mencatat OS, browser, jenis authenticator, tanggal, dan hasil, tanpa token atau data kredensial rahasia.

1. Masuk melalui email, lalu daftarkan passkey pada profil. Periksa nama kredensial muncul.
2. Logout, masuk dengan passkey, dan pastikan verifikasi pengguna diminta. Login yang berhasil memberikan jendela konfirmasi 5 menit.
3. Sesudah jendela habis, minta email konfirmasi ulang dari profil dan buka pada sesi peminta. Kembali ke profil tanpa perubahan kredensial otomatis.
4. Hapus passkey setelah konfirmasi, lalu periksa kredensial yang dihapus tidak lagi dapat dipakai. Login email tetap tersedia.
5. Batalkan dialog passkey dan periksa UI masih dapat dipakai. Bila Safari termasuk browser target, catat buktinya secara terpisah.

## Catatan hasil

Hasil baru dapat dicatat pada [matriks AC proyek](../../../verification/ac-matrix.md) dan [runbook](../../../verification/operations.md) saat implementasi diverifikasi. Kaitkan AUTH-001 lama ke AC-2, AUTH-002 ke AC-1/AC-3/AC-4/AC-6, AUTH-003 ke AC-5/AC-7/AC-8/AC-11, USER-001 ke AC-6, dan PASSKEY-001 ke AC-7 serta bukti perangkat fisik. Riwayat sebelumnya tetap dapat dibaca, tetapi tidak menutup kriteria baru secara otomatis.
