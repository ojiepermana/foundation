# Rationale: kerangka UI dan navigasi

## Konteks

Scope 7 meminta kerangka aplikasi dan navigasi awal yang dapat digunakan, sedangkan frontend saat ini hanya memiliki satu halaman root statis. Proyek sudah memilih `@ojiepermana/angular` beserta default layout wrapper. Aturan frontend melarang pembuatan ulang komponen wrapper atau import file internal package.

Halaman nyata pertama adalah alur kesiapan pada fitur 10. Draft spec 0006 mencatat `/` sebagai route halaman tersebut; proyek juga sudah memakai 1280×812 dan 375×812 sebagai target browser. Shell memerlukan route minimum dan navigasi yang dapat diakses tanpa memulai pekerjaan API atau database readiness lebih awal.

## Opsi yang dipertimbangkan

### Wrapper bawaan dengan satu tujuan root

Gunakan default layout vertical dan sidebar package, dengan satu link Kesiapan ke `/`. Shell tetap mengikuti design system terpilih dan memberi fitur 10 tujuan stabil. Konsekuensinya, sidebar hanya memiliki satu item sampai fitur tersebut dibangun.

**Kelebihan**:
- Memakai API UI publik yang telah dipilih dan rencana route yang sudah ada.
- Browser dapat memverifikasi navigasi desktop dan mobile sebelum integrasi backend.

**Kekurangan**:
- Navigasi memiliki satu item sampai fitur 10 memperluas alur.

### Pertahankan layout kosong sampai fitur 10

Biarkan halaman root tanpa navigasi dan tunda konfigurasi wrapper. Cara ini menghindari sidebar sementara dengan satu item, tetapi kriteria navigasi scope 7 tidak terpenuhi.

**Kelebihan**:
- Menghindari state navigasi sementara.

**Kekurangan**:
- Tidak menyediakan kerangka minimum yang diminta scope 7.

### Bangun kerangka aplikasi sendiri

Buat komponen header, sidebar, dan drawer mobile lokal. Cara ini memberi layout sementara yang unik, tetapi menduplikasi package terpilih dan menambah perilaku keyboard serta responsif yang harus dimiliki aplikasi.

**Kelebihan**:
- Memberi kontrol lokal penuh atas kerangka.

**Kekurangan**:
- Bertentangan dengan aturan Angular dan UI serta menduplikasi wrapper terpasang.

## Alasan pemilihan

Wrapper bawaan adalah pilihan eksplisit proyek. API publik versi terpasang sudah menyediakan sidebar responsif, skip link, kontrol mobile, dan perilaku focus route. Route kesiapan dan ukuran viewport sudah tercatat untuk alur awal. Keputusan ini membuat scope 7 menjadi kerangka nyata yang dapat diperluas oleh fitur 10 tanpa memperkenalkan design system atau kontrak data baru.
