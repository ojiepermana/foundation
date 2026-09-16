# Verifikasi user, auth dan passkey

## Otomatis

```sh
bun test --timeout 30000 tests/integration/auth.test.ts tests/integration/operations.test.ts
bun run test:e2e --grep 'Live services'
```

| AC | Bukti wajib |
|---|---|
| AUTH-001 | CLI nyata, normalisasi/duplikat email, transaksi outbox, resend membatalkan token lama. |
| AUTH-002 | Aktivasi normal, race/replay/expiry; password login, cookie HttpOnly/SameSite, reload; origin/CSRF salah ditolak. |
| AUTH-003 | Respons forgot generik; token reset sekali pakai; logout/reset/password change mencabut session sesuai kontrak; limiter dan outage Redis menolak permintaan. |
| USER-001 | API dan UI lintas role; disable langsung mencabut akses; last-admin race dilindungi; captured identity setelah demosi tidak dapat membaca daftar user. |
| PASSKEY-001 virtual | Enrollment membutuhkan password reauth; challenge terikat user/session; respons invalid/replay ditolak; CTAP2 resident credential+UV mendaftar, login, terdaftar dan dihapus; passkey login tetap wajib reauth password untuk mutasi kredensial. |

Suite browser memakai layanan nyata dan authenticator virtual Chromium. Review kode auth oleh model terpisah tercatat di [review](../../../reviews/2026-09-16-auth.md). Keduanya tidak menggantikan perangkat fisik.

## Checklist perangkat fisik — belum dilakukan

Pemilik perangkat menjalankan langkah berikut pada akun pengujian yang sah setelah SMTP tersedia. Gunakan `http://localhost:8088` pada komputer yang menjalankan aplikasi. Pengujian perangkat lain memerlukan origin HTTPS dan konfigurasi RP yang sesuai; deployment tersebut di luar scope lokal.

1. Catat tanggal, OS, versi browser, jenis authenticator (misalnya platform atau security key), dan origin. Jangan mencatat token/private key.
2. Aktivasi akun dari email, login password, buka Profil. Konfirmasi password dan daftarkan passkey; selesaikan dialog perangkat. Periksa nama muncul di daftar.
3. Logout lalu pilih Masuk dengan passkey. Selesaikan verifikasi perangkat; dashboard harus menampilkan akun yang benar. Reload tetap authenticated.
4. Batalkan dialog login passkey. UI harus kembali dapat digunakan dan menyediakan login password tanpa membuat session baru.
5. Sesudah login passkey, mutasi passkey tetap membutuhkan konfirmasi password; jangan menganggap biometrik sebagai konfirmasi password.
6. Hapus passkey setelah konfirmasi password. Logout; kredensial yang dihapus tidak lagi memberi akses. Password tetap dapat digunakan.
7. Catat hasil per langkah beserta screenshot yang tidak berisi secret. Jika target browser termasuk Safari, jalankan ulang dan catat secara terpisah.

Tutup `PASSKEY-001-physical` di [matriks](../../../verification/ac-matrix.md) hanya setelah hasil perangkat nyata tersedia. Saat ini status PASSKEY-001 **Sebagian** dan penerimaan GA tetap terbuka.
