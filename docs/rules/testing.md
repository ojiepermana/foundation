# Aturan testing dan kesiapan production release

Setiap pekerjaan menilai dampak perubahan, menentukan skenario yang perlu dibuktikan, menjalankan pemeriksaan yang relevan, dan melaporkan bukti serta keterbatasannya. Aturan ini berlaku untuk agent utama dan subagent bersama [workflow development](development-workflow.md).

Tidak setiap perubahan memerlukan semua jenis test. Perubahan dokumentasi atau perubahan kecil tanpa dampak perilaku cukup diverifikasi sesuai dampaknya, dengan alasan yang jelas. Jangan membuat test yang hanya menyalin implementasi atau menguji detail internal tanpa manfaat.

## Jenis test dan runner

| Jenis | Runner | Bukti yang dicari |
| --- | --- | --- |
| Unit frontend | Vitest melalui Angular CLI. | Perilaku komponen, validasi, state, dan service secara terisolasi. |
| Integration frontend | Vitest melalui Angular CLI. | Interaksi komponen, service, routing, dan komposisi UI. |
| Unit backend, worker, dan kode server bersama | `bun:test`. | Aturan bisnis dan fungsi tanpa database atau layanan eksternal nyata. |
| Integration backend, worker, dan database | `bun:test` dengan PostgreSQL 18 sebagai baseline. | Route, service, query, constraint, transaksi, migration, dan pemrosesan job bekerja bersama. |
| E2E | Playwright Test. | Alur pengguna melalui frontend, backend, database, dan worker yang relevan. |
| Performance dan ketahanan | k6. | Hasil bisnis, latency, kapasitas, kestabilan, serta pemulihan pada pola beban yang ditentukan. |

Seluruh dependency dan script tetap dikelola melalui `package.json` root. Angular memakai integrasi test Angular CLI sesuai versi project. Backend dan worker memakai runner native Bun. Playwright dan k6 menggunakan runner masing-masing; jangan mengimpor modul khusus runtime Bun ke script yang dijalankan runner lain.

## Struktur test

```text
foundation/
├── package.json
├── playwright.config.ts
├── apps/
│   ├── frontend/src/app/features/<fitur>/
│   │   ├── <komponen>.spec.ts
│   │   └── <komponen>.integration.spec.ts
│   ├── backend/src/features/<fitur>/
│   │   └── <service>.test.ts
│   └── worker/<worker>/src/
│       └── <handler>.test.ts
├── tests/
│   ├── scenarios/
│   │   └── <fitur>.json
│   ├── fixtures/
│   ├── integration/
│   │   ├── backend/
│   │   ├── worker/
│   │   └── database/
│   ├── e2e/
│   │   ├── fixtures.ts
│   │   └── <fitur>/
│   │       └── <alur>.e2e.spec.ts
│   ├── orchestration/
│   │   └── <suite>-real.ts
│   └── performance/
│       ├── journeys/
│       ├── profiles/
│       │   ├── smoke.ts
│       │   ├── load.ts
│       │   ├── stress.ts
│       │   ├── spike.ts
│       │   └── soak.ts
│       ├── browser/
│       └── helpers/
└── docs/testing/
    └── release-report-template.md
```

Struktur menunjukkan lokasi ketika file diperlukan, bukan kewajiban membuat seluruh file contoh. Unit test library bersama berada dekat kode library tersebut dan menggunakan runner yang sesuai.

Unit test berada dekat kode yang diuji. Integration komponen Angular juga berada dekat fitur. Integration server serta E2E dan performance lintas aplikasi berada di `tests/` root.

Setiap runner mempunyai cakupan file eksplisit. Jangan menjalankan `bun test` tanpa filter dari root sehingga file Angular dan Playwright ikut ditemukan. Konfigurasi Playwright hanya menemukan suite E2E; konfigurasi Angular hanya menemukan suite frontend.

`tests/fixtures/` berisi data atau factory yang tidak bergantung pada runner. Setup khusus Bun, Angular, Playwright, atau k6 tetap berada di area masing-masing.

Orkestrasi test yang memanggil Docker, misalnya untuk menyalakan, menghentikan, atau menghapus PostgreSQL terisolasi, berada di `tests/`, tidak pernah di `scripts/`. Folder `scripts/` hanya berisi tooling development, build, dan pemeriksaan repository, dan INFRA-001 spec 0002 gagal bila ada file `.ts` di bawahnya yang memuat kata `docker`. Orkestrasi Bun yang dijalankan root script, seperti `test:database:real` dan `test:readiness:real`, berada di `tests/orchestration/` bersama modul penjaga container `readiness-container.ts`; smoke `test:tooling:real` berada di `tests/integration/tooling-real/`. Orkestrasi di `tests/` boleh mengimpor modul `scripts/lib/` yang tidak memanggil Docker, seperti `process-group.ts` dan `ports.ts`. File di `tests/orchestration/` tidak memakai akhiran `.test.ts` atau `.e2e.spec.ts`, sehingga tidak ditemukan `bun test` maupun Playwright.

## Pemetaan skenario

Specs fitur menjadi sumber kriteria penerimaan dan target performance. Beri setiap skenario ID stabil, seperti `AUTH-001`, dan hubungkan ke kriteria yang dibuktikan.

Registry `tests/scenarios/<fitur>.json` memetakan ID skenario ke rujukan specs, kriteria penerimaan, file dan nama atau tag test, runner, serta profil yang wajib dijalankan. Registry tidak menyalin seluruh requirements dan tidak menyimpan hasil lulus secara manual.

Untuk tooling repository yang kriterianya ditetapkan langsung dalam rules, registry boleh merujuk kriteria pada rule tersebut sebagai sumber. Tooling doctor/serve memakai `tests/integration/tooling/` dan root script `test:tooling`; test cleanup menggunakan proses fixture pada port sementara, bukan menghentikan layanan aplikasi nyata.

Untuk setiap skenario, tentukan prasyarat, data awal, tindakan, hasil yang diharapkan, pemeriksaan, dan kondisi lulus. Performance juga menentukan model beban, durasi, campuran aktivitas, environment, serta thresholds.

Pilih jenis test yang mampu membuktikan skenario; tidak semua skenario harus dijalankan oleh semua runner. Cakup alur utama, kegagalan penting, otorisasi, concurrency, retry, dan perubahan data yang relevan dengan fitur.

Validasi registry dalam CI: ID unik, rujukan specs dan test valid, serta seluruh skenario wajib mempunyai implementasi test. Rujukan file saja belum membuktikan bahwa test tersebut dijalankan atau mempunyai assertion yang sesuai.

Laporan menghubungkan hasil runner dengan ID skenario dan membedakan:

- `passed`: pemeriksaan wajib dijalankan dan memenuhi kriteria.
- `failed`: pemeriksaan berjalan tetapi hasil tidak memenuhi kriteria.
- `skipped`: test tersedia tetapi tidak dijalankan, dengan alasan.
- `not_run`: belum ada eksekusi atau bukti yang sesuai.
- `missing_test`: skenario belum mempunyai implementasi test.
- `not_applicable`: tidak berlaku untuk perubahan atau release ini, dengan alasan dan rujukan cakupan.

Coverage skenario berbeda dari coverage kode. Persentase coverage kode tidak menggantikan bukti kriteria penerimaan. Test yang dilewati atau belum dijalankan tidak boleh dilaporkan sebagai lulus.

## Unit dan integration

Unit test memeriksa perilaku, bukan sekadar pemanggilan fungsi mock. Mock digunakan pada batas dependensi agar logika dapat diuji secara terisolasi.

Integration memakai implementasi nyata untuk bagian yang sedang dibuktikan. Test query atau transaksi menggunakan PostgreSQL nyata, bukan database pengganti atau mock SQL. Gunakan PostgreSQL 18 sebagai baseline dan ikuti [aturan database](database.md).

Siapkan database test melalui runner migration di `database/`, terpisah dari startup aplikasi. Data test disiapkan secara eksplisit dan diisolasi antar test atau proses paralel. Jangan memakai database atau kredensial production untuk eksekusi test rutin.

Gunakan unit test untuk aturan bisnis, integration untuk constraint dan transaksi, serta pemeriksaan migration untuk perubahan skema yang relevan. Pengujian migration berasal dari `tests/integration/database/` dan menjalankan runner atau file di `database/`.

## E2E dengan Playwright

Uji perilaku pengguna menggunakan frontend dan backend nyata, dengan database dan worker nyata ketika termasuk dalam alur yang dibuktikan. Mock hanya batas yang dinyatakan, seperti layanan eksternal yang tidak dikendalikan project; catat batas tersebut dalam bukti.

Gunakan locator berdasarkan role, label, teks, atau test ID yang disepakati. Hindari ketergantungan pada DOM internal `@ojiepermana/angular` dan jeda waktu tetap. Gunakan assertion yang menunggu kondisi serta timeout yang terbatas.

Test frontend membuktikan integrasi dan penggunaan komponen library dalam fitur, bukan mengulang pengujian seluruh implementasi internal library. Cakup state UI, keyboard, dan ukuran layar yang relevan sesuai [aturan UI/UX](ui-ux.md).

Playwright dapat menyalakan frontend dan backend melalui `webServer`. Infrastruktur database, migration, data awal, dan kesiapan worker ditangani orchestration test. Setup yang membutuhkan Bun dijalankan sebagai proses Bun terpisah; fixture Playwright dapat memakai API yang sesuai.

## Performance dengan k6

Alur bisnis berada di `journeys/`, pola beban berada di `profiles/`, dan helper k6 berada di `helpers/`. Gunakan alur yang sama untuk beberapa profil bila memungkinkan.

| Profil | Tujuan |
| --- | --- |
| Smoke | Memvalidasi script dan perilaku dasar pada beban ringan. |
| Load | Memenuhi target pada beban normal yang ditentukan. |
| Stress | Memeriksa perilaku di atas beban normal. |
| Spike | Memeriksa lonjakan mendadak dan pemulihan. |
| Soak | Memeriksa kestabilan dalam durasi panjang. |
| Breakpoint, jika diperlukan | Mencari batas kapasitas. |

Mulai dengan smoke sebelum pengujian beban lebih tinggi. Tentukan profil wajib berdasarkan dampak dan risiko perubahan. Stress, spike, soak, dan breakpoint tidak wajib dijalankan untuk setiap pekerjaan kecil.

Definisikan target pengguna virtual atau laju kedatangan, durasi, data, dan campuran aktivitas. Bedakan laju iterasi dari request per detik jika satu alur melakukan beberapa request. Catat beban aktual dan iterasi yang tidak berhasil dimulai agar target yang tidak tercapai tidak dianggap terbukti.

Tetapkan checks untuk respons dan hasil bisnis, serta thresholds per skenario untuk menentukan kelulusan CI. Check yang gagal sendiri tidak cukup untuk membuat run gagal. Penolakan yang diharapkan, seperti akses tanpa izin, dinilai sesuai skenarionya dan dibedakan dari kegagalan tak terduga.

Target latency, throughput, tingkat kegagalan, dan waktu penyelesaian job ditentukan dalam specs. Jangan mengarang target universal atau melonggarkan threshold hanya agar test lulus. Angka contoh dalam percakapan bukan target project yang telah disepakati.

Untuk pekerjaan asynchronous, buktikan status akhir, waktu penyelesaian, dan efek bisnisnya. Respons bahwa job diterima saja belum membuktikan keberhasilan worker. Periksa efek duplikat ketika retry relevan. Gunakan status job, metrik khusus, atau pemeriksaan hasil melalui proses Bun yang terpisah sesuai skenario.

Amati resource aplikasi, pool dan query database, serta backlog worker bersama hasil k6 untuk menjelaskan bottleneck. k6 browser digunakan ketika perlu mengukur pengalaman browser saat sistem menerima beban; Playwright tetap menguji alur pengguna.

k6 berjalan melalui binary atau container k6. Root script mengorkestrasinya, bukan menjalankannya melalui `bun:test`. Eksekusi beban dilakukan pada environment test yang ditetapkan dengan data terkontrol.

## Workflow pemeriksaan dan CI

Sinkronisasi kontrak mengikuti [aturan OpenAPI/SDK](openapi-sdk.md). Setiap perubahan backend wajib ekspor OpenAPI, validasi, dan generate SDK, meskipun perubahan internal menghasilkan file yang sama. Jalankan build Angular sesudah regenerasi dan uji pemakaian SDK yang terdampak terhadap backend nyata sesuai skenario.

Pengujian kontrak membuktikan bahwa path, parameter, body, status, response, dan autentikasi SDK sesuai perilaku backend untuk operasi yang digunakan. Tambahkan skenario serialisasi array/query, nullable, enum, tanggal, atau upload ketika kontrak menggunakannya. Generated types dan build yang berhasil tidak menggantikan bukti perilaku runtime.

CI menjalankan `api:check` sebelum pemeriksaan frontend yang bergantung pada SDK. Pemeriksaan memvalidasi OpenAPI, meregenerasi SDK, membuktikan hasil yang dapat diulang, dan mendeteksi perbedaan terhadap artefak kandidat, termasuk file baru atau dihapus. OpenAPI atau SDK yang tertinggal membuat pemeriksaan gagal. Suite independen dapat berjalan paralel setelah artefak yang diperlukan tersedia.

Validasi kontrak OpenAPI menggunakan script Bun sesuai [aturan OpenAPI/SDK](openapi-sdk.md), tanpa dependency validator tambahan. Saat checker diimplementasikan, buktikan fixture valid diterima dan pelanggaran aturan wajib ditolak. Hasil checker hanya membuktikan cakupan pemeriksaan project; kelulusan seluruh standar OpenAPI tidak boleh diasumsikan. Build Angular dan pengujian integrasi SDK terhadap backend nyata tetap wajib sesuai dampak perubahan.

Nama script root yang digunakan saat suite diimplementasikan:

| Script | Cakupan |
| --- | --- |
| `test:tooling` | Integration tooling doctor, cleanup port, seleksi worker, dan supervisor proses melalui Bun. |
| `api:sync` | Ekspor backend ke `openapi.json`, validasi, lalu generate SDK Angular secara berurutan. |
| `api:check` | Validasi, reproduksibilitas, dan kesesuaian OpenAPI/SDK dengan sumber kandidat. |
| `test:frontend` | Unit dan integration komponen Angular. |
| `test:unit:server` | Unit backend, worker, dan library server. |
| `test:integration` | Integration server dan database melalui Bun. |
| `test:e2e` | E2E melalui Playwright. |
| `test:e2e:ui` | Playwright dalam mode UI untuk debugging. |
| `test:readiness:real` | Alur browser nyata kesiapan (READY-009) melalui Playwright terhadap PostgreSQL 18 terisolasi di Docker serta backend dan frontend yang dijalankan orkestrasi Bun `tests/orchestration/readiness-real.ts`, beserta pemindaian credential pada output dan artefak; berjalan di luar `test:ci` sampai jalur CI dengan Docker tersedia. |
| `test:performance:smoke` | Smoke k6. |
| `test:performance:load` | Load k6. |
| `test:performance:stress` | Stress k6. |
| `test:performance:spike` | Spike k6. |
| `test:performance:soak` | Soak k6. |
| `test:ci` | Orchestration pemeriksaan yang diwajibkan pipeline. |

Setiap pekerjaan menjalankan pemeriksaan yang relevan dengan dampaknya. CI perubahan kode menjalankan build atau pemeriksaan tipe yang diperlukan, validasi registry, test area yang berubah, regression terkait, serta E2E alur kritis yang terdampak. Jalankan smoke k6 bila perubahan menyentuh perilaku atau performance yang diukur.

Suite independen dapat berjalan paralel dengan data terisolasi. Jalankan pengujian performance pada environment yang tidak terganggu suite lain agar hasil dapat dibandingkan. Pengujian berdurasi panjang menjadi pipeline tersendiri yang dijalankan sesuai rencana verifikasi, bukan otomatis dipicu untuk setiap edit.

Ketika skenario gagal, cari dan perbaiki penyebabnya sebelum menjalankan ulang pemeriksaan yang terdampak. Catat kegagalan awal dan retry; hasil yang lulus setelah retry tidak boleh menyembunyikan test yang tidak stabil.

## Bukti sebelum production release

Ikuti [aturan keamanan](security.md). Perubahan terkait data persisten membuktikan schema dan privilege sesuai specs, termasuk penolakan query oleh role yang tidak diberi akses. Perubahan autentikasi/otorisasi mencakup skenario negatif lintas pengguna atau role, lifecycle sesi, dan CSRF sesuai model. Input berbahaya, rate limit, upload, serta batas worker diuji ketika masuk cakupan. Catat kontrol yang diuji dan temuan yang belum terselesaikan pada laporan release.

Sebelum production release, jalankan seluruh skenario wajib untuk kandidat release, termasuk regression alur kritis, perubahan migration, dan profil performance yang ditetapkan. Gunakan build dan konfigurasi yang mewakili deployment production. Perbedaan environment harus dicatat, bukan dianggap setara tanpa bukti.

Gunakan [template laporan release](../testing/release-report-template.md) untuk menghasilkan `docs/testing/releases/<identitas-release>.md`. Laporan menghubungkan bukti runner dan artefak CI, tanpa menyimpan token, password, atau data sensitif.

Catat commit atau identitas build, waktu dan run CI, versi runtime serta database, jumlah container, batas resource, pool database, volume data, model beban, target dan hasil aktual, cakupan browser, serta batas mock yang digunakan jika relevan. Sertakan checksum atau identitas OpenAPI, versi generator, bukti regenerasi SDK dari kontrak kandidat, hasil `api:check`, build Angular, dan test kontrak yang relevan.

Seluruh skenario wajib harus memiliki bukti yang valid untuk kandidat release. Perubahan setelah pengujian memerlukan verifikasi ulang area yang terdampak; agent utama menentukan dan mencatat cakupan pengujian ulang berdasarkan dampaknya.

Status kesiapan adalah `ready` ketika bukti wajib lengkap dan memenuhi kriteria, `blocked` ketika skenario wajib gagal atau hasil menunjukkan masalah, dan `incomplete` ketika bukti wajib belum tersedia. Jangan menyatakan siap production dengan skenario wajib yang dilewati, belum dijalankan, atau belum memiliki test.

Jika ada keputusan untuk menerima pengecualian, catat skenario, alasan, dampak, penanggung jawab, dan keputusan pengguna atau pemilik release secara terpisah. Status test tetap mencerminkan hasil sebenarnya. Bukti kesiapan tidak dengan sendirinya memberi izin untuk deploy.

## Tanggung jawab agent

Agent utama menetapkan cakupan verifikasi, ID skenario, batas file test, dan penanggung jawab integrasi sebelum delegasi. Setiap subagent menyertakan test yang relevan untuk bagiannya serta laporan perintah, hasil, skenario yang dibuktikan, dan keterbatasan.

Agent utama menggabungkan hasil, memverifikasi alur lintas aplikasi, dan memastikan laporan tidak menganggap mock development sebagai bukti integrasi nyata. Perubahan registry, konfigurasi runner, fixture bersama, dan orchestration CI memiliki satu penanggung jawab yang ditetapkan.

## Referensi

- [Testing Angular](https://angular.dev/guide/testing).
- [Test runner Bun](https://bun.com/docs/test).
- [Praktik Playwright](https://playwright.dev/docs/best-practices).
- [Web server Playwright](https://playwright.dev/docs/test-webserver).
- [Scenarios k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/).
- [Checks k6](https://grafana.com/docs/k6/latest/using-k6/checks/).
- [Thresholds k6](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
- [Jenis load test k6](https://grafana.com/docs/k6/latest/testing-guides/test-types/).
- [k6 browser](https://grafana.com/docs/k6/latest/using-k6-browser/).
