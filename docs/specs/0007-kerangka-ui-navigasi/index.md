# 0007. Kerangka UI dan navigasi

**Date**: 2026-10-03
**Status**: Accepted

## Summary

Shell aplikasi memakai wrapper layout `@ojiepermana/angular` yang sudah terpasang, dengan layout vertical dan sidebar bawaan. Satu menu Kesiapan membuka halaman root saat ini; fitur 10 kelak mengisinya dengan alur readiness nyata. Shell tidak menambah database, API, atau penanganan credential.

## Requirements

**User stories**:
- Sebagai pengembang Foundation, saya ingin shell navigasi yang konsisten agar dapat membuka alur awal melalui desktop dan mobile.

**Acceptance criteria**:
- **AC-1**: Root Angular memakai `LayoutWrapperDefault` dari export publik `@ojiepermana/angular/theme/layout/wrapper`. Layout dan navigasi memakai default package, yaitu vertical dan sidebar. Kode tidak mengimpor file internal package atau membuat ulang komponen shell.
- **AC-2**: Wrapper memuat router outlet Angular. Satu item navigasi berlabel Kesiapan menuju `/`. Membuka `/` langsung atau memilih item tersebut menampilkan halaman Foundation statis yang ada. Alur data readiness belum termasuk fitur ini.
  - *Amandemen 2026-10-06 (spec [0014](../0014-akses-pengguna-lifecycle-sesi/index.md), tabel Halaman)*: navigasi statis memuat item `Akun` menuju `/akun` di semua build (production: Beranda, Akun; development: Beranda, Akun, Kesiapan). Navigasi dan shell tetap tidak memanggil API; input `user` wrapper diisi dari state sesi di memori bila sudah diketahui.
- **AC-3**: Shell menyediakan skip link berlabel, kontrol navigasi mobile berlabel `Buka navigasi` dan `Tutup navigasi`, serta indikator focus keyboard yang terlihat. Pengguna keyboard dapat membuka dan menutup navigasi mobile, mengaktifkan route, dan mencapai konten utama. Setelah route berubah, focus berpindah ke landmark konten utama. Memilih item pada drawer mobile menutup drawer dan mengembalikan focus sesuai perilaku wrapper.
- **AC-4**: Pada ukuran 1280×812 dan 375×812, shell serta konten root dapat digunakan tanpa overflow horizontal atau label navigasi terpotong. Pada 375×812, kontrol wrapper membuka dan menutup navigasi.
- **AC-5**: Halaman root tidak membuat request ke API/backend dan tidak mengimpor SDK, backend, worker, atau modul server. Bundle production tidak memuat credential atau URL database.
- **AC-6**: Path aplikasi yang tidak dikenal diarahkan ke route root, bukan halaman kosong atau error router yang tidak tertangani.

## Decision

**Chosen option**: Gunakan wrapper bawaan dengan layout vertical dan navigasi sidebar, lalu hubungkan satu item Kesiapan ke route root.

Wrapper dan export publik mengikuti `docs/rules/angular.md` serta `docs/rules/ui-ux.md`. Default versi terpasang adalah `layout-type="vertical"` dan `nav-type="sidebar"`. Wrapper mengaktifkan focus konten setelah navigasi melalui `focus-on-navigation="true"`, memakai skip link `Ke konten utama`, label mobile `Buka navigasi` dan `Tutup navigasi`, serta menutup drawer saat item dipilih. Focus kembali mengikuti perilaku wrapper saat drawer ditutup. Route root dan target viewport mengikuti baseline browser spec 0001; draft spec 0006 juga menempatkan halaman readiness pada `/`. Fitur 10 memiliki request readiness dan mengganti isi statis halaman. Kontrak Scope 10 tetap perlu diratifikasi pada fiturnya.

## Feature design

**Data model sketch**: Tidak ada data persisten, migration, seed, atau akses database.

**API surface**: Tidak ada. Halaman root masih statis dan tidak memakai SDK generated.

**Value sourcing**:

| Aksi | Nilai yang dihasilkan atau ditampilkan | Sumber |
| --- | --- | --- |
| Menampilkan brand aplikasi | `Foundation` | Nilai `brand` yang sudah ada di `apps/frontend/src/app/app.ts` |
| Menampilkan navigasi | Label `Kesiapan`, route `/` | Halaman root yang sudah ada dan route alur awal pada draft spec 0006 |
| Menampilkan halaman statis | Judul dan teks pengantar Foundation | Template root yang sudah ada di `apps/frontend/src/app/app.html` |
| Memilih ukuran verifikasi responsif | 1280×812 dan 375×812 | Baseline browser spec 0001 dan target viewport draft spec 0006 |

**Key invariants**:
- Shell aplikasi menggunakan wrapper publik yang terpasang. Jangan membuat ulang header, sidebar, atau drawer mobile.
- Konten halaman berada pada route root dan komponen route sesuai fitur. Fitur ini tidak membuat komponen placeholder global.
- Data navigasi bersifat statis dan tidak memuat identitas pengguna, permission, credential, atau state dari API.
- Fitur 10 dapat mengganti konten root sambil mempertahankan route dan kontrak wrapper.

**State transitions**:
- Saat halaman dibuka pada viewport mobile, drawer navigasi tertutup. Kontrol berlabel membuka drawer; Escape atau kontrol tutup menutupnya; memilih Kesiapan menavigasi ke `/` dan menutup drawer. Focus mengikuti perilaku pemulihan wrapper ketika drawer ditutup.
- Setelah perubahan route yang berhasil, wrapper memindahkan focus ke landmark konten utama agar judul halaman tersedia bagi pengguna keyboard dan pembaca layar.

**Security model**: Halaman root dan navigasi tidak memuat data sensitif dan tidak membuat request. Visibilitas UI bukan batas authorization. Backend dan authorization runtime tetap tanggung jawab fitur API.

**Configuration required**: Tidak ada.

**Critical test scenarios**:
- Happy path: buka `/`, pilih Kesiapan, dan pastikan halaman root tampil pada kedua viewport; membuktikan **AC-1**, **AC-2**, dan **AC-4**.
- Aksesibilitas: gunakan keyboard, skip link, serta buka dan tutup navigasi mobile; membuktikan **AC-3** dan **AC-4**.
- Failure case: buka path yang tidak dikenal dan pastikan diarahkan ke `/`; membuktikan **AC-6**.
- Security: periksa request browser dan bundle production untuk memastikan tidak ada request API/backend atau credential; checker mem-parsing bentuk import TypeScript serta menolak modul runtime/server, sementara fixture produksi harus menolak URL database, private key, dan credential sintetis tanpa mencetak nilainya; membuktikan **AC-5**. Authorization tidak berlaku untuk shell statis karena tidak menampilkan data terlindungi.

## Build plan

Pendekatan Tracer Bullet dimulai dari shell dan route root yang nyata, lalu memverifikasi navigasi serta alur keyboard pada baseline browser proyek.

1. Integrasikan wrapper layout publik, router outlet, item navigasi statis, dan route root sambil mempertahankan konten halaman yang ada. Memenuhi **AC-1** dan **AC-2**.
2. Tambahkan fallback path tidak dikenal serta atur skip link, focus, dan label navigasi mobile pada wrapper. Memenuhi **AC-3** dan **AC-6**.
3. Verifikasi tampilan responsif dan interaksi pada kedua viewport, lalu periksa request browser serta bundle production dari import server atau credential. Memenuhi **AC-4** dan **AC-5**.

## Consequences

**Positive**: Alur awal memiliki shell aplikasi nyata yang memakai library proyek, dan fitur readiness dapat mengisi route root yang sama.

**Negative / tradeoffs**: Sidebar dengan satu item terlihat minim sampai fitur 10 menambah halaman readiness. Route root sengaja masih statis sampai fitur tersebut dibangun.

**Neutral**: Tidak ada perubahan database, backend, SDK, atau worker. Pembaruan package layout dapat mengubah default, sehingga API publik versi terpasang perlu diperiksa kembali ketika versinya berubah.

## Follow-up

- Ratifikasi atau revisi route `/` pada spec 0006 sebelum membangun alur readiness fitur 10.
