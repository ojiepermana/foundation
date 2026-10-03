# Rationale: ekspor dan pemeriksaan kontrak OpenAPI

## Context

> Catatan premis: draft awal spec ini memperluas checker ke arah cakupan OpenAPI umum (tiga versi, `allOf`, schema rekursif, `oauth2`, pointer escape, empat section komponen). Backend dan SDK tidak memakai bentuk itu, dan sebagian justru bertentangan dengan keluaran nyata Elysia. Kerangka yang tepat: checker adalah gerbang antara exporter Elysia dan generator SDK, sehingga subsetnya adalah irisan bentuk yang diekspor Elysia secara bersih dan dibaca generator dengan benar, bukan cakupan standar OpenAPI.

Fitur 4 sudah menyediakan `scripts/export-openapi.ts`, `scripts/validate-openapi.ts`, dan `scripts/check-api.ts`. Exporter membaca komposisi development melalui `app.handle()` tanpa listener, lalu menulis `openapi.json` root. Checker sudah menolak beberapa pelanggaran (versi, `info`, `operationId` duplikat, tag kosong, reference eksternal, siklus sederhana, operasi status wajib), dan suite APP-003 menguji pipeline serta drift SDK. Spec 0001 menyerahkan perluasan checker untuk kontrak fitur berikutnya kepada fitur 8.

Pemeriksaan ulang terhadap kode saat ini menemukan celah nyata:

- Urutan key ekspor memakai `localeCompare`, sehingga hasilnya dapat berbeda antar mesin dengan locale berbeda.
- Pemeriksaan schema hanya meminta `type`, `enum`, atau komposisi, sehingga `{ "type": "foo" }` atau array tanpa `items` lolos.
- Checker menerima bentuk yang diterima generator secara diam diam tetapi menghasilkan SDK yang salah: method `trace` dilewati generator, parameter `cookie` dikirim sebagai query, body JSON tanpa `$ref` hilang dari fungsi SDK, dan response sukses tanpa `$ref` bertipe `unknown`.
- Scheme `oauth2` dan `openIdConnect` diterima hanya dari namanya tanpa memeriksa isinya.
- CLI membaca file tanpa batas ukuran, dan exporter yang gagal mencetak stack.
- Fixture `tests/fixtures/openapi/valid.json` masih memakai bentuk ekspor lama (schema response inline dengan `$id`), berbeda dari `openapi.json` saat ini yang memakai `$ref`.

Kekuatan yang membatasi: aturan proyek meminta checker Bun tanpa validator tambahan, penolakan reference eksternal, kegagalan pipeline yang nonzero, dan pernyataan batas checker. Fitur 9 (SDK) dan fitur 10 (alur readiness, spec 0006) akan bergantung pada checker ini; fitur 10 menambah route dengan response 200, 400, 429, dan 503 serta integer nonnegatif. Bila keputusan ini tidak diambil, route fitur 10 dapat lolos checker tetapi menghasilkan SDK yang tidak bertipe, dan adapter frontend terdorong menulis DTO manual yang dilarang aturan.

## Options considered

### Perbaiki checker Bun yang sudah ada

Perluas `scripts/validate-openapi.ts` menjadi allow list yang mengikuti exporter dan generator, pertahankan nama command dan pipeline, lalu tambahkan fixture serta bukti konsumsi SDK.

**Pros**:
- Mempertahankan perilaku fitur 4 dan script root yang sudah dipakai.
- Memakai runtime Bun tanpa dependency atau akses jaringan baru.
- Dapat memeriksa hal yang tidak dikenal validator umum: operasi wajib proyek, nama yang aman bagi generator, dan bentuk yang benar benar dibaca SDK.

**Cons**:
- Tim merawat sendiri subset dan test regresinya.
- Setiap bentuk API baru memerlukan pembaruan checker dan bukti generator.

### Tambahkan validator standar di samping checker Bun

Jalankan validator OpenAPI eksternal bersama pemeriksaan proyek.

**Pros**:
- Menemukan lebih banyak kesalahan terhadap standar OpenAPI.
- Mengurangi jumlah aturan struktur yang ditulis sendiri.

**Cons**:
- Menambah dependency, versi, dan sumber kegagalan CI.
- Validator standar menerima bentuk yang tetap rusak di generator, sehingga pemeriksaan proyek tetap diperlukan.
- Bertentangan dengan aturan proyek yang meminta checker Bun tanpa dependency validator tambahan.

### Ganti checker Bun dengan validator umum

Ganti `api:validate` dengan validator umum, lalu tambahkan kembali aturan proyek di atasnya.

**Pros**:
- Satu implementasi eksternal memberi pemeriksaan dasar yang luas.
- Struktur dasar tidak perlu ditulis sendiri.

**Cons**:
- Berisiko mengubah perilaku `api:sync` dan format kegagalan yang sudah dipakai.
- Aturan operasi wajib, kompatibilitas generator, determinisme, dan output aman tetap harus ditulis sendiri.
- Melanggar aturan proyek yang sama dengan opsi kedua.

## Rationale

Memperbaiki checker yang ada menutup celah yang ditemukan tanpa mengubah antarmuka command atau sumber kontrak. Celah terbesar bukan kesalahan terhadap standar OpenAPI, tetapi bentuk yang sah menurut standar namun rusak di generator terpasang. Validator umum tidak melihat masalah itu, sehingga hanya checker proyek yang dapat menjaganya.

Subset ditentukan dari dua sumber yang dapat diperiksa di repo: keluaran nyata `@elysia/openapi` 1.4.16 dengan Elysia 1.4.30, dan kode generator `@ojiepermana/angular` 22.1.14. Allow list dipilih karena bentuk di luar daftar adalah wilayah yang belum terbukti; menolak dengan rule ID lebih murah daripada menemukan SDK bertipe `unknown` saat fitur 10 dibangun. Kontrak saat ini berukuran 1.822 byte dan paling dalam dua tingkat, jadi batas 8 MiB dan 32 tingkat memberi ruang sangat lebar sambil mengubah input ekstrem menjadi kegagalan terkontrol.

Urutan code unit dipilih karena file ekspor adalah artefak build yang dibandingkan byte demi byte. Teks ditulis langsung dari array key terurut karena object JavaScript selalu menaruh key bilangan bulat lebih dulu, sehingga membangun ulang object lalu memanggil `JSON.stringify` tidak dapat menghasilkan urutan code unit. Urutan array dipertahankan karena dapat bermakna, misalnya `required` atau `enum`. Rule ID ditambahkan pada baris kedua stderr karena pesan generik saja memaksa pengembang menebak aturan yang dilanggar, sedangkan ID dari tabel tetap tidak membawa isi dokumen. Rule diperiksa menurut urutan tabel agar satu dokumen yang melanggar beberapa rule selalu menghasilkan ID yang sama pada build mana pun.

## Keputusan agent atas delegasi pemilik

Pemilik proyek mendelegasikan keputusan desain fitur ini ("jika membutuhkan /architect anda bisa menjalankannya dengan mengambil keputusan sendiri berdasarkan rekomendasi anda"). Keputusan berikut diambil oleh agent pada 2026-10-03 atas delegasi tersebut, tanpa konfirmasi manusia selama run, dan mengubah draft sebelumnya. Butir 8, 12, dan 13 diperbarui sesudah cross check; keputusan lain dari cross check tercatat di bagian *Cross check*:

1. **Versi hanya `3.1.0`** (draft: `3.0.3`, `3.1.0`, dan `3.2.0`). Exporter dipin ke `3.1.0` di `apps/backend/src/app.ts`; laporan fitur 4 mencatat pin itu sengaja menggantikan default plugin `3.1.2`. Versi lain tidak mempunyai producer di repo dan menambah aturan per versi (`nullable` di 3.0, `const` di 3.1). Pilihan kedua: mempertahankan `3.0.3` dan `3.1.0` seperti kode lama; ditolak karena `3.0.3` tidak dipakai dan tidak diuji.
2. **Tanpa nullable, `anyOf`, `oneOf`, `allOf`, dan `not`** (draft: nullable per versi dan `allOf` terbatas). Elysia mengekspor `t.Nullable` sebagai `nullable: true` sekaligus `type: ["string", "null"]`, bentuk campuran yang akan ditolak aturan draft. `t.Integer` dan `t.Numeric` diekspor sebagai `anyOf` yang dibaca generator sebagai `unknown`. Belum ada fitur yang membutuhkan bentuk ini; fitur yang membutuhkannya memperluas aturan bersama bukti SDK. Pilihan kedua: menerima pola `anyOf` integer Elysia; ditolak karena SDK tetap bertipe `unknown`.
3. **Tanpa schema rekursif** (draft: menerima rekursi lewat schema konkret). Semua siklus reference ditolak karena belum ada kontrak pohon, dan menerimanya menuntut bukti generate serta build tambahan. Pilihan kedua: menerima rekursi seperti draft; ditunda sampai ada kebutuhan.
4. **`$ref` hanya ke `#/components/schemas/<Nama>` di posisi schema** (draft: empat section komponen dan escape `~0`, `~1`). Elysia hanya mengeluarkan reference schema, dan generator mengambil nama dari potongan string tanpa unescape. Nama komponen dibatasi PascalCase alfanumerik sehingga escape tidak diperlukan.
5. **Pola nama untuk `operationId`, tag, dan komponen** (draft: "unik setelah dinormalisasi SDK" tanpa sumber normalisasi). Pola diturunkan dari `kebabCase`, `camelCase`, dan `pascalCase` generator. Dengan huruf besar yang selalu diikuti huruf kecil atau angka, dua nama berbeda tidak dapat menjadi file atau simbol yang sama, misalnya `ApiError` dan `APIError` yang sama sama menjadi `api-error`.
6. **Tepat satu tag per operasi** (draft: sedikitnya satu). Generator hanya memakai tag pertama; tag lain tidak berpengaruh dan menyesatkan.
7. **Body JSON dan response 2xx selain 204 wajib `$ref`**. Generator menghapus body yang tidak memakai `$ref` dari fungsi SDK dan mengetik response tanpa `$ref` sebagai `unknown`.
8. **Parameter hanya `path`, `query`, dan `header` dengan schema skalar, dideklarasikan pada operasi**. Generator mengirim parameter `cookie` sebagai query. Draft ini semula menerima array skalar dan parameter tingkat path item; cross check melaporkan, dengan probe pemeriksa, bahwa array header dan path gagal end to end dan aturan testing meminta bukti serialisasi runtime untuk array, sedangkan Elysia tidak pernah mengekspor parameter tingkat path item. Keduanya kini ditolak. Nama parameter unik tanpa membedakan huruf dan nama `body` ditolak karena generator menggabungkan semua parameter dan body dalam satu antarmuka `<Operasi>$Params`.
9. **`additionalProperties` hanya boolean; `enum` dan `const` tidak untuk boolean**. Generator mengabaikan `additionalProperties` berbentuk schema dan membuang nilai enum boolean, sehingga model yang dihasilkan salah.
10. **Security scheme hanya `http` dan `apiKey`** (draft: juga `oauth2` dan `openIdConnect` dengan aturan flow). Belum ada fitur autentikasi; default sesi cookie pada aturan keamanan dapat dinyatakan sebagai `apiKey` di cookie. Aturan flow `oauth2` ditunda sampai fitur 15 memilih model.
11. **Allow list key di setiap level, termasuk penolakan `servers`**. `servers` membawa URL environment yang dilarang masuk artefak; key lain belum terbukti di generator.
12. **Batas input 8 MiB, file biasa, kedalaman schema 32, dan waktu linear**. Batas 8 MiB dipertahankan dari draft dan juga berlaku pada teks hasil ekspor sebelum ditulis; file non reguler ditolak agar `/dev/zero` atau FIFO tidak dibaca tanpa akhir; batas kedalaman diperiksa saat turun sehingga nesting ekstrem gagal sebagai aturan, bukan stack overflow; deteksi siklus tiga warna dengan stack eksplisit mencegah penelusuran eksponensial pada kisi reference.
13. **Baris kedua `rule: <ID>` pada kegagalan kontrak** (draft: hanya pesan generik). Baris pertama tetap sama sehingga test APP-003 untuk JSON rusak tidak berubah. Kontrak stderr berlaku untuk proses script, karena pembungkus `bun run` mencetak baris sendiri yang memuat argumen.
14. **Fitur 8 tidak mengubah `scripts/check-api.ts`** (draft: skenario `api:check` dua kali dengan inventory SDK). Drift, manifest, dan dua run SDK identik adalah kriteria selesai fitur 9 di scope.
15. **Tabel operasi wajib sebagai data di checker**, diperluas oleh spec fitur pemilik route. Fitur 10 menambah `/api/readiness` melalui spec 0006.

## Cross check

Dua pemeriksa silang independen (model berbeda) meninjau draft ini pada 2026-10-03 dan melaporkan 36 temuan, sebagian merupakan temuan yang sama dari kedua pemeriksa. Agent memutuskan setiap temuan atas delegasi pemilik pada 2026-10-03, tanpa konfirmasi manusia selama run, dan menjalankan probe sendiri untuk temuan yang menyangkut perilaku Bun, Elysia, atau generator.

Diterima dan diterapkan di `index.md`:
- `canonicalJson` menjadi serializer rekursif dari array key terurut, dan urutan uji literal ditulis di AC-2 (blocker).
- Urutan evaluasi rule menurut tabel, pembagian `$ref` dan `$id`, serta mutasi `required-operation` yang hanya melanggar rule itu. Baris `tag` dipindah sesudah `operation-id` agar rule atas tidak bergantung pada struktur yang belum diperiksa.
- Kontrak stderr berlaku untuk proses script; `bun run` hanya diasersi exit code dan efeknya.
- Nama parameter unik tanpa membedakan huruf, nama `body` ditolak, serta parameter array dan parameter tingkat path item ditolak.
- Pemeriksaan linear dengan bukti kisi 40 tingkat, rantai 20.000 komponen, dan rantai `items` 200.000 tingkat.
- Nilai requirement `http` dan `apiKey` tepat `[]`, dan `security` dokumen selalu diperiksa.
- Tepat satu response 2xx per operasi, yang juga menolak operasi tanpa response 2xx; response `default` ditolak.
- Nama export checker, bentuk entri `REQUIRED_OPERATIONS`, dan cara test membaca tabel aturan.
- Definisi workspace terisolasi, preload guard, nilai sentinel, flag `tsc`, dan timeout.
- Lokasi bukti `docs/testing/0007-openapi-contract.md` dan `docs/testing/evidence/0007/`, serta JUnit khusus OPENAPI.
- Resep 204 lewat `detail.responses` beserta test route in-process.
- Batas `t.Ref` nama telanjang dicatat di Consequences dan Follow-up; model sementara bersifat datar.
- Kewajiban fitur 10 ditulis di Follow-up dan masuk `docs/rules/openapi-sdk.md` lewat build plan langkah 5.
- Klaim keterbacaan generator dipersempit ke daftar AC-7, dan daftar itu diperinci.
- Guard diperluas ke `Bun.udpSocket`, `Bun.sql`, `WebSocket`, `node:net`, dan `node:tls`, ditambah listener sentinel pada `DATABASE_URL`.
- `default` dan `example` hanya skalar dan `examples` hanya array skalar, tanpa penelusuran; ditambah asersi dokumen tidak berubah serta kasus `__proto__` dan `constructor`.
- Kalimat AC yang tidak teramati diganti asersi teramati (padding 8 MiB, file sparse, sentinel, tanpa `servers`); klausa desain dipindah ke invariant.
- Definisi string tidak kosong (`trim`), karakter path, argumen CLI, batas ukuran teks ekspor, dan penulisan atomik lewat file sementara.
- Exporter memuat komposisi lewat `await import()`, dengan kasus import modul route dan `createApp()` yang melempar penanda rahasia.
- Fakta body form Elysia dicatat untuk CSRF fitur 15.
- Request `GET /api/status` tanpa credential memberi 200.

Ditolak atau diterapkan dalam bentuk lain:
- ID per klausa pada tabel aturan dengan asersi otomatis per klausa: ditolak karena ID klausa membuat tabel rapuh; matriks wajib memuat sedikitnya satu baris per klausa, review memeriksa kelengkapannya, dan test otomatis memeriksa per rule ID.
- Uji waktu untuk dokumen maksimal 8 MiB: diganti kisi, rantai komponen, dan rantai `items` yang menyasar kasus terburuk nyata, karena dokumen besar generik tidak menambah cakupan.
- Guard untuk lookup DNS: ditolak karena `Bun.dns` readonly menurut probe dan lookup tanpa koneksi tidak membuka listener, database, atau request; `fetch`, `connect`, dan listener sentinel menjaga koneksi nyata.
- Unit test helper baca terbatas dengan reader suntikan: ditolak karena padding 8.388.609 byte, file sparse, `/dev/zero`, dan FIFO sudah membuktikan batas di level CLI.
- Mengedit spec 0006 dalam run ini: ditunda karena run ini hanya mengubah spec 0008 dan bagian scope fitur 8; kewajiban fitur 10 ada di Follow-up dan `docs/rules/openapi-sdk.md`, dan spec 0006 merujuknya saat fitur 10 dikerjakan.
- Parameter array dibatasi ke query dengan skenario runtime: diganti penolakan semua parameter array sampai ada fitur yang membutuhkannya, sesuai aturan testing tentang bukti serialisasi.
- Memindahkan 204 ke bentuk yang belum didukung: tidak dipilih karena resep `detail.responses` terbukti diekspor bersih dan diuji in-process.
- Exporter menulis ulang `$ref` nama telanjang sekarang: ditunda karena belum ada fitur yang membutuhkan daftar model atau model bersarang.
- Mewajibkan body hanya `application/json`: ditolak karena Elysia selalu mengekspor media type form untuk body object, sehingga setiap route dengan body akan ditolak.
- Perbandingan nama header tanpa membedakan huruf dengan override operasi atas path item: disederhanakan karena parameter tingkat path item ditolak dan semua nama parameter dibandingkan tanpa membedakan huruf.

## Bukti pemeriksaan

Pemeriksaan berikut dijalankan agent pada 2026-10-03 di checkout ini, hanya membaca kode atau menjalankan probe sementara tanpa menulis file repo:

- **Generator** (`node_modules/@ojiepermana/angular/sdk/src/`, versi 22.1.14): `parser/ir.js` memakai `HTTP_METHODS` tujuh method tanpa `trace`; operasi memakai `tags[0]`; parameter dengan lokasi selain `path`, `query`, dan `header` dipetakan ke `query`; `jsonSchemaRef` hanya membaca `content['application/json'].schema.$ref` dari `components.schemas`; `literalArray` hanya menyimpan nilai string dan angka; `buildSchema` mengabaikan `additionalProperties` dan menggabungkan `allOf`. `emit/operations.js` hanya menambah `rb.body` dan tipe hasil bila ada `$ref`. `render/template.js` mendefinisikan `kebabCase`, `camelCase`, dan `pascalCase` yang dipakai untuk nama file, fungsi, service, dan model. README generator menyatakan dukungan OpenAPI 3.x termasuk 3.2.0, tetapi spec ini hanya memakai 3.1.0.
- **Exporter Elysia** (probe `app.handle()` sementara dengan Elysia 1.4.30 dan `@elysia/openapi` 1.4.16): `t.Integer` dan `t.Numeric` menjadi `anyOf` berisi string berformat angka dan tipe angka; `Type.Integer` dari `@sinclair/typebox` dan `t.Number` menjadi `type` tunggal dengan `minimum`; `t.Nullable(t.String())` menjadi `nullable: true` sekaligus `type: ["string", "null"]`; `t.Union` dari literal string menjadi `type: "string"` dengan `enum`; `t.Literal` menjadi `const` dengan `type`; body `t.Object` dideklarasikan pada `application/json`, `application/x-www-form-urlencoded`, dan `multipart/form-data`; `t.Void()` untuk 204 menjadi `content: { "type": "void" }`; model bernama menjadi `$ref` ke `components.schemas`; query `t.Object({})` tidak menghasilkan parameter; route tanpa `operationId` mendapat nama otomatis seperti `getApiX`, sedangkan `operationId` yang dideklarasikan diteruskan apa adanya, termasuk `get-y`.
- **Urutan key**: pada key `_x`, `$ref`, `10`, `9`, `a`, `A`, `ä`, `b`, `B`, `Z`, `localeCompare` dan perbandingan code unit memberi urutan berbeda. Untuk `openapi.json` saat ini keduanya menghasilkan byte yang sama dengan file tersimpan.
- **Nesting**: `JSON.parse` Bun menerima dokumen bersarang 200.000 tingkat dalam 7,4 MB, lalu penelusuran rekursif melempar `RangeError` yang dapat ditangkap. Batas 32 tingkat yang diperiksa saat turun menjadikan kasus ini pelanggaran rule `schema` yang jelas. Karena `default`, `example`, dan `examples` hanya skalar dan setiap posisi lain diatur allow list, tidak ada posisi dokumen yang dapat bersarang tanpa batas.
- **Pola nama**: semua string sampai tujuh karakter dari huruf `a`, `b`, `A`, `B`, angka `1`, dan tanda hubung yang cocok dengan pola `operationId`, tag, dan komponen diuji terhadap `kebabCase`, `camelCase`, dan `pascalCase` generator. Tidak ada dua nama berbeda yang menghasilkan nilai sama. Versi awal pola komponen yang mengizinkan huruf besar berurutan (`AA1` dan `Aa1` sama sama menjadi `aa1`) ditemukan lewat pemeriksaan ini lalu diperketat. Nama saat ini dan yang direncanakan (`getDevelopmentStatus`, `development`, `DevelopmentStatus`, `ReadinessAvailable`) cocok dengan pola.
- **Guard resource**: di Bun 1.4.2, preload yang menugaskan fungsi baru ke `Bun.serve`, `Bun.listen`, `Bun.connect`, `Bun.udpSocket`, `Bun.SQL`, dan `Bun.sql` ikut memblokir import bernama dari `bun` (`serve`, `sql`, `SQL`); `Object.defineProperty` gagal karena property itu tidak configurable. `connect` dari `node:net` dapat diganti untuk import bernama dan namespace, dan `listen` dari `node:http` melewati `Bun.serve`. `Bun.dns` readonly. Tanpa guard, `Bun.sql` benar benar mencoba terhubung ke `DATABASE_URL`, sehingga listener sentinel memberi bukti tambahan yang tidak bergantung pada cara API dipanggil.
- **Ukuran**: `openapi.json` saat ini 1.822 byte.
- **Serializer kanonik**: serializer rekursif dari `Object.keys(value).sort()` mereproduksi `openapi.json` 1.822 byte secara byte identik dan memberi urutan `$ref`, `10`, `9`, `A`, `__proto__`, `_x`, `a` untuk key campuran, sedangkan `Object.fromEntries` dari entri terurut lalu `JSON.stringify` memberi `9`, `10`, `$ref`, `A`, `__proto__`, `_x`, `a`. Array dan object kosong ditulis sama dengan `JSON.stringify(value, null, 2)`.
- **Pembungkus `bun run`**: `bun run api:validate <path>` mencetak `$ bun scripts/validate-openapi.ts <path>` sebelum output script dan `error: script "api:validate" exited with code 1` sesudahnya; `bun run --silent` hanya menyisakan `OpenAPI validation failed`.
- **Keluaran Elysia tambahan**: route uji `delete` yang ditambahkan ke `createApp('development')` dengan `detail.responses` berisi `{ 204: { description } }` diekspor sebagai response yang hanya memuat `description` dan menjawab 204 tanpa body. `t.Array(t.Ref('Item'))` diekspor sebagai `items: { "$ref": "Item" }`. Body model diekspor pada tiga media type walau route memakai `type: 'json'`, dan body `application/x-www-form-urlencoded` ke route itu mendapat 200. Parameter selalu diekspor per operasi, tidak pernah di tingkat path item, dan route tanpa schema response diekspor tanpa `responses`.
- **Generator, parameter dan response**: `mergeParams` di `parser/ir.js` mengunci parameter dengan `in:name`, lalu `renderParamsInterface` di `emit/operations.js` menulis semua parameter dan `body` sebagai anggota satu antarmuka, sehingga nama sama di lokasi berbeda atau parameter `body` menghasilkan anggota ganda. `buildOperation` hanya memakai status 2xx pertama menurut urutan key.
- **Ketergantungan lain**: tidak ada test, rule, atau spec yang memakai `3.0.3`, `3.2.0`, `trace`, `oauth2`, `openIdConnect`, `allOf`, atau `anyOf`, sehingga penyempitan ini tidak mematahkan skenario yang ada. Helper mutasi APP-003 perlu disesuaikan karena `valid.json` diperbarui ke bentuk `$ref`.

## Keputusan sesudah review kode

Review kode independen pada 2026-10-03 (model berbeda) melaporkan satu temuan major dan sebelas temuan minor. Keputusan berikut diambil oleh agent pada 2026-10-03 atas delegasi pemilik, tanpa konfirmasi manusia selama run. Setiap temuan dibuktikan dulu dengan reproduksi atau pembacaan kode, dan setiap perbaikan mempunyai test regresi yang gagal tanpa perbaikan itu.

1. **Exporter menunggu satu giliran timer lalu menulis secara sinkron**. Reproduksi: rejection dari modul route dilaporkan saat `Bun.write` file sementara menunggu I/O, sehingga handler proses keluar di tengah penulisan. Tanpa beban, 10 dari 10 ekspor gagal tetap mengganti `openapi.json` (inode berganti); dengan 20 proses `yes`, 22 dari 30 mengganti file dan 8 meninggalkan file sementara. Probe urutan event loop Bun 1.4.2 menunjukkan `setTimeout(resolve, 0)` melaporkan rejection, exception immediate, dan timer tanpa jeda lebih dulu, sedangkan `setImmediate` dan `Bun.sleep(0)` tidak mendahului timer tanpa jeda. Penulisan memakai `writeFileSync` dan `renameSync` agar handler tidak dapat berjalan di antara operasi file. Pilihan kedua, flag kegagalan yang diperiksa sebelum rename asinkron dengan penghapusan sinkron di handler, ditolak karena rename yang sudah berjalan di thread lain tetap dapat selesai sesudah handler keluar. Sesudah perbaikan, 60 run di bawah beban yang sama tidak mengganti file dan tidak meninggalkan file sementara. Pola `openapi.json.*.tmp` ditambahkan ke `.gitignore` untuk proses yang dibunuh sinyal di tengah penulisan.
2. **Setiap operasi wajib mendeklarasikan `security` sendiri** (sebelumnya security dokumen diwarisi). `apps/backend/src/app.ts` menetapkan `security: []` di dokumen, sehingga route terlindungi yang lupa `detail.security` terekspor sebagai publik dan lolos checker. Aturan keamanan meminta backend menolak akses secara default, dan resep route spec ini sudah meminta `security` pada `detail` setiap route; checker kini menegakkannya, berbeda dengan `operationId` yang tidak dapat dibedakan dari nama otomatis. Pilihan kedua, mengganti default dokumen menjadi requirement yang menolak, ditolak karena belum ada scheme autentikasi yang dapat dirujuk. Pilihan ketiga, mencatatnya sebagai fail open yang diketahui, ditolak karena kemudahan perbaikan dan semua fixture serta ekspor saat ini sudah mendeklarasikan `security` per operasi.
3. **Segmen titik `.` dan `..` ditolak rule `path`**. Browser dan `HttpClient` menyelesaikan segmen titik, sehingga path yang diperiksa dan diberi security bukan path yang dicapai.
4. **Byte order mark UTF-8 ditolak**. `TextDecoder` membuang BOM secara default sehingga validator lulus, sedangkan `sdk:generate` gagal membaca file yang sama. Decoder kini memakai `ignoreBOM: true`.
5. **`api:openapi` dan `api:validate` memakai `bun --no-env-file`**. Probe membuktikan `bun scripts/...` memuat `.env` checkout ke proses yang memuat seluruh komposisi backend, sedangkan `bun run` tidak meneruskan `.env` ke proses script; `api:sync` tidak perlu diubah.
6. **Guard preload diperluas** ke `Bun.redis`, `Bun.RedisClient`, `Bun.s3`, `Bun.S3Client`, dan `connect` pada `net.Socket.prototype`, dan listener sentinel juga dipasang pada `REDIS_URL` serta `SMTP_HOST`. `Bun.fetch` tidak dapat diganti karena readonly dan tidak configurable di Bun 1.4.2; jalur yang tidak dijaga ditulis di invariant 1.
7. **`typecheck:contract` dengan `tsconfig.contract.json` masuk `test:ci`**, terbatas pada exporter, checker, `canonicalJson`, dan `tests/integration/contract/`. Pemeriksaan seluruh `scripts/` dan `tests/` ditolak di fitur ini karena file milik fitur lain (misalnya `scripts/serve.ts` dan `tests/integration/tooling/development.test.ts`) belum lulus `strict` dengan `noUncheckedIndexedAccess`; perluasan itu milik gate CI fitur 11.
8. **Test diperkuat tanpa mengubah perilaku lain**: pengukuran kisi dan rantai komponen berjalan di subprocess yang dibunuh setelah 10 detik, `run()` membunuh script setelah 30 detik, batas ekspor diuji tepat di 8.388.608 dan 8.388.609 byte serta dengan teks multibyte, ekspor yang berhasil harus mengganti inode, ekspor yang gagal tidak boleh mengganti inode, dan cabang baca sesudah `stat` diuji dengan preload yang membuat `stat` melaporkan file biasa kecil. Pemeriksaan `handle.stat()` sesudah open tetap dijalankan test, tetapi penghapusannya tertutup batas baca dan parser sehingga tidak dapat dibedakan dari output.
