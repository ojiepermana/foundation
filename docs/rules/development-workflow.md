# Workflow development

## Scope dan specs berdasarkan fitur

Scope disusun berdasarkan fitur kecil yang dapat diselesaikan dan diverifikasi sebagai satu alur. Hindari scope besar yang menggabungkan banyak kemampuan sekaligus.

Scope menjelaskan hasil yang diinginkan, batas pekerjaan, dan kriteria penerimaan. Specs menjelaskan rancangan implementasi fitur yang sama, termasuk bagian frontend, backend, dan worker yang terlibat.

Satu fitur dapat mencakup beberapa aplikasi. Pengelompokan dokumentasi tidak menentukan urutan pengerjaan. Tidak semua fitur membutuhkan worker.

Jika specs perlu dipecah karena kompleksitasnya, setiap bagian tetap merujuk fitur dan kontrak bersama yang sama.

## Keputusan schema dan keamanan

Saat `/scope` atau `/architect` merencanakan fitur dengan data persisten, tanyakan schema yang digunakan: `common`, `users`, `auth`, atau schema domain lain. Gunakan keputusan yang sudah dinyatakan untuk fitur tersebut tanpa meminta ulang. Fitur lintas schema memerlukan pembagian entitas yang jelas; fitur tanpa perubahan database dicatat tidak memerlukan keputusan schema.

Scope mencatat domain data dan keputusan yang belum tersedia. Specs menetapkan schema per entitas, relasi lintas schema, migration, role/privilege, serta kontrak sebelum bagian implementasi yang bergantung padanya dimulai, sesuai [aturan database](database.md).

Ikuti [aturan keamanan](security.md) sejak perencanaan. Tentukan data sensitif, model autentikasi, permission backend, batas resource, dan skenario penyalahgunaan yang relevan. Subagent menerima keputusan schema dan keamanan bersama kontrak tugasnya; perubahan privilege atau batas akses dikoordinasikan oleh agent utama.

## Menjalankan development

Siapkan layanan pendukung melalui `docker-compose.yml` root sesuai [aturan infrastruktur](infrastructure.md), lalu provision role/schema dan jalankan migration melalui langkah terpisah. Compose hanya untuk infrastruktur, bukan frontend/backend/worker, migration/seed, atau test runner. Doctor dan serve tidak otomatis mengelola Compose.

Jalankan `bun run doctor` untuk memeriksa prasyarat, lalu `bun run serve` untuk frontend port `8889`, backend port `8888`, dan worker yang dipilih melalui `--worker <nama>`. Kedua perintah mengikuti [aturan doctor/serve](development-commands.md).

`serve` otomatis melakukan preflight, kemudian menghentikan listener pada port layanan yang digunakan sebelum startup. Doctor tidak menghentikan proses dan tidak menjalankan migration/seed; ketidaksiapan database diselesaikan melalui runner terpisah. Bila startup atau salah satu layanan gagal, supervisor menghentikan seluruh grup proses invocation tersebut.

## Rencana pembuktian setiap pekerjaan

Setiap pekerjaan mengikuti [aturan testing](testing.md). Sebelum implementasi, tentukan dampak perubahan, kriteria penerimaan yang terkait, ID skenario, jenis test, dan bukti yang dibutuhkan. Target performance dan profil k6 yang diperlukan ditentukan dalam specs, bukan ditebak saat pengujian.

Pilih unit, integration, Playwright, dan k6 sesuai hal yang perlu dibuktikan. Perubahan kecil atau dokumentasi tidak memerlukan seluruh suite; catat pemeriksaan yang relevan dan alasan test lain tidak berlaku.

Ketika test diimplementasikan, hubungkan skenario ke kriteria dalam specs melalui registry `tests/scenarios/`. Kriteria tetap bersumber dari specs; registry memetakan test dan laporan mengumpulkan hasil eksekusinya.

## Kontrak sebelum pekerjaan paralel

Sepakati kontrak yang diperlukan antarbagian sebelum subagent mengerjakan bagian yang bergantung pada kontrak tersebut. Kontrak cukup rinci untuk memulai pekerjaan, tanpa harus menyelesaikan seluruh desain aplikasi.

Kontrak memuat hal yang relevan untuk fitur, seperti:

- Endpoint, input, output, dan respons kesalahan.
- Bentuk pesan atau job yang diterima worker.
- Perilaku yang diharapkan frontend dari backend.
- Contoh payload untuk implementasi dan verifikasi mandiri.

Catat kontrak di specs fitur. Jika tersedia, kode bersama di `libs/contracts/` harus mengikuti kontrak tersebut. Untuk HTTP, route/schema Elysia menghasilkan `openapi.json` root dan SDK Angular; frontend menggunakan tipe dan operasi SDK sesuai [aturan OpenAPI/SDK](openapi-sdk.md), bukan salinan DTO HTTP manual.

## Sinkronisasi backend, OpenAPI, dan SDK

Setiap perubahan backend wajib menjalankan urutan berikut sebelum pekerjaan selesai:

1. Ekspor ulang route/schema backend ke `openapi.json` pada root melalui `api:openapi`.
2. Periksa kontrak dokumen melalui `api:validate` menggunakan script Bun tanpa dependency validator tambahan; cakupan pemeriksaan mengikuti aturan OpenAPI/SDK.
3. Generate ulang SDK dengan schematic `@ojiepermana/angular:sdk` ke `apps/frontend/sdk/` melalui `sdk:generate` dalam mode `standalone`.
4. Sesuaikan pemakaian SDK dalam adapter fitur yang terdampak, lalu jalankan build frontend dan test sesuai perubahan.
5. Periksa artefak yang bertambah, berubah, atau dihapus dan sertakan hasilnya bersama perubahan backend.

Root script `api:sync` menjalankan tiga tahap awal secara berurutan dan berhenti saat gagal. Perubahan internal backend tetap wajib melakukan regenerasi walaupun hasil OpenAPI dan SDK identik. Perubahan schema/dependency bersama yang memengaruhi backend dan perubahan generator/config juga mengikuti alur ini.

Tetapkan satu penanggung jawab `openapi.json` dan `apps/frontend/sdk/` ketika pekerjaan backend berjalan paralel. Regenerasi dilakukan setelah perubahan sumber digabungkan; perubahan backend berikutnya memerlukan regenerasi lagi. Subagent frontend memakai SDK terbaru yang telah divalidasi dan mengomunikasikan dampak kontrak kepada agent utama. Frontend dapat mulai dari kontrak dan respons contoh, tetapi integrasi akhir wajib memakai hasil generate dari backend nyata.

Jangan mengedit OpenAPI atau generated SDK manual. CI menjalankan `api:check` untuk mendeteksi artefak yang tertinggal atau tidak dapat direproduksi sebelum verifikasi frontend yang bergantung pada SDK. Generate, validasi, build, atau test kontrak yang gagal berarti sinkronisasi belum selesai.

## Pembagian tugas subagent

Untuk fitur dengan beberapa bagian yang dapat dikerjakan secara independen, bagi pekerjaan kepada subagent sesuai bagian dan dependensinya. Pekerjaan kecil yang tidak membutuhkan pembagian dapat diselesaikan oleh agent utama.

Agent utama mengoordinasikan pekerjaan. Sebelum delegasi, tentukan untuk setiap subagent:

- Tujuan dan bagian fitur yang menjadi tanggung jawabnya.
- File atau area yang boleh diubah.
- Kontrak, dependensi, dan kriteria penerimaan yang berlaku.
- Cara memverifikasi hasil dan kepada siapa hasil dilaporkan.

Sertakan aturan testing, ID skenario yang menjadi tanggung jawab subagent, batas file test, dan profil performance yang relevan. Tetapkan penanggung jawab untuk integration lintas aplikasi, registry, konfigurasi runner, fixture bersama, dan orchestration test.

Subagent menjalankan tugasnya secara mandiri dalam batas tersebut. Keputusan implementasi lokal tidak memerlukan konfirmasi ulang selama sesuai specs, rules, dan kontrak yang disepakati.

Tetapkan satu penanggung jawab untuk file bersama, termasuk kontrak, konfigurasi root, dan dependency. Koordinasikan kebutuhan perubahan pada file tersebut agar beberapa subagent tidak mengubahnya secara bersamaan atau menimpa pekerjaan lain.

## Pengerjaan mengikuti dependensi

Bagian yang kontraknya sudah jelas dapat dikerjakan secara bersamaan. Jangan menunggu seluruh aplikasi lain selesai jika bagian yang dibutuhkan dapat diwakili dengan respons atau job contoh.

Contoh untuk registrasi pengguna:

| Bagian | Pekerjaan mandiri |
| --- | --- |
| Frontend | Membuat form dengan respons contoh sesuai kontrak. |
| Backend | Membuat endpoint dan menghasilkan job sesuai kontrak. |
| Worker | Memproses job contoh dan menjalankan pengiriman email. |

Tunggu hanya dependensi yang benar-benar diperlukan untuk langkah berikutnya. Respons atau job contoh membantu development, tetapi penyelesaian fitur tetap membutuhkan integrasi nyata.

## Komunikasi antaragent

Subagent berkomunikasi melalui fasilitas koordinasi agent dalam tugas yang sama. Bila komunikasi langsung tidak tersedia, agent utama meneruskan informasi yang diperlukan.

Sampaikan kepada agent utama dan subagent terkait ketika ada perubahan kontrak yang diusulkan, dependensi yang siap dipakai, hambatan, konflik kepemilikan file, atau hasil yang siap diintegrasikan.

Pesan harus menjelaskan konteks, dampak, dan tindakan yang diperlukan. Jangan mengubah kontrak bersama secara sepihak. Agent utama mengoordinasikan perubahan, memperbarui specs, dan menyampaikan kontrak terbaru kepada semua bagian yang terdampak.

Jika terhambat, laporkan kebutuhan yang belum tersedia dan lanjutkan pekerjaan independen yang masih dapat dilakukan.

## Integrasi dan penyelesaian

Setiap subagent memverifikasi bagiannya dan melaporkan perubahan, hasil verifikasi, serta keterbatasan yang masih ada.

Laporan subagent menyertakan perintah yang dijalankan, hasil aktual, ID skenario yang dibuktikan, dan test yang gagal, dilewati, atau belum dijalankan. Jangan menganggap build berhasil atau seluruh tugas agent selesai sebagai bukti seluruh skenario lulus.

Agent utama memastikan seluruh bagian mengikuti kontrak yang sama, mengintegrasikan hasil, dan memverifikasi alur fitur terhadap kriteria penerimaan.

Fitur selesai ketika alur yang diperlukan bekerja bersama dan kriteria penerimaan terpenuhi. Selesainya tugas setiap subagent saja belum cukup untuk menyatakan fitur selesai.

## Pengelompokan commit

Ketika melakukan commit, agent mengelompokkan perubahan berdasarkan tujuan yang koheren dan mudah direview. Perubahan dengan tujuan berbeda dipisahkan menjadi beberapa commit, bukan digabung menjadi satu commit besar hanya karena dikerjakan dalam sesi yang sama.

Aturan ini menggunakan pertimbangan, bukan jumlah file, batas baris, atau kewajiban selalu membuat banyak commit. Satu perubahan kecil atau satu kelompok perubahan yang saling bergantung boleh menjadi satu commit. Jangan memecah perubahan secara buatan hingga tiap commit kehilangan konteks atau tidak dapat digunakan.

Kode, test yang membuktikannya, serta konfigurasi atau dokumentasi yang diperlukan untuk perubahan tersebut dapat berada dalam commit yang sama. Perubahan kontrak backend beserta OpenAPI dan SDK hasil regenerasinya tetap dikelompokkan bersama bila diperlukan untuk menjaga konsistensi. Perubahan independen, seperti perbaikan bug terpisah atau cleanup yang tidak terkait, menjadi kelompok commit lain.

Sebelum commit, periksa diff, tentukan kelompok perubahan, stage hanya file atau bagian yang sesuai, dan tinjau staged diff. Jangan menyertakan pekerjaan pengguna atau perubahan lain yang tidak termasuk kelompok tersebut. Pesan commit menjelaskan perubahan utamanya secara konkret; verifikasi yang relevan tetap mengikuti aturan testing.

## Pembaruan knowledge graph saat commit

Setiap kali melakukan commit, agent memperbarui knowledge graph graphify agar sesuai dengan perubahan yang di-commit. Jalankan `graphify update .` dari root repository setelah staged diff ditinjau. Perintah ini mengekstrak ulang kode melalui AST tanpa API key atau biaya LLM.

Jika perintah menolak menulis karena graph baru lebih kecil, pastikan pengurangan tersebut berasal dari kode yang memang dihapus dalam perubahan, lalu jalankan ulang dengan `--force`. Perubahan dokumen, gambar, atau file non-kode lain tidak ikut diperbarui oleh perintah tersebut; periksa melalui `graphify check-update .`. Bila graph lokal memuat ekstraksi semantik, jalankan `/graphify . --update` untuk perubahan itu atau laporkan bahwa pembaruan semantik masih tertunda.

`graphify-out/` adalah artefak lokal dan tercantum di `.gitignore`; jangan men-stage atau meng-commit isinya. Pembaruan graph yang gagal dilaporkan bersama output perintahnya dan tidak boleh dinyatakan berhasil.

## Pemeriksaan sebelum production release

Agent utama menggabungkan bukti seluruh bagian dan menyiapkan laporan kesiapan menggunakan [template laporan release](../testing/release-report-template.md). Laporan mencatat kandidat build, environment, hasil per skenario, hasil performance, kegagalan, test yang tidak stabil, serta batas bukti.

Sebelum release, seluruh skenario wajib untuk kandidat tersebut harus dijalankan dan memenuhi kriteria. Gunakan unit dan integration yang relevan, regression Playwright untuk alur kritis, serta profil k6 yang ditetapkan. Verifikasi migration dan hasil akhir worker ketika termasuk cakupan perubahan. Pastikan OpenAPI dan SDK sesuai sumber kandidat release melalui `api:check`, build Angular, dan pengujian kontrak yang relevan; sertakan identitas artefak dan bukti generate pada laporan.

Jika bukti wajib belum lengkap, laporkan `incomplete`. Jika skenario wajib gagal, laporkan `blocked`. Laporkan `ready` hanya ketika bukti wajib lengkap dan memenuhi kriteria. Catat pengecualian yang diputuskan tanpa mengubah status hasil test.

Pemeriksaan setiap pekerjaan menjadi bukti awal; pemeriksaan kandidat release memastikan gabungan perubahan bekerja pada build dan environment yang akan digunakan. Perubahan setelah pengujian harus dinilai dampaknya dan diverifikasi ulang pada area terkait.
