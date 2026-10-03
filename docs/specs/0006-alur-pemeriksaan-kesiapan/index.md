# 0006. Alur pemeriksaan kesiapan lintas aplikasi

**Date**: 2026-10-03
**Status**: Proposed

## Summary

Halaman development pada `/` menunjukkan apakah backend masih dapat membaca metadata PostgreSQL setelah aplikasi mulai berjalan. Hasilnya berasal dari SDK, proxy, dan satu route backend yang memakai role runtime. Pengembang dapat mengulang pemeriksaan secara manual ketika database pulih.

## Requirements

**User stories**: Sebagai pengembang, Anda dapat melihat status database, waktu cek, dan jumlah migration terapan dari halaman aplikasi. Ketika pemeriksaan gagal, Anda mendapat pesan aman dan dapat mencoba lagi tanpa perlu memulai ulang frontend.

**Acceptance criteria**:

1. **AC-1**: `GET /api/readiness` tanpa parameter atau body hanya ada pada komposisi backend development yang mendengar pada loopback. Route tidak memerlukan login karena hanya untuk development lokal; komposisi production menjawab 404. Query parameter atau body tambahan ditolak dengan HTTP 400 dan respons aman, tanpa query database. `GET /api/status` tetap menjawab proses saja tanpa menyentuh database.
2. **AC-2**: Dengan `DATABASE_URL` role `foundation_backend` dan metadata yang dapat dibaca, route menjalankan `COUNT(*)` pada `common.schema_migrations` memakai pool backend yang sudah dibuat sekali. HTTP 200 mempunyai JSON tepat `{ "status": "available", "checkedAt": <ISO 8601 UTC>, "appliedMigrations": <integer >= 0> }`. Nilai nol tetap berarti database dapat dibaca. Route tidak menulis database, tidak membandingkan file migration, dan tidak mengirim nama maupun checksum; kelengkapan migration tetap diperiksa oleh `doctor` fitur 2.
3. **AC-3**: URL database hilang, koneksi terputus, hak `SELECT` ditolak, atau query melewati batas membuat route menjawab HTTP 503 dalam paling lama lima detik dengan JSON tepat `{ "status": "unavailable", "checkedAt": <ISO 8601 UTC> }`. Respons dan log tidak memuat DSN, password, SQL mentah, nama role, stack, atau rincian koneksi. Route status proses dan frontend tetap hidup agar pengembang dapat mencoba lagi.
4. **AC-4**: Paling banyak satu pemeriksaan database dari route ini aktif per proses backend. Request serentak berikutnya tidak mengantre query dan mendapat HTTP 429 dengan JSON tepat `{ "status": "busy" }`; setelah pemeriksaan pertama selesai, request baru dapat berjalan. Semua respons route memakai `Cache-Control: no-store`. Batas respons lima detik mencakup menunggu koneksi dan query. Saat batas terlewati, backend meminta pembatalan query dan tetap menahan penanda aktif sampai query benar benar selesai atau batal, sehingga retry tidak menambah query yang masih tertahan.
5. **AC-5**: Pada Angular mode development, route halaman `/` memakai default layout wrapper dan satu panel ringkas dari komponen publik `@ojiepermana/angular`. Halaman meminta hasil saat dibuka, lalu hanya saat tombol Muat ulang atau Coba lagi dipilih, tanpa polling. State loading, tersedia, dan gagal jelas; kontrol tidak dapat dikirim ulang selama request aktif. Hasil tersedia menunjukkan status, `checkedAt` dari server dalam waktu lokal browser, dan jumlah migration termasuk nol. Respons 503 atau 429 memberi pesan aman dan retry; kegagalan jaringan memberi pesan aman tanpa waktu cek. Setelah cek ulang gagal, jumlah dan status sukses sebelumnya dihapus.
6. **AC-6**: Pada build frontend production, `/` tetap halaman pengantar non diagnostik. Halaman diagnostik tidak muncul melalui navigasi production. Tidak ada DSN, SQL, stack, credential, atau detail metadata selain jumlah yang masuk ke HTML, bundle, respons, log, atau artefak test. Tampilan development dapat dipakai dengan keyboard, mengumumkan perubahan status untuk pembaca layar, dan bekerja pada lebar 375 px serta 1280 px tanpa informasi yang terpotong.
7. **AC-7**: Backend mengekspor schema respons 200, 400, 429, dan 503 serta `operationId` stabil ke `openapi.json`; `api:sync` meregenerasi SDK Angular tanpa perubahan manual pada artefak. Halaman memakai adapter fitur yang memanggil operasi SDK melalui proxy `/api`, tanpa DTO HTTP buatan tangan. Pengujian pada PostgreSQL 18 terisolasi membuktikan alur browser sukses, database berhenti setelah startup lalu 503 dan retry setelah pulih, 400, 429, batas waktu, production 404, isolasi credential, serta sinkronisasi OpenAPI dan SDK tanpa mock database.

## Decision

**Chosen option**: Satu route baca metadata khusus development dan satu panel Angular pada `/`, memakai pool backend serta SDK yang sudah ada.

Route ini memeriksa keterjangkauan database saat request. Ia tidak menggantikan `doctor`, yang memeriksa role dan seluruh checksum migration sebelum `serve`. Production tidak memasang route diagnostik dan frontend production menampilkan halaman pengantar yang sudah ada.

**Implementation skills**: `angular-developer` (`.agents/skills/angular-developer/SKILL.md`) · `elysiajs` (`.agents/skills/elysiajs/SKILL.md`). Aturan proyek untuk Angular, UI, database, keamanan, dan OpenAPI tetap mengikat implementasi.

## Feature design

**Data model sketch**:

| Objek | Kolom yang dipakai | Relasi | Hak fitur ini |
| --- | --- | --- | --- |
| `common.schema_migrations` dari spec 0004 | `name text` sebagai primary key; `checksum text`; `applied_at timestamptz` | Tidak ada FK | `SELECT COUNT(*)` oleh `foundation_backend` |

Tidak ada entitas, migration, seed, atau grant baru. Schema `common` dan role runtime mengikuti spec 0004; runner spec 0005 satu satunya penulis riwayat.

**State transitions**: Halaman `loading` saat dibuka → `available` setelah HTTP 200 atau `failed` setelah respons gagal. Muat ulang dari `available` atau Coba lagi dari `failed` kembali ke `loading` dan menghapus hasil lama. Satu request aktif pada halaman; tidak ada polling. Backend `idle` → `checking` → `idle`; request lain selama `checking` menerima 429 tanpa menambah query.

**API surface**:

| Endpoint | Masukan | Hasil | Akses | Kesalahan penting |
| --- | --- | --- | --- | --- |
| `GET /api/readiness` | Tidak ada query atau body | 200 `available`, waktu ISO UTC, jumlah migration | Tanpa login, development loopback saja | 400 input tambahan; 429 pemeriksaan aktif; 503 database tidak tersedia atau timeout; production 404 |

HTTP 400 memakai bentuk error aman yang sudah dipakai komposisi backend, `{ "error": "Invalid request" }`. HTTP 200, 400, 429, dan 503 dideklarasikan pada schema Elysia dan OpenAPI. Seluruh respons endpoint memuat `Cache-Control: no-store`. Backend membuat `checkedAt` setelah hasil pemeriksaan atau kegagalan diketahui; 429 dan 400 tidak mempunyai waktu cek karena query tidak dijalankan.

**Value sourcing**:

| Aksi | Nilai yang dihasilkan atau ditampilkan | Sumber |
| --- | --- | --- |
| Backend 200 | `status = available` | Query `SELECT COUNT(*)` pada `common.schema_migrations` berhasil |
| Backend 200 | `appliedMigrations` | Hasil agregat `COUNT(*)`, dipetakan ke integer nonnegatif |
| Backend 200 atau 503 | `checkedAt` | Jam server saat pemeriksaan selesai atau gagal, diserialkan ISO 8601 UTC |
| Backend 503 | `status = unavailable` | URL runtime tidak ada, koneksi atau query gagal, atau batas lima detik terlampaui |
| Backend 429 | `status = busy` | Penanda satu pemeriksaan aktif di proses backend |
| Frontend | Status, waktu, dan jumlah | Respons SDK; waktu ISO diformat menurut lokal dan zona waktu browser |
| Frontend | Pesan gagal dan label retry | Status HTTP 503 atau 429, atau error jaringan; teks aman tetap pada fitur frontend |
| Frontend | Halaman diagnostik atau pengantar | Mode build Angular development atau production |

**Key invariants**:

1. Pool `Bun.SQL` dibuat paling banyak sekali oleh lifecycle `index.ts` ketika `DATABASE_URL` tersedia, dipakai ulang oleh route, dan ditutup saat shutdown sesuai spec 0004. Komposisi `app.ts` dapat diekspor tanpa pool maupun koneksi aktif; route yang dipanggil tanpa pool menjawab 503.
2. Satu pemeriksaan aktif memakai batas respons total lima detik, termasuk koneksi yang sudah dibatasi tiga detik oleh pool. Query diberi batas server yang lebih pendek dari batas total. Bila deadline client tercapai lebih dulu, `Bun.SQL` diminta membatalkan query; penanda aktif baru dilepas saat operasi itu selesai atau batal. Jika PostgreSQL belum dapat memproses pembatalan, respons pertama tetap 503 dan retry sementara mendapat 429. Tidak ada antrean request diagnostik.
3. GET hanya membaca metadata dengan nama schema tetap dan tanpa input SQL dari client. Error database dipetakan ke respons aman yang sama. Penghitungan nol tidak dianggap kesalahan koneksi; `doctor` tetap menolak migration kosong atau tertinggal sebelum `serve`.
4. Halaman memakai SDK yang berasal dari OpenAPI dan proxy same origin. Saat request baru dimulai, hasil lama tidak ditampilkan sebagai hasil saat ini. Jika request baru gagal, jumlah lama tetap kosong. Status `busy` tidak menyebabkan retry otomatis; pengembang memilih Coba lagi.
5. Tidak ada gambar atau aset eksternal untuk panel diagnostik. Susun satu `Card` dari entry point publik `@ojiepermana/angular/component/card` dan tombol dari `@ojiepermana/angular/component/button`; status berupa teks yang diumumkan melalui `aria-live`. Style lokal hanya mengatur komposisi. Build production tetap memakai pengantar tanpa memanggil endpoint diagnostik.

**Security model**: Developer lokal yang dapat membuka listener loopback dapat membaca jumlah migration, tanpa autentikasi. Production tidak mengekspos route ini. Tidak ada akses `users` atau `auth`, DDL, atau hak tulis metadata. Batas input, satu query aktif, timeout, `no-store`, dan respons yang dipetakan eksplisit menahan konsumsi resource serta kebocoran detail internal. Jangan memasukkan URL database atau error mentah ke browser, log, JUnit, maupun bundle.

**Configuration required**: `DATABASE_URL` yang sudah ditetapkan spec 0004 memakai role `foundation_backend`; tidak ada variable, secret, atau layanan baru. `serve` tetap mengharuskan preflight database melalui fitur 2, sedangkan backend yang dijalankan langsung tanpa URL memberi 503 pada route ini.

**Critical test scenarios**:

1. `READY-001`: PostgreSQL 18 yang diprovision dan dimigrasi memberi 200 dengan waktu ISO dan jumlah tepat melalui backend, SDK, proxy, dan halaman pada browser. Buktikan tampilan loading, sukses, manual refresh, lebar 375 px dan 1280 px, serta keyboard. Uji angka nol dengan backend yang dijalankan langsung pada database yang sudah diprovision tetapi belum dimigrasi; `serve` tetap ditahan oleh `doctor` pada kondisi itu. Membuktikan **AC-1**, **AC-2**, **AC-5**, **AC-6**, **AC-7**.
2. `READY-002`: backend tanpa URL, database dihentikan setelah aplikasi siap, privilege SELECT dicabut pada fixture, dan query lambat memberi 503 dalam lima detik tanpa detail sensitif; route status tetap 200. Browser menunjukkan gagal, menghapus hasil lama, dan pulih lewat Coba lagi setelah database kembali. Membuktikan **AC-3**, **AC-5**, **AC-7**.
3. `READY-003`: dua request bersamaan membuat satu query dan satu 429, kemudian request berikutnya dapat berhasil; input tambahan mendapat 400 tanpa query; semua respons mempunyai `no-store`. Membuktikan **AC-1**, **AC-4**, **AC-7**.
4. `READY-004`: backend production memberi 404, frontend production tetap halaman pengantar, dan artefak frontend serta log/JUnit tidak memuat credential sintetis. OpenAPI/SDK dapat diregenerasi identik. Membuktikan **AC-1**, **AC-6**, **AC-7**.

## Build plan

Urutan mengikuti Tracer Bullet pada scope: satu alur tipis backend, SDK, frontend, dan database nyata dibuktikan dulu; batas gagal dan operasi berikutnya diperkuat pada alur yang sama.

1. Tambahkan route development dan injeksi pool dari lifecycle backend. Kembalikan jumlah migration, waktu server, serta 503 aman; ekspor OpenAPI dan SDK, lalu tampilkan hasil melalui adapter SDK dan panel `/`. Jalankan request nyata dan satu pemeriksaan browser terhadap PostgreSQL 18 terisolasi. Memenuhi **AC-1** sampai **AC-3**, **AC-5**, **AC-7**.
2. Lengkapi validasi 400, batas lima detik, satu pemeriksaan aktif dan 429, `no-store`, serta penutupan query. Lengkapi state retry dan kegagalan jaringan, pastikan route serta halaman diagnostik tidak aktif pada production. Memenuhi **AC-1**, **AC-3** sampai **AC-6**.
3. Tambah test backend dan Playwright dengan database nyata untuk kegagalan sesudah startup dan pemulihan, respons bersamaan, akses negatif, keyboard, dua lebar layar, serta scan secret. Perbarui registry skenario, jalankan `api:sync`, `api:check`, build, dan gate yang relevan; catat bukti kandidat. Memenuhi **AC-1** sampai **AC-7**.

## Consequences

**Positive**: Pengembang melihat koneksi database melalui alur browser yang sama dengan aplikasi, termasuk kondisi ketika database hilang setelah startup. URL dari `serve` dapat dibuktikan sampai ke metadata nyata.

**Negative**: Route diagnostik menambah query serta state concurrency pada backend. Batas lima detik dan penolakan 429 membuat sebagian pemeriksaan perlu dicoba ulang secara manual saat database lambat.

**Neutral**: Jumlah migration bukan bukti checksum atau kesiapan release; `doctor` dan runner tetap menangani itu. Fitur ini tidak mengubah schema dan tidak menambah worker.

## Follow-up

1. Fitur 2 memakai alur browser ini untuk menyelesaikan TOOL-007 dan review doctor/serve terhadap aplikasi nyata.
2. Fitur 11 menetapkan jalur CI untuk PostgreSQL serta Playwright dengan database nyata. Fitur 13 merancang health endpoint production dan kontrol aksesnya secara terpisah bila dibutuhkan.

## Rationale

Alasan dan pilihan yang dibandingkan ada di [rationale.md](rationale.md).
