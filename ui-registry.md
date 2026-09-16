# UI Registry

## Foundation, 2026-09-16

### Shell dan navigasi

Library: `LayoutWrapperDefault`, sidebar pada desktop, drawer bawaan pada mobile. Surface `flat`, appearance `flat`, width `full`. Brand Foundation dengan inisial F. Aksen `teal`, neutral `zinc`, radius `md`, space `normal`. Gunakan API input library dan jangan mengubah implementasi package.

### Halaman akun

`Layout` dan `LayoutFluid` dengan surface `grid`. Brand di atas kartu, `CardHeader` dengan judul `text-2xl tracking-tight`, deskripsi `text-muted-foreground`, form `grid gap-5`. Tombol utama penuh; tombol passkey `outline`. Footer menggunakan teks kecil berwarna muted. Gunakan `Input`, `Label`, `Button`, dan icon library.

### Heading dan kartu halaman

Heading memiliki eyebrow uppercase kecil, judul semibold dengan tracking rapat, dan deskripsi muted. Konten halaman memakai kelas `.page` dan spacing berbasis `--spacing-base`. Kartu menggunakan `Card`, `CardHeader`, `CardTitle`, `CardDescription`, dan `CardContent`. Warna selalu token semantik `background`, `card`, `muted`, `border`, `foreground`, `primary`.

### Form

Label di atas kontrol dalam `.field`. Error `.field-error`; pesan lintas form `.notice.notice-error` dengan `role=alert`. Hasil berhasil `.notice.notice-success` dengan `role=status`. Submit dinonaktifkan saat proses. Kata sandi menggunakan atribut autocomplete yang sesuai. Konfirmasi tindakan berisiko ditampilkan dalam panel yang sama.

### Daftar dan empty state

Daftar pengguna memakai pemisah `divide-border`, informasi pendamping `text-xs text-muted-foreground`, dan status dengan teks dalam badge netral. Empty state menampilkan ikon, judul jelas, serta petunjuk singkat. Placeholder bisnis diberi label `Belum tersedia`; jangan mengisinya dengan angka atau aktivitas buatan.

### Perilaku aksesibilitas

Pertahankan fokus bawaan library. Semua ikon dekoratif mengikuti komponen `Icon`. Tombol ikon memiliki accessible name. Drawer mobile memiliki label Indonesia. Hindari horizontal overflow; susun ulang baris menjadi blok pada layar kecil. Hormati `prefers-reduced-motion`.
